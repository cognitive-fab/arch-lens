# archlens

**Write the architecture analysis. The diagrams compile from it.**

Archlens is a small Node.js tool and a Claude Code skill. You — or Claude — write
one structured analysis of a system. Archlens compiles it into a set of validated,
interactive HTML diagrams and a markdown document that cannot disagree with them,
and never asks anyone to type a coordinate.

It does not draw. Rendering is [archify](https://github.com/tt-a1i/archify)'s job,
and archify is very good at it: deterministic HTML, a validator that refuses
overlapping labels and crossing routes, verified source links, and a real browser
check. Archlens supplies the thing archify has no opinion about — what the boxes
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

Needs Node 22+ and archify installed as a skill:

```sh
npx skills add tt-a1i/archify -g          # if you do not have it
git clone <this repo> ~/code/archlens
node ~/code/archlens/scripts/install-skill.mjs
```

The install script assembles a self-contained skill folder — `SKILL.md` plus the
runtime it tells the agent to run — into every agent directory it finds (Claude
Code, Cursor, Codex, OpenCode), or into one path you pass explicitly. Copying
`SKILL.md` on its own gives you a skill that reads perfectly and cannot execute a
single instruction in it.

Verify with `node ~/.claude/skills/archlens/bin/archlens.mjs doctor`, which reports
where archify was found. Override the probe with `ARCHLENS_ARCHIFY` if you keep it
somewhere unusual.

**This is not a marketplace plugin.** It installs as a personal skill, from a
local clone. There is no published repository and nothing to `/plugin install`.

## Documentation

- **[docs/GUIDE.md](docs/GUIDE.md)** — the walkthrough: build an analysis piece by
  piece, run it, read the output, and a full field reference.
- **[examples/notes-app.analysis.json](examples/notes-app.analysis.json)** — a
  small worked example (six components, two questions) to copy from.
- **[examples/polygents.analysis.json](examples/polygents.analysis.json)** — a
  real one, with layers, two boundaries and verified source links.
- **[schemas/analysis.schema.json](schemas/analysis.schema.json)** — every field,
  with the reasoning in its descriptions.
- **[skills/archlens/SKILL.md](skills/archlens/SKILL.md)** — what Claude reads.

## Use

Ask Claude, in any project: *"map this architecture with archlens"*. Or drive it
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

## What it does for you

**Layout.** Columns come from the relation graph, rows from the boundaries. Each
boundary gets a horizontal band of its own, because archify draws a boundary as
the bounding box of its members: two boundaries whose members interleave produce
two overlapping boxes, and an overlapping box asserts a containment nobody wrote.
Relations are never left inside one column, and an edge that skips a column gets
its own routing lane with a staggered exit port.

**Width.** archify scales a diagram to fit a desktop and then rejects node text
that lands below six pixels, so a wide diagram silently costs every node its
detail line. Archlens picks the column gap that the text survives at, before
writing any of it.

**Repair.** archify's diagnostics are unusually good — a label collision arrives
with the exact `labelAt` that resolves it — so a loop reads them and edits:
re-place labels, route around an obstructing node, give a shared corridor its own
lane, narrow the diagram, shorten a detail on a word boundary. It stops when the
error count stops reaching a new minimum, and reports whatever it could not fix.

**Honesty.** Everything lost between the analysis and the picture is reported as a
`dropped` line: components out of scope, a boundary drawn around only some of its
members, a detail shortened. Source links are emitted only when there is a
repository revision to verify them against.

## Layout

```
schemas/analysis.schema.json   the model, with the reasoning in its descriptions
src/model.mjs                  referential validation and the thin-analysis warnings
src/layout.mjs                 ranks, bands, lanes, ports, the text budget
src/compile.mjs                one question -> one archify specification
src/repair.mjs                 the diagnostic-driven repair loop
src/markdown.mjs               the same analysis, as prose
src/archify.mjs                where archify is, and how to run it
skills/archlens/SKILL.md       how Claude is meant to use all of it
scripts/install-skill.mjs      assembles the self-contained skill folder
docs/GUIDE.md                  the walkthrough and field reference
examples/notes-app.analysis.json   a small worked example
examples/polygents.analysis.json   a real one, with verified source links
```

## Status

v0.1, and honest about it. It has been run end to end on one real system
(`examples/`), producing four diagrams that each pass nine artifact checks with
zero errors and browser containment at four viewports. The repair loop handles
six diagnostic classes; anything else it reports and leaves alone.

`archify` is MIT. This is a consumer of it, not a fork.
