// A change, read against the architecture.
//
// The moment an architecture document earns its keep is not when it is written
// but when a change might contradict it. This takes the files a change touches
// and answers, from the analysis alone: which components those files are
// evidence for, which diagrams show them, which boundaries the change spans and
// what those boundaries claim, which relations between the touched components a
// reviewer should re-read, and — the part a diagram never says — which changed
// files the analysis has no component for at all.
//
// It is a reading, not a verdict. Nothing here knows what the diff does; it
// knows what the analysis says about the places the diff went, and it hands
// that to whoever is reviewing so they check the change against the claims
// rather than against their memory of them.

import { index } from './model.mjs';

/**
 * @typedef {{path: string, status?: string, hunks?: Array<[number, number]>}} Change
 *   One changed file, repository-relative, with the line ranges the change
 *   touches when known. `status` is git's letter: M, A, D, R.
 */

/**
 * Does a change fall under a piece of evidence? A directory cited as evidence
 * covers everything beneath it; a file covers itself; a line range covers
 * only a change that overlaps it.
 */
function covers(evidence, change) {
  const cited = evidence.path.replace(/\/+$/, '');
  const inside = change.path === cited || change.path.startsWith(`${cited}/`);
  if (!inside) return null;
  if (!evidence.line) return 'file';
  const from = evidence.line;
  const to = evidence.end_line ?? evidence.line;
  const hunks = change.hunks ?? [];
  if (hunks.length === 0) return 'file'; // lines unknown; the file is the best we have
  return hunks.some(([a, b]) => a <= to && b >= from) ? 'lines' : 'near';
}

/**
 * Read a set of changes against the analysis.
 *
 * @param {object} analysis
 * @param {Change[]} changes
 * @param {{exists?: (path: string) => boolean}} [options]  how to check that an
 *   evidence path still exists after the change; omit to skip that check
 */
export function review(analysis, changes, options = {}) {
  const idx = index(analysis);
  const { exists } = options;

  // --- which components the change is evidence for ---------------------------
  const touched = new Map(); // id -> { component, files: Map<path, strength> }
  const claimed = new Set();
  for (const c of analysis.components) {
    for (const e of c.evidence ?? []) {
      for (const change of changes) {
        const how = covers(e, change);
        if (!how) continue;
        claimed.add(change.path);
        if (how === 'near') continue; // the file is cited, but not the lines that moved
        if (!touched.has(c.id)) touched.set(c.id, { component: c, files: new Map() });
        const files = touched.get(c.id).files;
        if (files.get(change.path) !== 'lines') files.set(change.path, how);
      }
    }
  }
  const touchedIds = new Set(touched.keys());

  // Relations carry evidence too, and a change at a relation's cited lines is
  // a change to the edge itself, which is the thing most worth a second look.
  const relationsChanged = [];
  for (const r of (analysis.relations ?? [])) {
    for (const e of r.evidence ?? []) {
      for (const change of changes) {
        const how = covers(e, change);
        if (how && how !== 'near') {
          claimed.add(change.path);
          relationsChanged.push({ relation: r, path: change.path, how });
        }
      }
    }
  }

  // --- what the touched components are part of -------------------------------
  const questions = analysis.questions
    .map((q) => ({ question: q, touched: (q.involves ?? []).filter((id) => touchedIds.has(id)) }))
    .filter((m) => m.touched.length > 0);

  const boundaries = (analysis.boundaries ?? [])
    .map((b) => ({ boundary: b, touched: b.contains.filter((id) => touchedIds.has(id)) }))
    .filter((m) => m.touched.length > 0);

  // Relations between two touched components: the change may have altered what
  // crosses. Relations that leave a touched component for another boundary: the
  // change may have altered whether the boundary's claim still holds.
  const relationsBetween = (analysis.relations ?? []).filter((r) => touchedIds.has(r.from) && touchedIds.has(r.to));
  const crossingsFrom = (analysis.relations ?? []).filter((r) => r.crosses && (touchedIds.has(r.from) || touchedIds.has(r.to)) && !relationsBetween.includes(r));

  // Facts attached to the questions the change lands in, guarantees and
  // constraints first: those are the claims a change can break.
  const factIds = new Set(questions.flatMap((m) => m.question.facts ?? []));
  const order = { guarantee: 0, constraint: 1, doctrine: 2, tradeoff: 3, risk: 4 };
  const facts = [...factIds].map((id) => idx.facts.get(id)).filter(Boolean)
    .sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));

  // --- what the analysis does not know about ----------------------------------
  const uncovered = changes.filter((c) => !claimed.has(c.path)).map((c) => c.path);

  // --- evidence the change removed ---------------------------------------------
  const deleted = new Set(changes.filter((c) => c.status === 'D').map((c) => c.path));
  const gone = [];
  for (const c of analysis.components) {
    for (const e of c.evidence ?? []) {
      const path = e.path.replace(/\/+$/, '');
      const removed = deleted.has(path) || (exists ? !exists(path) : false);
      if (removed) gone.push({ component: c, path });
    }
  }

  return {
    changes,
    touched: [...touched.values()].map((t) => ({ component: t.component, files: [...t.files].map(([path, how]) => ({ path, how })) })),
    relationsChanged,
    questions,
    boundaries,
    relationsBetween,
    crossingsFrom,
    facts,
    uncovered,
    gone,
    idx,
    quiet: touched.size === 0 && relationsChanged.length === 0 && gone.length === 0,
  };
}

