---
name: archlens
description: Analyse a system's architecture into a structured, evidence-carrying model, then render that model as a set of validated interactive diagrams and a matching markdown document. Use when asked to map, diagram, document or explain the architecture of a codebase or design; to produce architecture diagrams that stay honest about what exists versus what is only designed; or to keep an architecture document and its diagrams from disagreeing. Prefer this over drawing a diagram directly.
license: MIT
metadata:
  version: "0.4.0"
---

# Archlens

Write the analysis. The diagrams are compiled from it.

The failure this exists to prevent: authoring boxes straight into a renderer. A
renderer has room for two words per node, so the reasoning never gets written
down, and what ships is a pretty picture that answers no question. Here the
analysis is the artifact and the diagram is a projection of it.

## The loop

1. **Read the sources.** Prefer an existing architecture document if there is
   one; read the code when the diagram must reflect what actually exists. Record
   what you read in `system.sources` — an analysis that cannot say where it came
   from is an opinion.

   When the repository states its own parts — a compose file, a JavaScript
   workspace — start from that rather than from reading:

   ```bash
   node bin/archlens.mjs seed docker-compose.yml <name>.analysis.json
   node bin/archlens.mjs seed package.json <name>.analysis.json     # workspaces
   ```

   The seed writes the components with evidence, the relations the file
   declares, and a `TODO` wherever a sentence is needed: every responsibility,
   the purpose, each boundary claim, the first answer. It guesses nothing
   else — a mechanism inferred from the target's kind is noted as a guess,
   and `what_crosses` is left for you. Then read the code to replace every
   TODO; `validate` warns on each one until you do, and a seeded analysis is
   not finished while any remains.
2. **Write `<name>.analysis.json`** against `schemas/analysis.schema.json`. This
   is the whole job. Everything below is about doing it honestly.
3. **Check it**, and fix what it tells you:

   ```bash
   node bin/archlens.mjs validate <name>.analysis.json
   ```

4. **Render**, from the repository root when there is one:

   ```bash
   node bin/archlens.mjs render <name>.analysis.json docs/architecture --repo-root .
   ```

   This compiles one diagram per question, repairs each against the renderer's
   diagnostics, delivers the HTML, checks it in a real browser, and writes a
   markdown document beside them. You never write coordinates.

5. **Report** what it says: diagrams delivered, source links verified, and every
   `dropped` line. A dropped boundary or an omitted component is a fact about the
   diagram and belongs in your answer.

Never hand-edit the generated `*.architecture.json`, `*.sequence.json` or
`*.html`. They are output. Change the analysis and render again.

## Answering a question without drawing

Most questions about a system want a sentence and a citation, not a diagram.
When an analysis already exists and the user asks something — "does the replica
ever write to the database?", "what stops two processes sharing a bucket?" —
do not draw, and do not answer from memory. Ask the analysis:

```bash
node bin/archlens.mjs ask <name>.analysis.json "does the replica ever write to the database?"
```

It returns the slice the question touches — components with their evidence,
the relations between them and what crosses, the facts, any question already
answered, the glossary terms used — and ends with the words in the question the
analysis never mentions. Write the answer from that slice and nothing else:

- Cite what you use. A component by name, a relation as `A -> B`, evidence as
  the path it carries. A reader should be able to open the analysis and find
  every claim.
- If it says *mostly does not cover this* or exits 3, say the analysis does not
  answer the question, name the words it never mentions, and stop. Do not fill
  the gap from the code or from general knowledge unless the user asks you to
  extend the analysis — in which case read the sources, add what you learn to
  the analysis with evidence, validate, and answer from the new version.
- If a listed question already answers it, say so and point at its diagram.
- Offer a diagram only when the question would be better answered by one — an
  order of events, or a set of parts and the lines between them — and then add
  it as a question and render, as above.

## Reviewing a change against the analysis

When asked to review a diff, a branch or a pull request in a project that has
an analysis, read the change against it before reading the code:

