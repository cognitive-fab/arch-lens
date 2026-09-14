# Changelog

What changed in arch-lens, newest first. Versions are the plugin's; the
marketplace offers an update whenever one is bumped.

## 0.5.2 — 2026-09-14

The prose is part of the job, and the question gets answered.

- `validate` warns on a question with no `context` or `narrative`, and on an
  analysis with no `glossary`; `render` prints a warning, not a quiet note,
  when a page ends at the diagram. Reported from a run where Claude wrote the
  components and rendered without any of the prose.
- SKILL.md's loop now lists what a finished question carries, and step 5 is
  "answer, then report": when the user asked a question, the reply leads
  with its answer from the analysis, not with the list of files rendered.
- A new "When invoked with a question" section says what to do with a
  question about what exists, with or without an analysis, and with a design
  question ("what would X look like") — planned components, the proposal in
  `answer` and `narrative`, the reply leading with the proposal.
- The notes-app example carries context, narrative and a glossary.

## 0.5.1 — 2026-09-13

Fixes from a review of 0.3.0–0.5.0.

- `seed package.json` reads the manifest and expands its workspaces from the
  manifest's own directory, so a workspace below the git root seeds correctly;
  evidence is still written from the repository root.
- `enforce` reads multi-line JavaScript imports (`import {\n a,\n} from …`),
  which were skipped and not counted as unresolved.
- Every command tolerates an analysis with no `relations`, which the schema
  allows; `validate`, `check`, `ask` and `questions` no longer crash on one.
- `enforce` can report a rule the analysis itself breaks, in text and `--json`;
  it was refused the file by the same validation error it exists to report.
- Rules are enforced only on `constraint` facts, as the warning said.
- A PDF `pdftotext` cannot read is one unverified citation with the reason,
  not an abort of the whole `check`.
- `check` runs the drift check whenever any citation exists, not only when a
  component carries evidence.
- `compare` names a removed component by the name the base analysis gave it.
- The YAML subset refuses an alias in a list item (`- *db`) by name instead of
  reading it as a string, and reads `-   key: v` with extra spaces.
- Links into documents are written relative to the directory the page lives
  in, and escape spaces and parentheses.

## 0.5.0 — 2026-09-13

Documents cited the way code is.

- `doc_refs` carry a `page` as well as a `section` and a `quote`, on
  components, relations and facts.
- `check --repo-root` resolves document citations against the documents: the
  file exists, the quote is in it and on the cited page, the section is found
  by number or by words. Text and markdown are read directly; PDFs through
  `pdftotext` when installed, reported as unverified by name when not.
- Every rendered link into a PDF opens at the page (`#page=N`): in the
  generated markdown, and in a new **Cited** list under the diagram for
  document subjects.
- A citation with nothing checkable in it is warned about.

## 0.4.0 — 2026-09-13

Keeping the analysis true.

- `check` — the drift check for CI. Re-resolves every evidence reference;
  exits 1 when one is gone; lists cited files that changed since the pinned
  revision and how far HEAD is past it; flags a `planned` component whose
  evidence resolves.
- `compare <base> <head> [out-dir]` — the difference between two analyses in
  their claims: components, relations, boundaries, facts, questions added,
  removed and changed; membership and involvement moves; planned components
  built since. With an out-dir, archify's visual comparison for every
  architecture question both ask. Compiled connections carry stable ids.
- `enforce` — constraint facts can carry a `rule` (`no-relation`, `only-via`)
  over component or boundary ids. `validate` refuses an analysis whose own
  relations break a rule; `enforce --repo-root` checks the imports in the
  cited code (JavaScript, TypeScript, Python, Go) and lists edges the code has
  that the analysis never declared.

## 0.3.0 — 2026-09-13

Reviewing and seeding.

- `review --repo-root [--base <ref>]` — a change read against the analysis:
  which components its files are evidence for, the boundaries it spans and
  their claims, relations to re-read, guarantees it lands on, diagrams to
  re-render, and the changed files the analysis has no component for.
  Evidence the change deletes exits 2. Works in a repository with no commits.
- `seed` — a draft analysis from a compose file (services, images,
  `depends_on`, networks as boundaries) or a JavaScript workspace
  (`package.json` workspaces or `pnpm-workspace.yaml`), evidence attached.
  Every missing sentence is a `TODO`, and `validate` warns on each until it is
  written. Compose is read with a small YAML subset that refuses anchors,
  block scalars and multi-documents by name.
- The repair loop and the compiler drop a detail line that cannot be shortened
  on a word boundary instead of cutting it mid-word ("replicat").
- Fixes from a review of the seed: compact `depends_on:\n- api` lists, a
  leading `---`, unattached lines are an error rather than silently dropped,
  flow mappings as list items, apostrophes mid-value, root-level and suffixed
  workspace globs, the seed's repository root defaults to the git root.

## 0.2.0 — 2026-09-13

Two ways to ask.

- A question chooses its shape. `shape: "sequence"` with ordered `steps`
  renders a sequence diagram from the same components and relations; a step
  the model has no relation for is refused. Phases, returns, async messages,
  activations. Width follows height so the picture fits a desktop; past the
  width at which the participant detail line stays readable it is dropped and
  reported.
- `ask <analysis> "<question>"` — the slice of the analysis a question touches,
  with evidence, and the words in the question the analysis never mentions.
  No model involved; exits 3 when the analysis does not cover the question.
- The Litestream example gains a fifth question, a sequence, and each question
  gains a `context`, a `narrative` and glossary terms.

## 0.1.1 — 2026-09-12

- README and guide lead with how to ask Claude — map the system, work from a
  document, `/archlens <question>` — and put hand-authoring after.
- One plugin description in both manifests, naming the ways to ask.

## 0.1.0

- The analysis model, the compiler to archify architecture specifications,
  the diagnostic-driven repair loop, the markdown document, the Claude Code
  plugin and the plain-skill installer. Litestream as the worked example.
