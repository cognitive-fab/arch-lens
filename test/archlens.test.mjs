// Tests for the parts that can be wrong quietly.
//
// The renderer already proves the geometry — every delivered diagram passes nine
// artifact checks and a browser pass, and nothing here re-litigates that. What is
// tested here is the analysis contract and the compiler's honesty: a question
// that draws a component nobody declared, a boundary drawn around a single node,
// evidence emitted that cannot be verified. Those produce a diagram that renders
// perfectly and says something false.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { validateAnalysis, index } from '../skills/archlens/src/model.mjs';
import { compileQuestion, shorten } from '../skills/archlens/src/compile.mjs';
import { rank, layout, detailBudget } from '../skills/archlens/src/layout.mjs';
import { renderMarkdown } from '../skills/archlens/src/markdown.mjs';
import { briefHtml, glossaryFor } from '../skills/archlens/src/brief.mjs';
import { ask, renderAsk } from '../skills/archlens/src/ask.mjs';
import { review, renderReview } from '../skills/archlens/src/review.mjs';
import { hunksOf } from '../skills/archlens/src/git.mjs';
import { seedCompose, seedWorkspaces } from '../skills/archlens/src/seed.mjs';
import { parseYaml } from '../skills/archlens/src/yaml.mjs';
import { checkDrift, renderDrift } from '../skills/archlens/src/drift.mjs';
import { diffAnalyses, renderDiff } from '../skills/archlens/src/diff.mjs';
import { checkRulesAgainstModel, checkRulesAgainstCode, importsIn, resolveImport, renderEnforce } from '../skills/archlens/src/rules.mjs';
import { checkDocRefs, findQuote, findSection, renderDocCheck, hasPdftotext, docLink } from '../skills/archlens/src/docs.mjs';
import { citedFor } from '../skills/archlens/src/brief.mjs';
import { writePdf } from './fixtures/mkpdf.mjs';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const example = JSON.parse(readFileSync(join(here, '..', 'skills', 'archlens', 'examples', 'litestream.analysis.json'), 'utf8'));

const minimal = () => ({
  schema_version: 1,
  system: { name: 'T', purpose: 'A test system.', sources: [{ kind: 'code', ref: 'src/' }] },
  components: [
    { id: 'a', name: 'A', kind: 'cli', responsibility: 'Starts things.' },
    { id: 'b', name: 'B', kind: 'service', responsibility: 'Does things.' },
  ],
  relations: [{ from: 'a', to: 'b', mechanism: 'in-process call', summary: 'calls', what_crosses: 'A request.' }],
  questions: [{ id: 'q', title: 'How', ask: 'How does it work?', answer: 'A calls B.', involves: ['a', 'b'] }],
});

// --- the model ------------------------------------------------------------

test('the example analysis is valid', () => {
  const result = validateAnalysis(example);
  assert.deepEqual(result.errors, [], 'example should have no errors');
});

test('a question involving an undeclared component is an error', () => {
  const doc = minimal();
  doc.questions[0].involves = ['a', 'ghost'];
  const { ok, errors } = validateAnalysis(doc);
  assert.equal(ok, false);
  assert.match(errors[0].message, /unknown component "ghost"/);
});

test('a relation to nowhere is an error', () => {
  const doc = minimal();
  doc.relations.push({ from: 'b', to: 'ghost', mechanism: 'http', summary: 'calls' });
  assert.equal(validateAnalysis(doc).ok, false);
});

test('a boundary without a claim is an error, because a box that only groups is decoration', () => {
  const doc = minimal();
  doc.boundaries = [{ id: 'x', kind: 'trust', label: 'Box', contains: ['a', 'b'] }];
  const { ok, errors } = validateAnalysis(doc);
  assert.equal(ok, false);
  assert.match(errors.map((e) => e.message).join(' '), /makes no claim/);
});

test('an undeclared boundary crossing warns', () => {
  const doc = minimal();
  doc.boundaries = [
    { id: 'in', kind: 'trust', label: 'In', claim: 'Inside.', contains: ['a'] },
    { id: 'out', kind: 'deployment', label: 'Out', claim: 'Outside.', contains: ['b'] },
  ];
  const { ok, warnings } = validateAnalysis(doc);
  assert.equal(ok, true);
  assert.match(warnings.map((w) => w.message).join(' '), /declares no crossing/);
});

test('an evidence path that escapes the repository is an error', () => {
  const doc = minimal();
  doc.components[0].evidence = [{ path: '../secrets.env' }];
  assert.equal(validateAnalysis(doc).ok, false);
});

test('a self-loop is an error, because the renderer cannot draw one', () => {
  const doc = minimal();
  doc.relations.push({ from: 'a', to: 'a', mechanism: 'http', summary: 'retries' });
  assert.equal(validateAnalysis(doc).ok, false);
});

// --- the compiler ---------------------------------------------------------

test('a question draws only what it involves', () => {
  const { spec } = compileQuestion(example, 'safety');
  const drawn = new Set(spec.components.map((c) => c.id));
  const question = example.questions.find((q) => q.id === 'safety');
  assert.deepEqual([...drawn].sort(), [...question.involves].sort());
});

test('components left out of a question are named on the card, never silently dropped', () => {
  const { spec, dropped } = compileQuestion(example, 'safety');
  const cards = JSON.stringify(spec.cards);
  assert.match(cards, /Connected but out of scope/);
  assert.ok(dropped.some((d) => /out of scope/.test(d)));
});

test('source links are omitted entirely when there is no repository to verify them against', () => {
  const doc = structuredClone(example);
  delete doc.system.repository;
  const { spec } = compileQuestion(doc, 'write');
  assert.ok(spec.components.every((c) => c.sources === undefined));
});

test('source links survive when a repository is declared', () => {
  const { spec } = compileQuestion(example, 'write');
  assert.ok(spec.components.some((c) => Array.isArray(c.sources) && c.sources.length > 0));
});

