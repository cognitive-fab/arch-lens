// What changed between two analyses.
//
// Two readings of the same system, and the question is what moved: which
// components appeared or went, which were built since the last reading, which
// edges are new, what a boundary now claims. The renderer can draw the visual
// difference for one question; this is the difference in the claims, which is
// the part a reviewer of an architecture change actually has to sign off on.

const byId = (list, key = 'id') => new Map((list ?? []).map((x) => [x[key], x]));
const edgeKey = (r) => `${r.from}>${r.to}`;

const FIELDS = {
  component: ['name', 'kind', 'responsibility', 'detail', 'status', 'layer'],
  relation: ['mechanism', 'summary', 'what_crosses', 'status', 'crosses', 'synchronous'],
  boundary: ['kind', 'label', 'claim'],
  fact: ['kind', 'claim', 'because'],
  question: ['title', 'ask', 'answer', 'shape', 'omits'],
};

function changedFields(kind, a, b) {
  const out = [];
  for (const f of FIELDS[kind]) {
    if (JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null)) out.push({ field: f, from: a[f], to: b[f] });
  }
  return out;
}

function listDiff(kind, base, head, key) {
  const A = byId(base, key);
  const B = byId(head, key);
  const added = [...B.values()].filter((x) => !A.has(x[key]));
  const removed = [...A.values()].filter((x) => !B.has(x[key]));
  const changed = [];
  for (const [id, a] of A) {
    const b = B.get(id);
    if (!b) continue;
    const fields = changedFields(kind, a, b);
    if (fields.length) changed.push({ id, base: a, head: b, fields });
  }
  return { added, removed, changed };
}

/**
 * @param {object} base  the earlier analysis
 * @param {object} head  the later one
 */
export function diffAnalyses(base, head) {
  const withKey = (list) => (list ?? []).map((r) => ({ ...r, _key: edgeKey(r) }));
  const components = listDiff('component', base.components, head.components, 'id');
  const relations = listDiff('relation', withKey(base.relations), withKey(head.relations), '_key');
  const boundaries = listDiff('boundary', base.boundaries, head.boundaries, 'id');
  const facts = listDiff('fact', base.facts, head.facts, 'id');
  const questions = listDiff('question', base.questions, head.questions, 'id');

  // Membership changes are the interesting boundary change and not a field.
  for (const c of boundaries.changed) c.members = { added: [], removed: [] };
  const baseB = byId(base.boundaries);
  for (const b of head.boundaries ?? []) {
    const a = baseB.get(b.id);
    if (!a) continue;
    const added = b.contains.filter((id) => !a.contains.includes(id));
    const removed = a.contains.filter((id) => !b.contains.includes(id));
    if (added.length || removed.length) {
      let entry = boundaries.changed.find((c) => c.id === b.id);
      if (!entry) {
        entry = { id: b.id, base: a, head: b, fields: [] };
        boundaries.changed.push(entry);
      }
      entry.members = { added, removed };
    }
  }

  // Likewise a question that draws different components.
  const baseQ = byId(base.questions);
  for (const q of head.questions ?? []) {
    const a = baseQ.get(q.id);
    if (!a) continue;
    const added = (q.involves ?? []).filter((id) => !(a.involves ?? []).includes(id));
    const removed = (a.involves ?? []).filter((id) => !(q.involves ?? []).includes(id));
    if (added.length || removed.length) {
      let entry = questions.changed.find((c) => c.id === q.id);
      if (!entry) {
        entry = { id: q.id, base: a, head: q, fields: [] };
        questions.changed.push(entry);
      }
      entry.involves = { added, removed };
    }
  }

  const promoted = components.changed.filter((c) => c.fields.some((f) => f.field === 'status' && f.to === 'built'));
  const revision = {
    base: base.system.repository?.revision ?? null,
    head: head.system.repository?.revision ?? null,
  };

  const counts = [components, relations, boundaries, facts, questions].reduce((n, d) => n + d.added.length + d.removed.length + d.changed.length, 0);
  return { components, relations, boundaries, facts, questions, promoted, revision, same: counts === 0 };
}

export function renderDiff(result, base, head) {
  const out = [];
  const w = (line = '') => out.push(line);
  const nameIn = (analysis, id) => analysis.components.find((c) => c.id === id)?.name ?? id;
  const name = (id) => nameIn(head, id) ?? nameIn(base, id);

  if (result.revision.base || result.revision.head) {
    w(`revision ${(result.revision.base ?? '—').slice(0, 7)} -> ${(result.revision.head ?? '—').slice(0, 7)}`);
    w();
  }
  if (result.same) {
    w('No difference in the claims.');
    return `${out.join('\n')}\n`;
  }

  const section = (title, d, show) => {
    if (!d.added.length && !d.removed.length && !d.changed.length) return;
    w(`${title}: +${d.added.length} -${d.removed.length} ~${d.changed.length}`);
    for (const x of d.added) w(`  + ${show(x)}`);
    for (const x of d.removed) w(`  - ${show(x)}`);
    for (const c of d.changed) {
      w(`  ~ ${show(c.head)}`);
      for (const f of c.fields) w(`      ${f.field}: ${JSON.stringify(f.from ?? null)} -> ${JSON.stringify(f.to ?? null)}`);
      if (c.members?.added.length) w(`      now contains: ${c.members.added.map(name).join(', ')}`);
      if (c.members?.removed.length) w(`      no longer contains: ${c.members.removed.map(name).join(', ')}`);
      if (c.involves?.added.length) w(`      now draws: ${c.involves.added.map(name).join(', ')}`);
      if (c.involves?.removed.length) w(`      no longer draws: ${c.involves.removed.map(name).join(', ')}`);
    }
    w();
  };

  if (result.promoted.length) {
    w('Built since the base analysis:');
    for (const c of result.promoted) w(`  ${c.head.name}`);
    w();
  }
  section('Components', result.components, (c) => `${c.id}  ${c.name}${c.status && c.status !== 'built' ? ` (${c.status})` : ''}`);
  section('Relations', result.relations, (r) => `${name(r.from)} -> ${name(r.to)}: ${r.summary}`);
  section('Boundaries', result.boundaries, (b) => `${b.id}  ${b.label}`);
  section('Facts', result.facts, (f) => `${f.id}  ${f.kind}: ${f.claim}`);
  section('Questions', result.questions, (q) => `${q.id}  ${q.title}`);
  return `${out.join('\n')}\n`;
}