```bash
node bin/archlens.mjs review <name>.analysis.json --repo-root . --base main
```

Without `--base` it reads the working tree against HEAD. It reports which
components the changed files are evidence for, which boundaries the change
spans and what each one claims, which relations between touched components to
re-read, which guarantees and constraints the change lands on, which diagrams
now need re-rendering, and — separately — which changed files the analysis
has no component for. Then review the code with that in hand:

- For each boundary claim listed, say whether the change keeps it true. A
  change that adds a call from inside a boundary to outside it, where the
  analysis declares no such relation, is the finding this exists to catch.
- For each relation listed, say whether `what_crosses` is still accurate. If
  the change moves something new across an edge, the analysis needs updating
  as part of the change, not after it.
- For files the analysis has no component for, say which they are: outside
  the architecture (tests, build, docs) or a component the analysis is missing.
  Do not let a new module slip in unnamed.
- If evidence is reported gone, the analysis is stale and says so; fix the
  evidence in the same change.

Exit 2 means the change removed something the analysis cites.

## Keeping the analysis true

An analysis pins a revision and cites evidence, and both go stale silently.
Two commands make that visible, and both are meant for CI:

```bash
node bin/archlens.mjs check <name>.analysis.json --repo-root .      # is every citation still there?
node bin/archlens.mjs enforce <name>.analysis.json --repo-root .    # do the constraints still hold?
```

`check` re-resolves every evidence reference and, when the pinned revision is
in the clone, says which cited files changed since it. *Gone* citations exit
1 and must be fixed; *changed* ones need re-reading, after which move
`system.repository.revision` to HEAD; a component marked `planned` whose
evidence resolves has probably been built, so change its status.

`enforce` checks every constraint fact that carries a `rule`. Give a rule to
a constraint whenever the sentence is really about which parts may reach
which:

```json
{ "id": "no-reach-back", "kind": "constraint",
  "claim": "Nothing downstream of the replica reaches back into the database",
  "rule": { "kind": "only-via", "to": "sqlite", "via": ["db", "cli"] } }
```

`no-relation` (`from`, `to`) and `only-via` (`to`, `via`) are the two shapes;
each id may be a component or a boundary, and a boundary stands for its
members. `validate` already refuses an analysis whose own relations break a
rule. `enforce --repo-root` goes further and reads the imports in the code
each component's evidence cites — JavaScript, TypeScript, Python and Go — so
an import from one component's files into another's is caught as the edge it
is, declared or not. It also lists edges the code has that the analysis never
declared; those are not violations, but they are the relations most likely to
be missing from the document.

When two analyses of the same system exist — before and after a change, or
two readings — `compare <base> <head> [out-dir]` reports what moved in the
claims (components, relations, boundaries, facts, questions; which planned
components were built) and, with an out-dir, renders archify's visual
comparison for every architecture question both ask.

## Authoring the analysis

**Components.** `responsibility` is one sentence, active voice, naming what the
component is answerable for. It is the field that makes the analysis worth more
than the picture, so write it for a reader, not for a box. Keep `detail` under
28 characters; it is the only prose the diagram itself can hold.

**Status is a claim about reality.** `built` means you saw it in the code.
`planned` means the design names it and the code does not. Marking a planned
component `built` is the one error here that a reader cannot detect, so when the
analysis comes from a document rather than from code, mark accordingly and say so
in `system.sources`.

**Evidence.** Repository-relative paths, forward slashes, no `..`. Give evidence
for anything you claim exists. With `--repo-root`, every path is verified against
git at the recorded revision, and a wrong path fails the render rather than
shipping a dead link. Without a `system.repository`, source links are omitted
entirely rather than emitted unverified.

**Relations.** `summary` is the edge label and must survive at 34 characters.
`what_crosses` is where the real information goes — the data or control that
actually moves — and it is the field prose most often omits. Set `crosses` when a
relation leaves one boundary and enters another; the validator will warn if you
forget.

