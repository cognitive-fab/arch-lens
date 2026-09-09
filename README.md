# arch-lens

**Write the architecture analysis. The diagrams compile from it.**

A Claude Code plugin, and a small Node.js tool underneath it. You — or Claude —
write one structured analysis of a system. Arch-lens compiles it into a set of
validated, interactive HTML diagrams and a markdown document that cannot disagree
with them, and never asks anyone to type a coordinate.

It does not draw. Rendering is [archify](https://github.com/tt-a1i/archify)'s job,
and archify is very good at it: deterministic HTML, a validator that refuses
overlapping labels and crossing routes, verified source links, and a real browser
check. Arch-lens supplies the thing archify has no opinion about — what the boxes
mean and why this diagram exists.

## Why

A renderer holds about two words per node. Author straight into one and the
reasoning never gets written down: what ships is a picture that passes every
check and answers no question. Three diagrams of the same system, drawn from
three different readings, will disagree and nobody can say which is right.

So the analysis is the artifact:

- **Components carry a responsibility**, not a caption — one sentence saying what
  the thing is answerable for.
- **Relations carry `what_crosses`**, the data or control that actually moves.
  It is the field prose most often omits and readers most often want.
- **Boundaries carry a claim** about everything inside them. A box that only
  groups is decoration, and the validator says so.
- **Components carry a status.** `built` means it was seen in the code; `planned`
  means the design names it and the code does not. A diagram that cannot tell you
  which is which is a diagram you cannot plan from.
- **Questions are the unit of a diagram.** One diagram per question, and the
  question decides what is in it. Everything connected but out of scope is named
  on the diagram's own card rather than vanishing.

## Install

Needs Node 22+ and the archify renderer:

```
npx skills add tt-a1i/archify -g
```

Then, in Claude Code:

```
/plugin marketplace add cognitive-fab/arch-lens
/plugin install archlens@arch-lens
```

Or install it as a plain skill, which works for Claude Code, Cursor, Codex and
OpenCode alike:

```sh
git clone https://github.com/cognitive-fab/arch-lens
node arch-lens/scripts/install-skill.mjs
```

Verify with `node ~/.claude/skills/archlens/bin/archlens.mjs doctor`, which reports
where archify was found. Override the probe with `ARCHLENS_ARCHIFY` if you keep it
somewhere unusual.

## Documentation

- **[GUIDE.md](skills/archlens/docs/GUIDE.md)** — the walkthrough: build an
  analysis piece by piece, run it, read the output, and a full field reference.
- **[notes-app.analysis.json](skills/archlens/examples/notes-app.analysis.json)** —
  a small invented example, six components and two questions, to copy from.
- **[litestream.analysis.json](skills/archlens/examples/litestream.analysis.json)** —
  a real one: [Litestream](https://github.com/benbjohnson/litestream) analysed at
  a pinned commit, with source links verified against git.
- **[analysis.schema.json](skills/archlens/schemas/analysis.schema.json)** — every
  field, with the reasoning in its descriptions.
- **[SKILL.md](skills/archlens/SKILL.md)** — what Claude reads.

## Use

Ask Claude, in any project: *"map this architecture with arch-lens"*. Or drive it
directly:

```sh
archlens validate  system.analysis.json
archlens questions system.analysis.json            # what each diagram would draw
archlens render    system.analysis.json docs/architecture --repo-root .
archlens doc       system.analysis.json ARCHITECTURE.md
```

`render` compiles every question, repairs each specification against archify's
diagnostics until it passes, delivers the HTML, checks it in headless Chrome, and
writes a markdown document beside the diagrams.

## The worked example

`skills/archlens/examples/litestream.analysis.json` analyses
[Litestream](https://github.com/benbjohnson/litestream), a disaster-recovery
sidecar for SQLite, at commit `4ed7a30`. Thirteen components, two boundaries, four
questions:

| Question | Asks |
|---|---|
| How a change reaches the destination | What happens between a committed transaction and an object in storage? |
| Why replicating cannot corrupt the database | A background process is touching a live database. Why is that safe? |
| How a database is rebuilt | The machine is gone. What does it take to get the database back? |
| Keeping it running and keeping it small | What stops the history growing forever, or two processes fighting over one bucket? |

Litestream was chosen because its architecture is mostly an argument about what
crosses a boundary, which is the part a diagram usually loses. To reproduce it,
clone Litestream anywhere and point the renderer at it:

```sh
git clone https://github.com/benbjohnson/litestream /tmp/litestream
archlens render skills/archlens/examples/litestream.analysis.json /tmp/out \
  --repo-root /tmp/litestream
```

All four diagrams pass nine artifact checks with zero errors, contain at four
viewports in light and dark, and carry source links verified against git.

## What it does for you

**Layout.** Columns come from the relation graph, rows from the boundaries. Each
boundary gets a horizontal band of its own, because archify draws a boundary as
the bounding box of its members: two boundaries whose members interleave produce
two overlapping boxes, and an overlapping box asserts a containment nobody wrote.
Relations are never left inside one column, and an edge that skips a column gets
its own routing lane with a staggered exit port.

**Proportion.** archify fits a diagram to the available width and lets the height
follow, so a tall narrow picture is stretched rather than spared and runs off the
bottom of the screen. Arch-lens trades height for width until the projection fits,
then picks the column gap at which node text still clears the readable floor —
before writing any of that text.

**Repair.** archify's diagnostics are unusually good — a label collision arrives
with the exact `labelAt` that resolves it — so a loop reads them and edits:
re-place labels, route around an obstructing node, give a shared corridor its own
lane, narrow the diagram, shorten a detail on a word boundary. It stops when the
error count stops reaching a new minimum, and reports whatever it could not fix.

**Honesty.** Everything lost between the analysis and the picture is reported as a
`dropped` line: components out of scope, a boundary drawn around only some of its
members, a detail shortened. Source links are emitted only when there is a
repository revision to verify them against.

## Layout of this repository

```
.claude-plugin/                marketplace and plugin manifests
skills/archlens/               the plugin's skill, self-contained
  SKILL.md                     how Claude is meant to use all of it
  bin/archlens.mjs             the CLI
  src/model.mjs                referential validation and the thin-analysis warnings
  src/layout.mjs               ranks, bands, lanes, ports, and the text budget
  src/compile.mjs              one question -> one archify specification
  src/repair.mjs               the diagnostic-driven repair loop
  src/markdown.mjs             the same analysis, as prose
  src/archify.mjs              where archify is, and how to run it
  schemas/analysis.schema.json the model
  docs/GUIDE.md                the walkthrough and field reference
  examples/                    one invented, one real
scripts/install-skill.mjs      installs the skill folder into each agent
test/                          twenty tests over what can be wrong quietly
```

## Status

v0.1, and honest about it. The marketplace manifest validates with
`claude plugin validate`, and the published plugin has been installed from
GitHub and used to render the Litestream example from its own install path. Run end to end on two systems. The repair loop handles
six classes of renderer diagnostic and reports anything else rather than guessing.
`archify` is MIT, and this is a consumer of it, not a fork.

MIT licensed.
