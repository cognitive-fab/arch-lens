---
name: archlens
description: Analyse a system's architecture into a structured, evidence-carrying model, then render that model as a set of validated interactive diagrams and a matching markdown document. Use when asked to map, diagram, document or explain the architecture of a codebase or design; to produce architecture diagrams that stay honest about what exists versus what is only designed; or to keep an architecture document and its diagrams from disagreeing. Prefer this over drawing a diagram directly.
license: MIT
metadata:
  version: "0.1"
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

Never hand-edit the generated `*.architecture.json` or `*.html`. They are output.
Change the analysis and render again.

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