**Boundaries must make a claim.** `claim` says what is true of everything inside
and not outside. If you cannot write one, the box is decoration and should not
exist. Members of one boundary are laid out in a band of their own so two boxes
can never visually overlap, which would assert a containment nobody wrote.

**Questions are the unit of a diagram.** One diagram per question, and the
question decides what is in it. Name the components the answer turns on in
`involves`, and keep it under about twelve. Everything connected but out of scope
is listed on the diagram's own card, so nothing disappears silently. A question
with no `answer` produces a diagram that leads with nothing.

**A question chooses its shape.** "What are the parts" is an architecture, the
default. "What happens when" is a sequence: set `shape` to `sequence` and list
`steps` in order, each `from` one involved component `to` another, along a
relation the analysis already declares. `says` is the message label; a `return`
step must say what it carries; `phase` brackets consecutive steps; `kind: async`
is a message nobody waits on. `involves` is the participant order. Do not force
an order into an architecture with numbered labels, and do not draw a sequence
for a question that has no order.

**When the subject is not code, say so.** Set `system.domain` to `document` and
the seven legend families are relabelled for prose subjects — Input, Method,
Data, Signal, Constraint, Environment, Prior work — because "Backend" under a box
that stands for a training procedure tells the reader something false. The
shapes, colours and layout do not move; only the wording does. `system.legend`
overrides any single label if the defaults are wrong for your paper.

Evidence works differently there too. A document has no revision to pin and no
line to resolve, so a component's `doc_refs` section is carried on the node
itself — `§3.2` under the box, beside the status mark when there is one. Give
`doc_refs` a `section` for every component you want cited; the first one is what
the diagram has room for, and the rest survive in the generated document.

**Write the prose the diagram cannot hold.** A node has room for two words and a
card for three short lines, which is enough for a reader who already knows the
system. Three fields carry the rest, and they are rendered below the diagram
rather than on it, so none of them competes for space with the picture:

- `context` — what the question is *about*, before the answer means anything.
  Why a reader should care, what tension the question sits on. Two or three
  sentences. Without it the diagram opens with a title and an answer to a
  question the reader has not yet understood.
- `narrative` — the long read, pitched at a junior developer or a junior
  researcher meeting the system for the first time. Walk the diagram in the
  order the reader's eye will take it and say what each step means. Blank lines
  become paragraphs.
- `glossary` — top level, not per question. Terms a newcomer will not know, each
  with a definition that assumes no prior exposure. Each question renders only
  the terms it actually uses, matched against its own prose and the components it
  draws, so a long glossary costs a short diagram nothing. Use `also` for
  abbreviations and alternate spellings.

**Facts** carry the doctrines, guarantees, constraints, trade-offs and risks that
belong to the architecture rather than to any one component. Attach them to the
questions they answer; they become the cards beside the diagram.

## What the compiler will do to your model

It narrows, and it says so. Twenty component kinds become seven shapes, twelve
mechanisms become a suffix on a label when it fits and nothing when it does not,
and any text too long to stay readable at a 1440px desktop is shortened or the
diagram is narrowed to make room. Long relations get their own routing lane, and
labels are placed and re-placed until the renderer stops objecting.

Read the `dropped` lines. They are the difference between the analysis and the
picture, and they are the part a reader cannot see.

## When a diagram will not pass

The renderer's diagnostics drive an automatic repair loop, so a failure that
survives it is usually structural, not cosmetic. In order of likelihood:

- **Too many components in one question.** Split the question.
- **A boundary with one member in the view.** It is dropped; either involve
  another member or accept the note.
- **A question whose components form a star.** One node joined to everything
  produces edges that cross the whole picture. Ask a narrower question.

Report unresolved diagnostics truthfully. Do not describe a failed render as a
success, and do not claim a visual review you did not perform: `render` proves
the artifact checks and browser containment, nothing about whether the diagram is
*right*. That part is the analysis, and the analysis is yours.
