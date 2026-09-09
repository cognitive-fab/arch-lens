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

import { validateAnalysis, index } from '../src/model.mjs';
import { compileQuestion } from '../src/compile.mjs';
import { rank, layout, detailBudget } from '../src/layout.mjs';
import { renderMarkdown } from '../src/markdown.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const example = JSON.parse(readFileSync(join(here, '..', 'examples', 'polygents.analysis.json'), 'utf8'));

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
  const { spec } = compileQuestion(example, 'boundary');
  const drawn = new Set(spec.components.map((c) => c.id));
  const question = example.questions.find((q) => q.id === 'boundary');
  assert.deepEqual([...drawn].sort(), [...question.involves].sort());
});

test('components left out of a question are named on the card, never silently dropped', () => {
  const { spec, dropped } = compileQuestion(example, 'boundary');
  const cards = JSON.stringify(spec.cards);
  assert.match(cards, /Connected but out of scope/);
  assert.ok(dropped.some((d) => /out of scope/.test(d)));
});

test('source links are omitted entirely when there is no repository to verify them against', () => {
  const doc = structuredClone(example);
  delete doc.system.repository;
  const { spec } = compileQuestion(doc, 'evidence');
  assert.ok(spec.components.every((c) => c.sources === undefined));
});

test('source links survive when a repository is declared', () => {
  const { spec } = compileQuestion(example, 'evidence');
  assert.ok(spec.components.some((c) => Array.isArray(c.sources) && c.sources.length > 0));
});

test('a planned component is tagged so a reader can tell design from code', () => {
  const { spec } = compileQuestion(example, 'boundary');
  const oracle = spec.components.find((c) => c.id === 'oracle');
  assert.equal(oracle.tag, 'planned');
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

test('every edge label fits the renderer\'s limit', () => {
  for (const q of example.questions) {
    const { spec } = compileQuestion(example, q.id);
    for (const c of spec.connections) {
      assert.ok(c.label.length <= 34, `"${c.label}" is ${c.label.length} characters`);
    }
  }
});

test('no component is drawn twice, and every connection endpoint exists', () => {
  for (const q of example.questions) {
    const { spec } = compileQuestion(example, q.id);
    const ids = spec.components.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const c of spec.connections) {
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
  const question = example.questions.find((q) => q.id === 'boundary');
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
  assert.match(markdown, /Solution values, a world version and the account key/);
  assert.match(markdown, /## What moves between them/);
  for (const c of example.components) assert.ok(markdown.includes(c.name), `${c.name} missing from the document`);
});

test('planned components are marked in the document', () => {
  const markdown = renderMarkdown(example);
  assert.match(markdown, /\*\(planned\)\*/);
});