test('a component that is not fully built is tagged, so a reader can tell design from code', () => {
  const { spec } = compileQuestion(example, 'restore');
  const vfs = spec.components.find((c) => c.id === 'vfs');
  assert.equal(vfs.tag, 'partial');
});

test('a boundary with one member in view is dropped, and says so', () => {
  const doc = minimal();
  doc.components.push({ id: 'c', name: 'C', kind: 'store', responsibility: 'Keeps things.' });
  doc.relations.push({ from: 'b', to: 'c', mechanism: 'file', summary: 'writes', what_crosses: 'Rows.' });
  doc.boundaries = [{ id: 'only', kind: 'trust', label: 'Only', claim: 'One thing.', contains: ['c'] }];
  doc.questions[0].involves = ['a', 'b', 'c'];
  const { spec, dropped } = compileQuestion(doc, 'q');
  assert.equal(spec.boundaries, undefined);
  assert.ok(dropped.some((d) => /only one of its members/.test(d)));
});

// Whatever the shape, the picture has things and the lines between them.
const drawn = (spec) => (spec.diagram_type === 'sequence'
  ? { things: spec.participants, lines: spec.messages }
  : { things: spec.components, lines: spec.connections });

test('every edge label fits the renderer’s limit', () => {
  for (const q of example.questions) {
    const { lines } = drawn(compileQuestion(example, q.id).spec);
    for (const c of lines) {
      assert.ok(c.label.length <= 34, `"${c.label}" is ${c.label.length} characters`);
    }
  }
});

test('no component is drawn twice, and every connection endpoint exists', () => {
  for (const q of example.questions) {
    const { things, lines } = drawn(compileQuestion(example, q.id).spec);
    const ids = things.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const c of lines) {
      assert.ok(ids.includes(c.from), `${c.from} missing`);
      assert.ok(ids.includes(c.to), `${c.to} missing`);
    }
  }
});

// --- the layout -----------------------------------------------------------

test('no relation joins two nodes in the same column', () => {
  const components = example.components;
  const ranks = rank(components, example.relations, example.layers);
  for (const r of example.relations) {
    if (!ranks.has(r.from) || !ranks.has(r.to)) continue;
    assert.notEqual(ranks.get(r.from), ranks.get(r.to), `${r.from} and ${r.to} share a column`);
  }
});

test('boundary members occupy bands that do not overlap', () => {
  const idx = index(example);
  const question = example.questions.find((q) => q.id === 'safety');
  const components = question.involves.map((id) => idx.components.get(id));
  const relations = example.relations.filter((r) => question.involves.includes(r.from) && question.involves.includes(r.to));
  const placed = layout(components, relations, { layers: example.layers, boundaryOf: idx.boundaryOf });

  const extents = new Map();
  for (const c of components) {
    const band = idx.boundaryOf.get(c.id) ?? 'none';
    const [, y] = placed.positions.get(c.id);
    const seen = extents.get(band) ?? { top: Infinity, bottom: -Infinity };
    extents.set(band, { top: Math.min(seen.top, y), bottom: Math.max(seen.bottom, y + 62) });
  }
  const bands = [...extents.values()].sort((a, b) => a.top - b.top);
  for (let i = 1; i < bands.length; i += 1) {
    assert.ok(bands[i].top > bands[i - 1].bottom, 'two boundary bands overlap vertically');
  }
});

test('the text budget shrinks as the diagram widens', () => {
  assert.ok(detailBudget(1000) > detailBudget(1600));
  assert.ok(detailBudget(4000) >= 8);
});

// --- the document ---------------------------------------------------------