/** The reading, as text a reviewer or the model can work from. */
export function renderReview(result) {
  const { idx } = result;
  const out = [];
  const w = (line = '') => out.push(line);
  const name = (id) => idx.components.get(id)?.name ?? id;

  w(`changed  ${result.changes.length} file(s)`);
  w();

  if (result.gone.length) {
    w('Evidence this change removes — the analysis now points at nothing:');
    for (const g of result.gone) w(`  ${g.component.id}  ${g.component.name} cited ${g.path}`);
    w('  Update the evidence, or the component, before the analysis is trusted again.');
    w();
  }

  if (result.quiet) {
    w('The change touches nothing the analysis has evidence for.');
    w();
  } else if (result.touched.length) {
    w('Components the change is evidence for:');
    for (const t of result.touched) {
      const c = t.component;
      const status = c.status && c.status !== 'built' ? ` (${c.status})` : '';
      const where = t.files.map((f) => `${f.path}${f.how === 'lines' ? ' at the cited lines' : ''}`).join(', ');
      w(`  ${c.id}${status}  ${c.name} — ${c.responsibility}`);
      w(`      via ${where}`);
    }
    w();
  }

  if (result.relationsChanged.length) {
    w('Relations whose cited code changed — re-read what_crosses:');
    for (const m of result.relationsChanged) {
      const r = m.relation;
      w(`  ${name(r.from)} -> ${name(r.to)}: ${r.what_crosses ?? r.summary}  [${m.path}]`);
    }
    w();
  }

  if (result.boundaries.length) {
    const spans = result.boundaries.length > 1;
    w(spans ? `The change spans ${result.boundaries.length} boundaries. Each one claims:` : 'The change is inside one boundary, which claims:');
    for (const m of result.boundaries) {
      w(`  ${m.boundary.label} — ${m.boundary.claim}`);
      w(`      touched: ${m.touched.map(name).join(', ')}`);
    }
    w();
  }

  if (result.relationsBetween.length) {
    w('Relations between touched components — is what crosses still what the analysis says?');
    for (const r of result.relationsBetween) {
      const crossing = r.crosses ? ` (crosses ${idx.boundaries.get(r.crosses)?.label ?? r.crosses})` : '';
      w(`  ${name(r.from)} -> ${name(r.to)} over ${r.mechanism}${crossing}: ${r.what_crosses ?? r.summary}`);
    }
    w();
  }

  if (result.crossingsFrom.length) {
    w('Boundary crossings from a touched component — does the boundary claim still hold?');
    for (const r of result.crossingsFrom) {
      w(`  ${name(r.from)} -> ${name(r.to)} crosses ${idx.boundaries.get(r.crosses)?.label ?? r.crosses}: ${r.what_crosses ?? r.summary}`);
    }
    w();
  }

  if (result.facts.length) {
    w('Claims the change lands on:');
    for (const f of result.facts) w(`  ${f.kind}  ${f.claim}${f.because ? ` — ${f.because}` : ''}`);
    w();
  }

  if (result.questions.length) {
    w('Diagrams that show what changed — re-render and re-read:');
    for (const m of result.questions) {
      w(`  ${m.question.id}  ${m.question.title}  (${m.touched.map(name).join(', ')})`);
    }
    w();
  }

  if (result.uncovered.length) {
    w('Changed files the analysis has no component for:');
    for (const p of result.uncovered) w(`  ${p}`);
    w('  Either the change is outside the architecture, or the analysis is missing a component. Say which.');
    w();
  }

  return `${out.join('\n')}\n`;
}
