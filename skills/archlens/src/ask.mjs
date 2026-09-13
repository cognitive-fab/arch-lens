// Answer from the analysis, or say that it cannot.
//
// A rendered diagram is the right answer to some questions and the wrong shape
// for most: "does the replica ever write to the database?" wants a sentence and
// a citation, not a picture. This gathers the slice of the analysis a question
// touches — the components, the relations between them, the facts, the questions
// already answered, the terms — and hands it back with every claim carrying its
// evidence, so whoever writes the sentence (a person, or the model running the
// skill) is writing from the analysis and not from memory.
//
// There is no model here. Matching is lexical and deliberately so: the point is
// to be a faithful index of what the analysis says, and a faithful index says
// "nothing" when there is nothing, which is the one answer a model finds hardest
// to give. What the question asks about and the analysis never mentions is
// reported as such, by name.

import { index } from './model.mjs';

const STOP = new Set(('a an and are as at be but by can could do does for from has have how in into is it its of on or ' +
  'that the their there these this those to was were what when where which who why will with without would you your ' +
  'ever never always any every one some all does did done doing get gets got go goes going make makes made ' +
  'run runs running use uses used using happen happens happened happening thing things way ways').split(' '));

/**
 * Words worth matching on. Plurals and simple verb endings are folded so that
 * "replicates" finds "replica" and "checkpoints" finds "checkpoint". The map
 * keeps the first spelling seen for each stem, so what is reported back to the
 * asker is a word they wrote and not the stump it was matched on.
 */