test('the markdown carries what the diagram cannot', () => {
  const markdown = renderMarkdown(example);
  assert.match(markdown, /never a connection to your database/);
  assert.match(markdown, /## What moves between them/);
  for (const c of example.components) assert.ok(markdown.includes(c.name), `${c.name} missing from the document`);
});

test('a partially built component is marked in the document', () => {
  const markdown = renderMarkdown(example);
  assert.match(markdown, /\*\(partial\)\*/);
});

// --- the brief ------------------------------------------------------------
//
// The diagram holds two words per node and three short cards. Everything a
// newcomer needs beyond that lives below the picture, and can be wrong in the
// two ways prose is usually wrong: absent, or indiscriminate.

test('the brief carries the question, its context and the long read', () => {
  const analysis = minimal();
  analysis.questions[0].context = 'Why any of this matters.';
  analysis.questions[0].narrative = 'First A runs.\n\nThen B answers.';
  const html = briefHtml(analysis.questions[0], analysis, index(analysis));
  assert.match(html, /How does it work\?/);
  assert.match(html, /Why any of this matters\./);
  assert.match(html, /<p>First A runs\.<\/p>/);
  assert.match(html, /<p>Then B answers\.<\/p>/, 'blank lines should become paragraphs');
});

test('a question with nothing to add gets no brief at all', () => {
  const analysis = minimal();
  assert.equal(briefHtml(analysis.questions[0], analysis, index(analysis)), '');
});

test('the glossary is filtered to the terms a question actually uses', () => {
  const analysis = minimal();
  analysis.questions[0].narrative = 'B keeps an index of everything A sends it.';
  analysis.glossary = [
    { term: 'Index', definition: 'A derived copy shaped for lookup.' },
    { term: 'Quorum', definition: 'A majority of replicas.' },
  ];
  const terms = glossaryFor(analysis.questions[0], analysis, index(analysis)).map((t) => t.term);
  assert.deepEqual(terms, ['Index'], 'an unused term is a wall, not a service');
});

test('a glossary term matches on its alternate spellings too', () => {
  const analysis = minimal();
  analysis.questions[0].context = 'The indexer runs out of band.';
  analysis.glossary = [{ term: 'Index', definition: 'A derived copy.', also: ['indexer'] }];
  assert.equal(glossaryFor(analysis.questions[0], analysis, index(analysis)).length, 1);
});

test('prose is escaped, so an analysis cannot inject markup into the page', () => {
  const analysis = minimal();
  analysis.questions[0].narrative = 'A <script>alert(1)</script> in the prose.';
  const html = briefHtml(analysis.questions[0], analysis, index(analysis));
  assert.ok(!html.includes('<script>alert'), 'raw markup must not survive');
  assert.match(html, /&lt;script&gt;/);
});

// --- documents ------------------------------------------------------------
//
// A paper is not a codebase, and the two places that showed it were the legend
// ("Backend" under a training procedure) and the evidence (a file path where a
// section reference belongs).

const paper = () => ({
  schema_version: 1,
  system: {
    name: 'P',
    purpose: 'A paper.',
    domain: 'document',
    sources: [{ kind: 'document', ref: 'paper.pdf' }],
  },
  components: [
    { id: 'a', name: 'Method', kind: 'engine', responsibility: 'Does the thing.', doc_refs: [{ path: 'paper.pdf', section: '§3.1' }] },
    { id: 'b', name: 'Data', kind: 'store', responsibility: 'Holds the corpus.' },
  ],
  relations: [{ from: 'b', to: 'a', mechanism: 'file', summary: 'trains', what_crosses: 'Sentence pairs.' }],
  questions: [{ id: 'q', title: 'How', ask: 'How does it work?', answer: 'B trains A.', involves: ['a', 'b'] }],
});

test('a document relabels the legend without touching the geometry', () => {
  const { spec } = compileQuestion(paper(), 'q');
  assert.equal(spec.meta.legend.entries.backend.label, 'Method');
  assert.equal(spec.meta.legend.entries.external.label, 'Prior work');
  assert.equal(spec.components.find((c) => c.id === 'a').type, 'backend', 'the shape must not move');
});

test('software keeps the renderer’s own legend wording', () => {
  const { spec } = compileQuestion(minimal(), 'q');
  assert.equal(spec.meta.legend, undefined, 'no override means archify decides');
});

test('an explicit legend overrides the domain default', () => {
  const analysis = paper();
  analysis.system.legend = { backend: 'Procedure' };
  const { spec } = compileQuestion(analysis, 'q');
  assert.equal(spec.meta.legend.entries.backend.label, 'Procedure');
  assert.equal(spec.meta.legend.entries.database.label, 'Data', 'the rest of the default survives');
});

test('a document cites its section on the node, not a repository path', () => {
  const { spec } = compileQuestion(paper(), 'q');
  const method = spec.components.find((c) => c.id === 'a');
  assert.equal(method.tag, '§3.1');
  assert.equal(method.sources, undefined, 'archify refuses repository evidence without a repository');
});

test('status and section share the one line a node has for them', () => {
  const analysis = paper();
  analysis.components[0].status = 'planned';
  const { spec } = compileQuestion(analysis, 'q');
  assert.equal(spec.components.find((c) => c.id === 'a').tag, 'planned · §3.1');
});

test('a glossary term used only on an edge still counts', () => {
  const analysis = paper();
  analysis.glossary = [{ term: 'Sentence pairs', definition: 'Aligned source and target sentences.' }];
  const terms = glossaryFor(analysis.questions[0], analysis, index(analysis)).map((t) => t.term);
  assert.deepEqual(terms, ['Sentence pairs']);
});

// --- sequences --------------------------------------------------------------

const sequenced = () => {
  const doc = minimal();
  doc.relations.push({ from: 'b', to: 'a', mechanism: 'in-process call', summary: 'reports', what_crosses: 'A result.' });
  doc.questions[0] = {
    id: 'q', title: 'When', ask: 'What happens when A runs?', answer: 'A calls B, which reports back.',
    shape: 'sequence', involves: ['a', 'b'],
    steps: [
      { from: 'a', to: 'b', phase: 'Ask' },
      { from: 'b', to: 'a', kind: 'return', says: 'done', phase: 'Ask' },
    ],
  };
  return doc;
};

test('a sequence question compiles to a sequence, with the order the analysis gave', () => {
  const { spec } = compileQuestion(sequenced(), 'q');
  assert.equal(spec.diagram_type, 'sequence');
  assert.deepEqual(spec.participants.map((p) => p.id), ['a', 'b']);
  assert.deepEqual(spec.messages.map((m) => `${m.from}>${m.to}`), ['a>b', 'b>a']);
  assert.ok(spec.messages[1].y > spec.messages[0].y, 'messages descend in step order');
  assert.equal(spec.messages[0].label, 'calls', 'a call without says takes the relation summary');
  assert.equal(spec.messages[1].variant, 'return');
  assert.deepEqual(spec.segments.map((s) => s.label), ['Ask']);
});

test('a step along no declared relation is an error, so a sequence cannot invent an exchange', () => {
  const doc = sequenced();
  doc.relations = doc.relations.filter((r) => r.from !== 'b');
  doc.questions[0].steps.push({ from: 'b', to: 'a', says: 'again' });
  const { ok, errors } = validateAnalysis(doc);
  assert.equal(ok, false);
  assert.match(errors[0].message, /runs along no declared relation/);
  assert.match(errors[0].fix, /"return"/, 'the fix names the reversed relation');
});

test('a reply must say what it carries', () => {
  const doc = sequenced();
  delete doc.questions[0].steps[1].says;
  const { errors } = validateAnalysis(doc);
  assert.match(errors.map((e) => e.message).join('\n'), /reply must say/);
});

test('a step outside the question is an error', () => {
  const doc = sequenced();
  doc.components.push({ id: 'c', name: 'C', kind: 'store', responsibility: 'Keeps things.' });
  doc.relations.push({ from: 'b', to: 'c', mechanism: 'database', summary: 'writes', what_crosses: 'Rows.' });
  doc.questions[0].steps.push({ from: 'b', to: 'c' });
  const { errors } = validateAnalysis(doc);
  assert.match(errors[0].message, /not among the components this question involves/);
});

test('a sequence keeps its proportion by widening, never by growing taller', () => {
  const doc = sequenced();
  for (let i = 0; i < 10; i += 1) doc.questions[0].steps.push({ from: 'a', to: 'b', says: `call ${i}` });
  const { spec, dropped } = compileQuestion(doc, 'q');
  const [w, h] = spec.meta.viewBox;
  assert.ok(w / h >= 2, `a ${w}x${h} sequence would run off a 1440x900 desktop`);
  const last = spec.messages[spec.messages.length - 1].y;
  assert.ok(last <= h - 85, 'the last message stays inside the renderer\'s readable timeline');
  assert.ok(spec.participants.every((p) => !p.sublabel), 'detail is dropped rather than shipped unreadable');
  assert.match(dropped.join('\n'), /participant detail not shown/);
});

test('a sequence says what it cannot draw: boundaries and source links', () => {
  const { spec, dropped } = compileQuestion(example, 'tick');
  assert.equal(spec.diagram_type, 'sequence');
  const report = dropped.join('\n');
  assert.match(report, /boundary "sqlite" not drawn/);
  assert.match(report, /source links not carried/);
  assert.ok(!('boundaries' in spec));
});

test('the document lists a sequence in order, replies marked', () => {
  const md = renderMarkdown(sequenced());
  assert.match(md, /In order:/);
  assert.match(md, /1\. \*\*A → B\*\* — calls\. A request\./);
  assert.match(md, /2\. \*\*B ⇢ A\*\* — done/);
});

// --- asking ------------------------------------------------------------------

test('a question the analysis covers comes back with the component, its evidence, and the relation between', () => {
  const result = ask(example, 'does the replica ever write to the database?');
  assert.equal(result.empty, false);
  assert.ok(result.components.some((m) => m.component.id === 'replica'));
  assert.ok(result.questions.some((m) => m.question.id === 'safety'), 'the safety question is already an answer');
  const text = renderAsk(result);
  assert.match(text, /replica\.go/, 'evidence is cited');
  assert.match(text, /Every term in the question is covered/);
});

test('a question the analysis does not cover says so, by the words it never uses', () => {
  const result = ask(example, 'how is authentication to Kubernetes configured?');
  assert.deepEqual(result.unmatched, ['authentication', 'kubernetes']);
  assert.ok(result.coverage < 0.5);
  assert.match(renderAsk(result), /^The analysis mostly does not cover this\. It never mentions: authentication, kubernetes\./m);
});

test('a question about nothing in the analysis is empty, not answered from nearby', () => {
  const result = ask(example, 'quantum entanglement');
  assert.equal(result.empty, true);
  assert.match(renderAsk(result), /does not cover this/);
});

test('a glossary term in the question is expanded to its other spellings', () => {
  const result = ask(example, 'who reads the WAL?');
  assert.ok(result.glossary.some((t) => t.term === 'write-ahead log'));
  assert.ok(result.components.some((m) => m.component.id === 'wal'), 'WAL finds the write-ahead log');
});

test('a word the analysis uses everywhere is worth less than one it uses once', () => {
  const result = ask(example, 'lease');
  assert.equal(result.components[0].component.id, 'leaser');
});

test('a detail that cannot be shortened on a word boundary is dropped, never cut mid-word', () => {
  assert.equal(shorten('replicate, restore', 12), 'replicate');
  assert.equal(shorten('replicate, restore', 8), '', 'no whole word fits, so nothing is shown');
  assert.equal(shorten('one database, watched', 14), 'one database');
});

// --- reviewing a change --------------------------------------------------------

test('a changed file is traced to the components it is evidence for, and the diagrams that show them', () => {
  const result = review(example, [{ path: 'replica.go', status: 'M', hunks: [[10, 12]] }]);
  assert.deepEqual(result.touched.map((t) => t.component.id), ['replica']);
  assert.ok(result.questions.some((m) => m.question.id === 'write'));
  assert.deepEqual(result.uncovered, []);
});

test('a directory cited as evidence covers the files beneath it', () => {
  const doc = minimal();
  doc.components[0].evidence = [{ path: 'cmd/tool/' }];
  const result = review(doc, [{ path: 'cmd/tool/new.go', status: 'A', hunks: [] }]);
  assert.deepEqual(result.touched.map((t) => t.component.id), ['a']);
  assert.deepEqual(review(doc, [{ path: 'cmd/toolbox/x.go', status: 'A' }]).touched, [], 'a prefix is not a directory');
});

test('a change outside every cited line of a file is reported as near, not as a touch', () => {
  const doc = minimal();
  doc.components[0].evidence = [{ path: 'src/a.js', line: 40, end_line: 60 }];
  const near = review(doc, [{ path: 'src/a.js', status: 'M', hunks: [[1, 3]] }]);
  assert.deepEqual(near.touched, []);
  assert.deepEqual(near.uncovered, [], 'the file is still claimed by the analysis');
  const hit = review(doc, [{ path: 'src/a.js', status: 'M', hunks: [[55, 58]] }]);
  assert.equal(hit.touched[0].files[0].how, 'lines');
});

test('a changed file the analysis has no component for is named, never absorbed', () => {
  const result = review(example, [{ path: 'internal/resumable_reader.go', status: 'A', hunks: [] }]);
  assert.equal(result.quiet, true);
  assert.deepEqual(result.uncovered, ['internal/resumable_reader.go']);
  assert.match(renderReview(result), /no component for:\n  internal\/resumable_reader\.go/);
});

test('deleting a file the analysis cites is reported as evidence gone', () => {
  const result = review(example, [{ path: 'leaser.go', status: 'D', hunks: [] }]);
  assert.deepEqual(result.gone.map((g) => `${g.component.id}:${g.path}`), ['leaser:leaser.go']);
  assert.match(renderReview(result), /^Evidence this change removes/m);
});

test('a change spanning two boundaries lists both claims', () => {
  const result = review(example, [
    { path: 'store.go', status: 'M', hunks: [] },
    { path: 'wal_reader.go', status: 'M', hunks: [] },
  ]);
  assert.deepEqual(result.boundaries.map((m) => m.boundary.id).sort(), ['daemon', 'sqlite']);
  assert.match(renderReview(result), /spans 2 boundaries/);
});

test('hunk headers become new-side line ranges', () => {
  const diff = '@@ -1,3 +1,4 @@\nfoo\n@@ -10 +11,0 @@\nbar\n@@ -20,2 +22 @@\n';
  assert.deepEqual(hunksOf(diff), [[1, 4], [11, 11], [22, 22]]);
});

// --- seeding ---------------------------------------------------------------------

const COMPOSE = `
services:
  web:
    build: .
    depends_on: [api]   # flow list
    networks: [front]
  api:
    image: ghcr.io/acme/api:2
    depends_on:
      db:
        condition: service_healthy
    networks: [front, back]
  db:
    image: postgres:16
    networks: [back]
networks:
  front:
  back:
`;

test('the YAML subset reads block and flow collections, comments and quotes', () => {
  const doc = parseYaml('a: "x # not a comment"  # comment\nb:\n  - 1\n  - k: v\n    j: w\nc: [p, "q"]\nd: {e: f}\n');
  assert.deepEqual(doc, { a: 'x # not a comment', b: [1, { k: 'v', j: 'w' }], c: ['p', 'q'], d: { e: 'f' } });
});

test('the YAML subset refuses what it does not read, by name', () => {
  assert.throws(() => parseYaml('a: &x 1\nb: *x\n'), /anchors/);
  assert.throws(() => parseYaml('a: |\n  text\n'), /block scalars/);
});

test('a compose file seeds components with evidence, kinds from images, and relations from depends_on', () => {
  const { analysis, notes } = seedCompose(COMPOSE, 'docker-compose.yml');
  assert.deepEqual(analysis.components.map((c) => [c.id, c.kind]), [['web', 'service'], ['api', 'service'], ['db', 'store']]);
  assert.deepEqual(analysis.relations.map((r) => [r.from, r.to, r.mechanism]), [['web', 'api', 'http'], ['api', 'db', 'database']]);
  assert.equal(analysis.components[2].evidence[0].path, 'docker-compose.yml');
  assert.match(notes.join('\n'), /mechanism guessed/);
});

test('a compose network with two members becomes a boundary whose claim is a TODO', () => {
  const { analysis } = seedCompose(COMPOSE, 'docker-compose.yml');
  assert.deepEqual(analysis.boundaries.map((b) => [b.id, b.contains]), [['net-front', ['web', 'api']], ['net-back', ['api', 'db']]]);
  assert.match(analysis.boundaries[0].claim, /^TODO/);
});

test('a seeded analysis validates, and every TODO is a warning until it is written', () => {
  const { analysis } = seedCompose(COMPOSE, 'docker-compose.yml');
  const result = validateAnalysis(analysis);
  assert.equal(result.ok, true);
  const todos = result.warnings.filter((w) => /TODO/.test(w.message));
  assert.equal(todos.length, 3 + 2 + 1 + 1, 'three responsibilities, two claims, the purpose, the answer');
  analysis.components[0].responsibility = 'Serves the pages.';
  assert.equal(validateAnalysis(analysis).warnings.filter((w) => /TODO/.test(w.message)).length, 6);
});

test('a workspace seeds one component per package and a relation per internal dependency', () => {
  const members = [
    { dir: 'packages/core', pkg: { name: '@acme/core' } },
    { dir: 'packages/cli', pkg: { name: '@acme/cli', bin: { acme: 'x' }, dependencies: { '@acme/core': '*', lodash: '*' } } },
    { dir: 'apps/api', pkg: { name: '@acme/api', dependencies: { '@acme/core': '*' }, devDependencies: { '@acme/cli': '*' } } },
  ];
  const { analysis, notes } = seedWorkspaces({ name: 'acme' }, members);
  assert.deepEqual(analysis.components.map((c) => [c.id, c.kind]), [['acme-core', 'library'], ['acme-cli', 'cli'], ['acme-api', 'service']]);
  assert.deepEqual(analysis.relations.map((r) => `${r.from}>${r.to}`), ['acme-cli>acme-core', 'acme-api>acme-core']);
  assert.match(notes.join('\n'), /only at development time/);
  assert.equal(validateAnalysis(analysis).ok, true);
});

// --- what the review of the seed found -------------------------------------------

test('a list may sit at the same indent as its key, the compact style compose files use', () => {
  const doc = parseYaml('services:\n  web:\n    depends_on:\n    - api\n    - db\n    image: x\n');
  assert.deepEqual(doc.services.web, { depends_on: ['api', 'db'], image: 'x' });
});

test('one leading document marker is allowed; a second document is not', () => {
  assert.deepEqual(parseYaml('---\na: 1\n'), { a: 1 });
  assert.throws(() => parseYaml('a: 1\n---\nb: 2\n'), /multi-document/);
});

test('a line the parser cannot attach is an error, never silently dropped', () => {
  assert.throws(() => parseYaml('a:\n  b: 1\n c: 2\nd: 3\n'), /line 3: unexpected indentation/);
  assert.throws(() => parseYaml('- |\n  text\n'), /block scalars/);
});

test('a flow mapping as a list item is a mapping, not a key', () => {
  assert.deepEqual(parseYaml('ports:\n  - {target: 80, published: 8080}\n'), { ports: [{ target: 80, published: 8080 }] });
});

test('an apostrophe inside a plain value does not swallow the comment after it', () => {
  assert.deepEqual(parseYaml("command: echo it's fine # comment\n"), { command: "echo it's fine" });
  assert.deepEqual(parseYaml("a: 'x # y'\nb: [\"p # q\", r]\n"), { a: 'x # y', b: ['p # q', 'r'] });
});

// --- drift ------------------------------------------------------------------------

/** A throwaway repository with one commit, returning its root and that commit's sha. */
function repoWith(files) {
  const root = mkdtempSync(join(tmpdir(), 'archlens-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'pin');
  return { root, git, sha: git('rev-parse', 'HEAD').trim() };
}

test('a citation that still resolves and has not changed is fine; one that moved is listed; one that vanished is gone', () => {
  const { root, git, sha } = repoWith({ 'src/a.js': 'one\ntwo\n', 'src/b.js': 'x\n', 'src/c.js': 'y\n' });
  const doc = minimal();
  doc.system.repository = { url: 'https://github.com/x/y', revision: sha };
  doc.components[0].evidence = [{ path: 'src/a.js' }, { path: 'src/c.js' }];
  doc.components[1].evidence = [{ path: 'src/b.js', line: 1 }];
  writeFileSync(join(root, 'src/a.js'), 'one\ntwo\nthree\n');
  rmSync(join(root, 'src/c.js'));
  git('add', '-A');
  git('commit', '-q', '-m', 'move');
  const result = checkDrift(doc, root);
  assert.equal(result.ahead, 1);
  assert.deepEqual(result.moved.map((m) => m.path), ['src/a.js']);
  assert.deepEqual(result.gone.map((g) => [g.path, g.reason]), [['src/c.js', 'deleted since the pinned revision']]);
  assert.equal(result.fine, 1);
  assert.equal(result.ok, false);
  assert.match(renderDrift(result), /1 commit\(s\) past it/);
  rmSync(root, { recursive: true, force: true });
});

test('a cited line past the end of the file is gone, and a planned component with resolving evidence is flagged', () => {
  const { root, sha } = repoWith({ 'src/a.js': 'one\n' });
  const doc = minimal();
  doc.system.repository = { url: 'https://github.com/x/y', revision: sha };
  doc.components[0].evidence = [{ path: 'src/a.js', line: 1, end_line: 5 }];
  doc.components[1].status = 'planned';
  doc.components[1].evidence = [{ path: 'src/a.js' }];
  const result = checkDrift(doc, root);
  assert.match(result.gone[0].reason, /cites lines 1–5 but the file has 2/);
  assert.deepEqual(result.built.map((b) => b.what), ['b']);
  rmSync(root, { recursive: true, force: true });
});

test('without a pinned revision, only existence is checked and the report says so', () => {
  const { root } = repoWith({ 'src/a.js': 'one\n' });
  const doc = minimal();
  doc.components[0].evidence = [{ path: 'src/a.js' }];
  const result = checkDrift(doc, root);
  assert.equal(result.pinned, null);
  assert.equal(result.ok, true);
  assert.match(renderDrift(result), /names no repository revision/);
  rmSync(root, { recursive: true, force: true });
});

// --- comparing two analyses --------------------------------------------------------

test('the difference between two analyses is in the claims: added, removed, changed, promoted', () => {
  const base = minimal();
  const head = minimal();
  head.components.push({ id: 'c', name: 'C', kind: 'store', responsibility: 'Keeps things.', status: 'planned' });
  head.components[1].status = 'built';
  base.components[1].status = 'partial';
  head.relations.push({ from: 'b', to: 'c', mechanism: 'database', summary: 'writes', what_crosses: 'Rows.' });
  head.relations[0].what_crosses = 'A request, now with a deadline.';
  head.questions[0].involves.push('c');
  const d = diffAnalyses(base, head);
  assert.deepEqual(d.components.added.map((c) => c.id), ['c']);
  assert.deepEqual(d.promoted.map((c) => c.id), ['b']);
  assert.deepEqual(d.relations.added.map((r) => `${r.from}>${r.to}`), ['b>c']);
  assert.deepEqual(d.relations.changed[0].fields.map((f) => f.field), ['what_crosses']);
  assert.deepEqual(d.questions.changed[0].involves, { added: ['c'], removed: [] });
  const text = renderDiff(d, base, head);
  assert.match(text, /Built since the base analysis:\n  B/);
  assert.match(text, /now draws: C/);
});

test('two identical analyses have no difference', () => {
  assert.equal(diffAnalyses(minimal(), minimal()).same, true);
  assert.match(renderDiff(diffAnalyses(example, example), example, example), /No difference/);
});

// --- constraints a machine can check -----------------------------------------------

const ruled = () => {
  const doc = minimal();
  doc.components.push({ id: 'c', name: 'C', kind: 'store', responsibility: 'Keeps things.', evidence: [{ path: 'src/c' }] });
  doc.components[0].evidence = [{ path: 'src/a' }];
  doc.components[1].evidence = [{ path: 'src/b' }];
  doc.relations.push({ from: 'b', to: 'c', mechanism: 'database', summary: 'writes', what_crosses: 'Rows.' });
  doc.facts = [{ id: 'store-via-b', kind: 'constraint', claim: 'Only B touches the store', rule: { kind: 'only-via', to: 'c', via: ['b'] } }];
  return doc;
};

test('a rule the analysis itself breaks is a validation error, not a warning', () => {
  const doc = ruled();
  assert.equal(validateAnalysis(doc).ok, true);
  doc.relations.push({ from: 'a', to: 'c', mechanism: 'database', summary: 'peeks', what_crosses: 'Rows.' });
  const { ok, errors } = validateAnalysis(doc);
  assert.equal(ok, false);
  assert.match(errors[0].message, /allows "c" to be reached only via b/);
  assert.equal(checkRulesAgainstModel(doc).length, 1);
});

test('a rule that names nothing the analysis declares is an error', () => {
  const doc = ruled();
  doc.facts[0].rule = { kind: 'no-relation', from: 'a', to: 'ghost' };
  assert.match(validateAnalysis(doc).errors[0].message, /neither a component nor a boundary/);
});

test('a boundary in a rule stands for all its members', () => {
  const doc = ruled();
  doc.boundaries = [{ id: 'data', kind: 'trust', label: 'Data', claim: 'Holds state.', contains: ['c'] }];
  doc.facts[0].rule = { kind: 'no-relation', from: 'a', to: 'data' };
  assert.equal(validateAnalysis(doc).ok, true);
  doc.relations.push({ from: 'a', to: 'c', mechanism: 'database', summary: 'peeks', what_crosses: 'Rows.' });
  assert.match(validateAnalysis(doc).errors[0].message, /forbids/);
});

test('imports are read from JavaScript, Python and Go, and resolved to files in the repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'archlens-'));
  mkdirSync(join(root, 'src/a'), { recursive: true });
  mkdirSync(join(root, 'src/c'), { recursive: true });
  writeFileSync(join(root, 'src/a/index.js'), "import x from '../c/store.js';\nconst y = require('lodash');\n");
  writeFileSync(join(root, 'src/c/store.js'), 'export default 1;\n');
  writeFileSync(join(root, 'src/a/tool.py'), 'from ..c import store\nimport os\n');
  writeFileSync(join(root, 'src/c/store.py'), '');
  writeFileSync(join(root, 'go.mod'), 'module example.com/app\n');
  writeFileSync(join(root, 'src/a/main.go'), 'package a\nimport (\n\t"fmt"\n\t"example.com/app/src/c"\n)\n');
  assert.deepEqual(importsIn("import x from './y';\nexport { z } from \"./z\";\nconst q = require('q');\n", 'f.js').map((i) => i.spec), ['./y', './z', 'q']);
  assert.equal(resolveImport('../c/store.js', 'src/a/index.js', root), 'src/c/store.js');
  assert.equal(resolveImport('lodash', 'src/a/index.js', root), null);
  assert.equal(resolveImport('..c', 'src/a/tool.py', root), 'src/c', 'a namespace package resolves to its directory');
  assert.equal(resolveImport('example.com/app/src/c', 'src/a/main.go', root, { goModule: 'example.com/app' }), 'src/c');

  const doc = ruled();
  doc.facts[0].rule = { kind: 'no-relation', from: 'a', to: 'c' };
  const result = checkRulesAgainstCode(doc, root);
  assert.equal(result.violations.length, 1, 'a imports c from three languages, and the rule forbids it');
  assert.deepEqual(result.violations[0].sites.map((s) => s.file).sort(), ['src/a/index.js', 'src/a/main.go', 'src/a/tool.py']);
  assert.match(renderEnforce([], result, doc), /The code breaks a constraint/);
  assert.match(renderEnforce([], result, doc), /does not declare/, 'a -> c is an edge the analysis never declared');
  rmSync(root, { recursive: true, force: true });
});

// --- citations into documents ----------------------------------------------------

test('a quote is found across folded whitespace, punctuation and page breaks', () => {
  const pages = ['Intro.\nThe encoder reads\n  sentence pairs', ' and emits alignments.\n3.2 Ablation\nRemoving it costs 1.2 BLEU.'];
  assert.equal(findQuote(pages, 'encoder reads sentence pairs'), 1);
  assert.equal(findQuote(pages, 'sentence pairs and emits'), 1, 'straddling a page break counts, on the first page');
  assert.equal(findQuote(pages, 'removing it costs 1.2 bleu'), 2);
  assert.equal(findQuote(pages, 'the decoder'), 0);
});

test('a section is found by number, by heading words, or by words anywhere, in that order', () => {
  const pages = ['# Notes\n\n## 2 Method\n\ntext', '3.2 Ablation\nmore\nRelated work is cited here.'];
  assert.equal(findSection(pages, '§2'), 1);
  assert.equal(findSection(pages, '3.2'), 2);
  assert.equal(findSection(pages, '3.2 Ablation'), 2);
  assert.equal(findSection(pages, 'Method'), 1, 'a heading line');
  assert.equal(findSection(pages, 'Related work'), 2, 'words in running text, as a last resort');
  assert.equal(findSection(pages, '§7'), 0);
});

test('document citations are checked: gone, wrong, mispaged, unverified, confirmed', () => {
  const root = mkdtempSync(join(tmpdir(), 'archlens-'));
  writeFileSync(join(root, 'notes.md'), '# Notes\n\n## 2 Method\n\nThe encoder reads sentence pairs.\n');
  writeFileSync(join(root, 'scan.docx'), 'binary');
  const doc = paper();
  doc.components[0].doc_refs = [
    { path: 'notes.md', section: '§2', quote: 'reads sentence pairs' },
    { path: 'notes.md', section: 'Conclusion' },
    { path: 'notes.md', quote: 'the decoder' },
    { path: 'gone.md', section: '§1' },
    { path: 'scan.docx', section: '§1' },
  ];
  const result = checkDocRefs(doc, root);
  assert.equal(result.fine, 1);
  assert.deepEqual(result.gone.map((g) => g.path), ['gone.md']);
  assert.deepEqual(result.missing.map((m) => m.reason), ['section "Conclusion" not found', 'quote not found: "the decoder"']);
  assert.deepEqual(result.unverified.map((u) => u.reason), ['not a text or PDF document']);
  assert.equal(result.ok, false);
  assert.match(renderDocCheck(result), /1 confirmed, 1 unverified, 2 wrong, 1 gone/);
  rmSync(root, { recursive: true, force: true });
});

test('a doc_ref with nothing checkable warns, and one that escapes the root is an error', () => {
  const doc = paper();
  doc.components[0].doc_refs = [{ path: 'paper.pdf' }];
  const { ok, warnings } = validateAnalysis(doc);
  assert.equal(ok, true);
  assert.match(warnings.map((w) => w.message).join('\n'), /names no section, page or quote/);
  doc.components[0].doc_refs = [{ path: '../paper.pdf', section: '§1' }];
  assert.equal(validateAnalysis(doc).ok, false);
});

test('the document link opens at the cited page, and the brief lists what a paper question cites', () => {
  assert.equal(docLink({ path: 'paper.pdf', page: 12 }), 'paper.pdf#page=12');
  assert.equal(docLink({ path: 'notes.md', section: '§2' }), 'notes.md');
  const doc = paper();
  doc.components[0].doc_refs = [{ path: 'paper.pdf', section: '§3.1', page: 4, quote: 'the thing' }];
  const cited = citedFor(doc.questions[0], doc, index(doc));
  assert.equal(cited.length, 1);
  const html = briefHtml(doc.questions[0], doc, index(doc));
  assert.match(html, /<h3>Cited<\/h3>/);
  assert.match(html, /href="paper\.pdf#page=4">paper\.pdf §3\.1, p\. 4<\/a> <q>the thing<\/q>/);
  const code = minimal();
  code.components[0].doc_refs = [{ path: 'DESIGN.md', section: 'Overview' }];
  assert.deepEqual(citedFor(code.questions[0], code, index(code)), [], 'a code subject keeps its source links; the brief does not double up');
});

test('the markdown links a citation to its page and carries the quote', () => {
  const doc = paper();
  doc.components[0].doc_refs = [{ path: 'paper.pdf', section: '§3.1', page: 4, quote: 'the thing' }];
  assert.match(renderMarkdown(doc), /\[paper\.pdf §3\.1, p\. 4\]\(paper\.pdf#page=4\) — “the thing”/);
});

if (hasPdftotext()) {
  test('a PDF is read page by page through pdftotext, so a quote can be held to its page', () => {
    const root = mkdtempSync(join(tmpdir(), 'archlens-'));
    writePdf(root);
    const doc = paper();
    doc.components[0].doc_refs = [
      { path: 'paper.pdf', section: '§2', page: 1, quote: 'The encoder reads sentence pairs' },
      { path: 'paper.pdf', section: '3.2', page: 1 },
      { path: 'paper.pdf', page: 9 },
    ];
    const result = checkDocRefs(doc, root);
    assert.equal(result.fine, 1);
    assert.deepEqual(result.mispaged.map((m) => [m.claimed, m.found]), [[1, 2]]);
    assert.deepEqual(result.gone.map((g) => g.reason), ['cites page 9 of 2']);
    rmSync(root, { recursive: true, force: true });
  });
}

// --- what the final review found ------------------------------------------------------

test('an analysis with no relations validates, checks, asks, diffs and compiles without crashing', () => {
  const doc = paper();
  delete doc.relations;
  assert.equal(validateAnalysis(doc).ok, true);
  assert.doesNotThrow(() => compileQuestion(doc, 'q'));
  assert.doesNotThrow(() => ask(doc, 'method'));
  assert.doesNotThrow(() => review(doc, [{ path: 'x', status: 'M' }]));
  assert.doesNotThrow(() => renderMarkdown(doc));
  assert.equal(checkRulesAgainstModel(doc).length, 0);
  doc.facts = [{ id: 'r', kind: 'constraint', claim: 'x', rule: { kind: 'no-relation', from: 'a', to: 'b' } }];
  assert.equal(validateAnalysis(doc).ok, true, 'a ruled fact must not make the validator iterate a missing list');
});

test('a multi-line named import is read, with the line it starts on', () => {
  const text = "const a = 1;\nimport {\n  x,\n  y,\n} from '../c/store.js';\nexport {\n  z\n} from './z';\n";
  assert.deepEqual(importsIn(text, 'f.ts'), [{ spec: '../c/store.js', line: 2 }, { spec: './z', line: 6 }]);
});

test('a rule is enforced only on a constraint, as the warning says', () => {
  const doc = ruled();
  doc.facts[0].kind = 'risk';
  doc.relations.push({ from: 'a', to: 'c', mechanism: 'database', summary: 'peeks', what_crosses: 'Rows.' });
  const { ok, warnings } = validateAnalysis(doc);
  assert.equal(ok, true, 'a rule on a risk is not enforced');
  assert.match(warnings.map((w) => w.message).join('\n'), /only a constraint is enforced/);
  assert.equal(checkRulesAgainstModel(doc).length, 0);
});

test('a rule the analysis breaks is tagged, so enforce can report it instead of being refused the file', () => {
  const doc = ruled();
  doc.relations.push({ from: 'a', to: 'c', mechanism: 'database', summary: 'peeks', what_crosses: 'Rows.' });
  const { errors } = validateAnalysis(doc);
  assert.deepEqual(errors.map((e) => e.code), ['rule-violation']);
});

test('a document that cannot be read is one unverified citation, not a crash', () => {
  const root = mkdtempSync(join(tmpdir(), 'archlens-'));
  mkdirSync(join(root, 'notes.md'));
  writeFileSync(join(root, 'bad.pdf'), 'not a pdf');
  const doc = paper();
  doc.components[0].doc_refs = [{ path: 'notes.md', section: '§1' }, { path: 'bad.pdf', section: '§1' }];
  const result = checkDocRefs(doc, root);
  assert.equal(result.unverified.length, 2, 'a directory named like a text file, and a PDF that is not one');
  assert.match(result.unverified[0].reason, /could not be read/);
  assert.equal(result.ok, true, 'unverified is not wrong');
  rmSync(root, { recursive: true, force: true });
});

test('a removed component keeps the name the base analysis gave it', () => {
  const base = ruled();
  const head = ruled();
  head.components = head.components.filter((c) => c.id !== 'c');
  head.relations = head.relations.filter((r) => r.to !== 'c');
  head.facts = [];
  const text = renderDiff(diffAnalyses(base, head), base, head);
  assert.match(text, /- B -> C: writes/, 'the relation names C, not "c"');
});

test('an alias in a list item is refused, and a list item with extra spaces after the dash is read', () => {
  assert.throws(() => parseYaml('depends_on:\n  - *db\n'), /aliases/);
  assert.deepEqual(parseYaml('items:\n  -   key: v\n      other: w\n'), { items: [{ key: 'v', other: 'w' }] });
});

test('a document link is written from where the page lives, and survives spaces and parentheses', () => {
  assert.equal(docLink({ path: 'docs/paper.pdf', page: 3 }, '../..'), '../../docs/paper.pdf#page=3');
  assert.equal(docLink({ path: 'my paper (v2).pdf', page: 1 }, '.'), './my%20paper%20%28v2%29.pdf#page=1');
  const doc = paper();
  doc.components[0].doc_refs = [{ path: 'docs/paper.pdf', section: '§1', page: 2 }];
  assert.match(briefHtml(doc.questions[0], doc, index(doc), { docBase: '../..' }), /href="\.\.\/\.\.\/docs\/paper\.pdf#page=2"/);
  assert.match(renderMarkdown(doc, { docBase: '..' }), /\]\(\.\.\/docs\/paper\.pdf#page=2\)/);
});
