# Using archlens

A walkthrough, then a field reference. Everything here runs against
`examples/notes-app.analysis.json`, a small system invented for this
guide: a notes service with a browser app, an API, Postgres, a background indexer
and a search index.

```sh
node bin/archlens.mjs render examples/notes-app.analysis.json /tmp/notes
```

That produces two diagrams, a markdown document, and a report of everything it
had to drop. The rest of this page is about writing the input.

---

## Letting Claude write it

In any project with the skill installed, ask. Three shapes of request cover most
of what people want:

> map this architecture with archlens

> using docs/02-architecture.md as the only source, write an archlens analysis and render it

> /archlens how does the harness mount the gate?

The first reads the code and maps the whole system. The second works from a
document instead, so what the document names and the code does not gets marked
`planned`. The third asks one question: a question is the unit of a diagram, so
Claude writes the answer, the context and a narrative, and renders a single
diagram for it — added to the project's existing analysis if there is one.
Follow-ups work the same way:

> add the retry path to the analysis and re-render

Claude reads the sources, writes the analysis, runs validate and render, and
reports the dropped lines. Review the analysis, not the diagrams: it is the file
that carries the claims, and the diagrams follow it. The rest of this guide is
what Claude is doing on your behalf, so you can write or correct the file
yourself.

---

## The shape of the work

You write **one file**. It describes the system once. Diagrams and prose are both
projections of it, which is why they cannot drift apart.

```
notes.analysis.json  ──▶  write.architecture.html      one per question
                     ──▶  search.architecture.html
                     ──▶  README.md                    the same facts, as prose
```

You do not write coordinates, and you do not edit the generated files. If a
diagram is wrong, the analysis is wrong.

---

## Building an analysis, one piece at a time

### 1. Say what the system is for

```json
{
  "schema_version": 1,
  "system": {
    "name": "Notes",
    "purpose": "A small notes service: people write notes in a browser, and search finds them again.",
    "sources": [{ "kind": "code", "ref": "web/, api/, worker/" }]
  }
}
```

`purpose` is one sentence about what it is for, not how it works. `sources`
records what you actually read. Leave it out and the validator warns, because an
analysis that cannot say where it came from is an opinion.

If the system is a real repository, add:

```json
"repository": {
  "url": "https://github.com/you/notes",
  "revision": "452588f6c25ca8928bc1e71bc71717d4489223d2"
}
```

That turns on verified source links. Without it, archlens emits no links at all
rather than emitting unverifiable ones.

### 2. Name the components

```json
{
  "id": "api",
  "name": "API",
  "kind": "api",
  "detail": "REST over HTTPS",
  "responsibility": "Authenticates the caller and is the only writer of note records.",
  "evidence": [{ "path": "api/src/routes/notes.ts" }]
}
```

`responsibility` is the field that makes this worth more than a picture. One
sentence, active voice, naming what the component is answerable for. Write it for
a person, not for a box — it goes in the document, and only `detail` goes in the
diagram.

`detail` is the diagram's only prose: keep it under 28 characters. Omit it and
archlens will shorten the responsibility to fit, which is usually worse than a
phrase you chose yourself.

**Mark what does not exist yet.** `"status": "planned"` means the design names it
and the code does not. It renders with a `planned` tag and appears in the document
as *(planned)*. This is the single most useful thing the model does that a
hand-drawn diagram cannot.

### 3. Say what moves between them

```json
{
  "from": "api",
  "to": "indexer",
  "mechanism": "queue",
  "summary": "note saved",
  "what_crosses": "A note id and a version. Not the note body, so a slow index cannot slow a save.",
  "synchronous": false
}
```

`summary` is the edge label and must survive at 34 characters. `what_crosses` is
where the real content goes. It is the field prose most often omits and readers
most often want, and the validator warns when it is missing.

### 4. Draw boundaries that claim something

```json
{
  "id": "ours",
  "kind": "trust",
  "label": "Our infrastructure",
  "claim": "Runs code we deploy; anything outside it we can only call, not change",
  "contains": ["api", "db", "indexer", "search"]
}
```

`claim` is mandatory. If you cannot say what is true of everything inside and not
outside, the box is decoration and archlens refuses it. Any relation leaving one
boundary for another should set `"crosses": "<boundary id>"`; the validator warns
if you forget, and a declared crossing renders as a marked edge.

### 5. Ask the questions

This is the part that decides whether the diagrams mean anything.

```json
{
  "id": "write",
  "title": "What happens when a note is saved",
  "ask": "Where does a note go when someone hits save?",
  "answer": "The browser posts to the API, which writes the row and publishes an event. Indexing happens afterwards, so the save never waits on search.",
  "involves": ["web", "api", "db", "indexer", "search"],
  "highlight": ["api", "db"],
  "facts": ["one-writer", "no-body-in-events"],
  "omits": "Sharing and email, which no save touches."
}
```

One question, one diagram. `involves` decides what is drawn; keep it under about
twelve. `answer` becomes the diagram's lead card. Anything connected but not
involved is listed on a *Not shown here* card, so nothing disappears silently.

Resist one big question. Four narrow diagrams beat one that shows everything and
explains nothing.

### 5a. When the question is "what happens when", make it a sequence

An architecture has no time axis. If the answer is an order of events — a save,
a request, a restore — say so, and list the steps:

```json
{
  "id": "save-tick",
  "title": "A save, in order",
  "ask": "What happens, in order, when someone hits save?",
  "shape": "sequence",
  "answer": "The API writes the row, replies, and only then publishes the event the indexer picks up.",
  "involves": ["web", "api", "db", "indexer"],
  "steps": [
    { "from": "web", "to": "api", "says": "POST /notes", "phase": "Save" },
    { "from": "api", "to": "db", "phase": "Save" },
    { "from": "db", "to": "api", "kind": "return", "says": "row written", "phase": "Save" },
    { "from": "api", "to": "web", "kind": "return", "says": "201 Created", "phase": "Save" },
    { "from": "api", "to": "indexer", "kind": "async", "phase": "Afterwards" }
  ]
}
```

Every step runs along a relation the analysis already declares — forwards for a
call, in either direction for a `return` — and the validator refuses one that
does not, because a sequence that shows a message the model never has is a
story, not a projection. `says` is the message label and defaults to the
relation's `summary`; a return has no relation of its own, so it must say what
it carries. `involves` is the participant order, left to right. Consecutive
steps sharing a `phase` are bracketed and labelled with it. `kind: "async"`
draws a dashed arrow for a message the sender does not wait on.

What a sequence cannot carry, it reports: boundaries (a sequence has lifelines,
not regions) and source links (the renderer verifies evidence on architecture
diagrams only). Past about eight steps the participants lose their detail line
so the labels stay readable, and the report says so. Past fourteen, split the
question.

### 6. Attach the facts

```json
{
  "id": "search-lags",
  "kind": "tradeoff",
  "claim": "Search is eventually consistent",
  "because": "indexing happens after the save so a write never waits on it; a note can be missing from search for a second or two"
}
```

Facts are the doctrines, guarantees, constraints, trade-offs and risks that belong
to the architecture rather than to any one component. Reference them from a
question's `facts` and they become the cards beside that diagram.

---

## Running it

```sh
archlens validate  notes.analysis.json          # referential errors and thin spots
archlens questions notes.analysis.json          # what each diagram would draw
archlens render    notes.analysis.json docs/architecture --repo-root .
archlens doc       notes.analysis.json ARCHITECTURE.md --diagrams docs/architecture
archlens doctor                                 # where archify was found
```

Useful flags on `render`:

| Flag | Effect |
|---|---|
| `--repo-root <dir>` | Verify every evidence path against git. Required for source links. |
| `--question <id>` | Render one question while you iterate. Much faster. |
| `--no-check` | Skip the headless-browser pass. Faster, and proves less. |
| `--collapse` | Draw out-of-scope neighbours as one "Elsewhere" node instead of a card. Usually worse; it connects to everything and pulls the layout apart. |

## Reading the output

```
— write: What happens when a note is saved
  dropped  out of scope, named in the card: Email provider
  repair   round 1: 1 diagnostic(s)
  fixed    round 1: moved label "index the document · HTTP" clear of a crossing route
  checks   9/9, 0 error(s), 0 warning(s)
  evidence 5 source link(s) verified at 452588f
  browser  contained at every checked viewport
```

- **dropped** is the difference between your analysis and the picture. It is the
  part a reader cannot see, so read it every time.
- **repair** and **fixed** are the loop reading archify's diagnostics and editing
  the specification. You never do this by hand.
- **checks** is archify's nine artifact checks at showcase quality.
- **evidence** means the source links resolve to real files at that commit.
- **browser** is real headless Chrome at four viewports, light and dark.

`checks` and `browser` prove the diagram is well formed and contained. Neither
proves it is *right*. That is the analysis, and the analysis is yours.

## When something fails

The repair loop handles six classes of diagnostic, so a failure that survives it
is usually structural:

| Symptom | Cause | Fix |
|---|---|---|
| Unresolved corridor or crossing diagnostics | One node joined to almost everything | Ask a narrower question |
| Text shortened on many nodes | Too many columns for a desktop | Fewer components, or shorter `detail` |
| `boundary "x" not drawn: only one member` | The view involves one member of a boundary | Involve another, or accept the note |
| `step "a" -> "b" runs along no declared relation` | A sequence step the model has no edge for | Add the relation, or mark the step a `return` if it answers one |
| `participant detail not shown` | A long sequence, widened to fit a desktop | Accept it, or split the question |
| `could not find archify` | Renderer not installed | `npx skills add tt-a1i/archify -g`, or set `ARCHLENS_ARCHIFY` |

## Field reference

**Component kinds** map to seven rendered shapes. The analysis keeps the
distinction; the diagram narrows it.

| Kind | Renders as |
|---|---|
| `cli`, `ui` | frontend |
| `api`, `service`, `worker`, `library`, `engine`, `workflow`, `broker` | backend |
| `store`, `file-store`, `cache`, `schema`, `config` | database |
| `queue` | message bus |
| `sandbox`, `gateway` | security |
| `model-provider`, `external-service`, `third-party` | external |

**Mechanisms**: `in-process call`, `http`, `https`, `grpc`, `stdio`, `spawn`,
`file`, `database`, `queue`, `event`, `signal`, `manual`. Appended to the edge
label when it fits.

**Boundary kinds**: `trust` and `licence` render as a security group; `process`,
`network`, `deployment` and `ownership` render as a region.

**Fact kinds**: `doctrine`, `guarantee`, `constraint`, `tradeoff`, `risk`. Each
gets its own card colour.

**Question shapes**: `architecture` (the default) draws the parts and what joins
them; `sequence` draws `steps` in order along declared relations. Step kinds:
`call`, `return`, `async`.

**Length limits**, all enforced by the validator: `name` 40, `detail` 28,
`summary` 34, question `title` 60, step `says` 34, step `phase` 24, view `note`
140.