export function terms(text) {
  const out = new Map();
  for (const raw of String(text).toLowerCase().match(/[a-z0-9_][a-z0-9_'-]*/g) ?? []) {
    const word = raw.replace(/^'+|'+$/g, '');
    if (!word || STOP.has(word) || word.length < 3) continue;
    const s = stem(word);
    if (!out.has(s)) out.set(s, word);
  }
  return out;
}

export function stem(word) {
  return word
    .replace(/'s$/, '')
    .replace(/(ies)$/, 'y')
    .replace(/(sses|shes|ches|xes)$/, (m) => m.slice(0, -2))
    .replace(/(ing|ed|es|s)$/, '')
    .replace(/(tion|ations?)$/, 't');
}

/** Which of the question's terms a text contains. */
function hits(questionTerms, text) {
  const found = new Set();
  const own = terms(text);
  for (const t of questionTerms.keys()) {
    if (own.has(t)) found.add(t);
  }
  return found;
}

/**
 * How much each term is worth: a word the analysis uses everywhere ("database",
 * "file") tells you almost nothing about which part of it answers the question,
 * and a word it uses once tells you exactly. Weighted by how many of the
 * analysis's own texts contain the term, which is the analysis's vocabulary and
 * not the language's.
 */
function weights(analysis, questionTerms) {
  const texts = [
    ...analysis.components.map((c) => [c.name, c.id, c.responsibility, c.detail, ...(c.notes ?? [])].filter(Boolean).join(' ')),
    ...(analysis.relations ?? []).map((r) => `${r.summary} ${r.what_crosses ?? ''}`),
    ...(analysis.facts ?? []).map((f) => `${f.claim} ${f.because ?? ''}`),
    ...analysis.questions.map((q) => [q.title, q.ask, q.answer, q.context, q.narrative].filter(Boolean).join(' ')),
    ...(analysis.boundaries ?? []).map((b) => `${b.label} ${b.claim}`),
  ];
  const df = new Map();
  for (const text of texts) for (const t of terms(text).keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const out = new Map();
  for (const t of questionTerms.keys()) {
    const n = df.get(t) ?? 0;
    out.set(t, n === 0 ? 0 : 1 / Math.sqrt(n));
  }
  return out;
}

/**
 * The slice of the analysis a question touches.
 *
 * @param {object} analysis
 * @param {string} question  plain words
 * @returns {object} ranked components, relations, facts, questions, terms, and
 *   the question's own terms that matched nothing
 */
export function ask(analysis, question) {
  const idx = index(analysis);

  // A glossary term in the question is expanded to its alternate spellings, so
  // "WAL" finds the write-ahead log and vice versa.
  const qTerms = terms(question);
  const glossary = analysis.glossary ?? [];
  const usedTerms = [];
  for (const entry of glossary) {
    const forms = [entry.term, ...(entry.also ?? [])];
    const lower = String(question).toLowerCase();
    if (forms.some((f) => lower.includes(String(f).toLowerCase()))) {
      usedTerms.push(entry);
      for (const f of forms) for (const [t, word] of terms(f)) if (!qTerms.has(t)) qTerms.set(t, word);
    }
  }

  const weight = weights(analysis, qTerms);
  const score = (found, factor = 1) => [...found].reduce((sum, t) => sum + (weight.get(t) ?? 0), 0) * factor;

  // --- components ------------------------------------------------------------
  const components = analysis.components.map((c) => {
    const inName = hits(qTerms, `${c.name} ${c.id}`);
    const inBody = hits(qTerms, [c.responsibility, c.detail, ...(c.notes ?? [])].filter(Boolean).join(' '));
    const found = new Set([...inName, ...inBody]);
    return { component: c, found, score: score(inName, 3) + score(inBody, 1) };
  }).filter((m) => m.score > 0).sort((a, b) => b.score - a.score);
  const matchedIds = new Set(components.map((m) => m.component.id));

  // --- relations -------------------------------------------------------------
  // A relation is relevant when its own words match, or when it joins two
  // matched components: "does X ever talk to Y" is a question about an edge
  // whose label may use neither word.
  const strongest = components[0]?.score ?? 0;
  const strongIds = new Set(components.filter((m) => m.score >= strongest / 2).map((m) => m.component.id));
  const relations = (analysis.relations ?? []).map((r) => {
    const found = hits(qTerms, `${r.summary} ${r.what_crosses ?? ''} ${r.mechanism}`);
    const joins = matchedIds.has(r.from) && matchedIds.has(r.to);
    const touches = strongIds.has(r.from) || strongIds.has(r.to);
    const s = score(found, 2) + (joins ? 3 : touches ? 1 : 0);
    return { relation: r, found, joins, score: s };
  }).filter((m) => m.score > 0).sort((a, b) => b.score - a.score);

  // --- facts -----------------------------------------------------------------
  const facts = (analysis.facts ?? []).map((f) => {
    const found = hits(qTerms, `${f.claim} ${f.because ?? ''}`);
    return { fact: f, found, score: score(found, 2) };
  }).filter((m) => m.score > 0).sort((a, b) => b.score - a.score);

  // --- questions already answered --------------------------------------------
  const questions = analysis.questions.map((q) => {
    const inAsk = hits(qTerms, `${q.title} ${q.ask}`);
    const inProse = hits(qTerms, [q.answer, q.context, q.narrative].filter(Boolean).join(' '));
    // Involving a matched component counts, but only the strongly matched ones,
    // and never on its own: every question involves something.
    const involved = (q.involves ?? []).filter((id) => strongIds.has(id)).length;
    const found = new Set([...inAsk, ...inProse]);
    return { question: q, found, score: score(inAsk, 3) + score(inProse, 1) + involved * 0.5 };
  }).filter((m) => m.found.size > 0).sort((a, b) => b.score - a.score);

  // --- boundaries ------------------------------------------------------------
  const boundaries = (analysis.boundaries ?? []).map((b) => {
    const found = hits(qTerms, `${b.label} ${b.claim}`);
    const members = b.contains.filter((id) => matchedIds.has(id)).length;
    return { boundary: b, found, score: score(found, 2) + members };
  }).filter((m) => m.score > 0).sort((a, b) => b.score - a.score);

  // --- what the analysis never mentions ---------------------------------------
  const covered = new Set();
  for (const group of [components, relations, facts, questions, boundaries]) {
    for (const m of group) for (const t of m.found) covered.add(t);
  }
  for (const entry of usedTerms) for (const t of terms(entry.term).keys()) covered.add(t);
  const unmatched = [...qTerms.keys()].filter((t) => !covered.has(t)).map((t) => qTerms.get(t));

  // Coverage is by count, not weight: a term the analysis never uses has no
  // weight to contribute, and it is exactly the one that matters here.
  const asked = qTerms.size;
  const coverage = asked === 0 ? 0 : (asked - unmatched.length) / asked;

  return {
    question,
    terms: [...qTerms.values()],
    components,
    relations,
    facts,
    questions,
    boundaries,
    glossary: usedTerms,
    unmatched,
    coverage,
    idx,
    empty: components.length + relations.length + facts.length + questions.length === 0,
  };
}

/** The slice as text a person or a model can answer from. */
export function renderAsk(result, { limit = 8 } = {}) {
  const { idx } = result;
  const out = [];
  const w = (line = '') => out.push(line);
  const name = (id) => idx.components.get(id)?.name ?? id;
  const cite = (evidence) => (evidence?.length
    ? ` [${evidence.slice(0, 2).map((e) => `${e.path}${e.line ? `:${e.line}` : ''}`).join(', ')}]`
    : '');

  w(`asked    ${result.question}`);
  w();

  if (result.empty) {
    w('The analysis does not cover this. Nothing in it mentions: ' + (result.terms.join(', ') || 'anything in the question') + '.');
    w('Answer from the analysis only if the question can be rephrased in its terms; otherwise say so.');
    return `${out.join('\n')}\n`;
  }

  // The verdict first. What follows is what the analysis has near the question,
  // and when the question turns on words it never uses, that is the answer.
  if (result.coverage < 0.5) {
    w(`The analysis mostly does not cover this. It never mentions: ${result.unmatched.join(', ')}.`);
    w('What follows is what it has nearby; do not stretch it into an answer.');
    w();
  }

  if (result.questions.length) {
    w('Already answered, in part or whole:');
    for (const m of result.questions.slice(0, 3)) {
      const q = m.question;
      w(`  ${q.id}${q.shape === 'sequence' ? ' (sequence)' : ''}  ${q.title}`);
      w(`    asks    ${q.ask}`);
      if (q.answer) w(`    answer  ${q.answer}`);
    }
    w();
  }

  if (result.components.length) {
    w('Components:');
    for (const m of result.components.slice(0, limit)) {
      const c = m.component;
      const status = c.status && c.status !== 'built' ? ` (${c.status})` : '';
      w(`  ${c.id}${status}  ${c.name} — ${c.responsibility}${cite(c.evidence)}`);
    }
    w();
  }

  if (result.relations.length) {
    w('What moves between them:');
    for (const m of result.relations.slice(0, limit)) {
      const r = m.relation;
      const crossing = r.crosses ? ` (crosses ${idx.boundaries.get(r.crosses)?.label ?? r.crosses})` : '';
      const status = r.status && r.status !== 'built' ? ` (${r.status})` : '';
      w(`  ${name(r.from)} -> ${name(r.to)}${status} over ${r.mechanism}${crossing}: ${r.what_crosses ?? r.summary}${cite(r.evidence)}`);
    }
    w();
  }

  if (result.boundaries.length) {
    w('Boundaries:');
    for (const m of result.boundaries.slice(0, 3)) {
      const b = m.boundary;
      w(`  ${b.label} (${b.kind}) — ${b.claim}. Contains: ${b.contains.map(name).join(', ')}`);
    }
    w();
  }

  if (result.facts.length) {
    w('Facts:');
    for (const m of result.facts.slice(0, limit)) {
      const f = m.fact;
      w(`  ${f.kind}  ${f.claim}${f.because ? ` — ${f.because}` : ''}${cite(f.evidence)}`);
    }
    w();
  }

  if (result.glossary.length) {
    w('Terms:');
    for (const t of result.glossary) w(`  ${t.term} — ${t.definition}`);
    w();
  }

  if (result.unmatched.length) {
    w(`Not in the analysis: ${result.unmatched.join(', ')}. If the answer turns on these, the analysis does not have it.`);
  } else {
    w('Every term in the question is covered above.');
  }
  return `${out.join('\n')}\n`;
}
