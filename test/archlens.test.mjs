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
