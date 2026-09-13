// Analysis in, archify specification out. One diagram per question.
//
// This is the lossy step and it is meant to be. The analysis distinguishes
// twenty kinds of component and twelve mechanisms; the renderer has seven types
// and four line variants. Rather than pretend, the compiler narrows explicitly
// and RECORDS what it dropped, so the caller can print it.
//
// The scoping rule is the part that makes diagrams mean something. A question
// names the components it involves; everything else is either omitted or, when
// an involved component talks to it, collapsed into one honest "elsewhere" node.
// A diagram that shows every component answers no question at all.

import { layout, detailBudget, NODE_W, NODE_H } from './layout.mjs';
import { index } from './model.mjs';
import { compileSequence } from './sequence.mjs';

/** Twenty kinds of thing, seven boxes. Stated once, here. */
export const TYPE_OF = {
  cli: 'frontend',
  ui: 'frontend',
  api: 'backend',
  service: 'backend',
  worker: 'backend',
  library: 'backend',
  engine: 'backend',
  workflow: 'backend',
  broker: 'backend',
  store: 'database',
  'file-store': 'database',
  cache: 'database',
  schema: 'database',
  config: 'database',
  queue: 'messagebus',
  sandbox: 'security',
  gateway: 'security',
  'model-provider': 'external',
  'external-service': 'external',
  'third-party': 'external',
};

/**
 * What the seven boxes are called when the subject is not software.
 *
 * The shapes are archify's and they are fine — a paper has inputs, methods,
 * data and prior work, and they want distinguishing exactly as much as a
 * frontend and a database do. What is wrong on a paper is the *wording*:
 * "Backend" under a box that stands for a training procedure tells a reader
 * something false about what they are looking at. Only the labels change; the
 * geometry, the colours and the compiler are untouched.
 *
 * These are defaults, not doctrine. `system.legend` overrides any of them.
 */
const DOMAIN_LEGEND = {
  document: {
    frontend: 'Input',
    backend: 'Method',
    database: 'Data',
    messagebus: 'Signal',
    security: 'Constraint',
    cloud: 'Environment',
    external: 'Prior work',
  },
};

const CARD_DOT = {
  answer: 'cyan',
  doctrine: 'emerald',
  guarantee: 'rose',
  constraint: 'amber',
  tradeoff: 'violet',
  risk: 'orange',
  omits: 'slate',
};

export const MECHANISM_HINT = {
  http: 'HTTP',
  https: 'HTTPS',
  grpc: 'gRPC',
  stdio: 'stdio',
  spawn: 'spawn',
  file: 'file',
  database: 'SQL',
  queue: 'queue',
  event: 'event',
  signal: 'signal',
  manual: 'manual',
  'in-process call': null,
};

const TRAILING = /(?:[\s,;:·+\-\/]|\b(?:a|an|and|as|at|by|for|from|in|into|of|on|or|the|to|with|your|its|their)\b)+$/i;

const ELSEWHERE = 'elsewhere';

/**
 * Compile one question into an archify specification: an architecture by
 * default, a sequence when the question says so. The scoping rules are the same
 * either way; what differs is whether the picture has a time axis.
 *
 * @param {object} analysis
 * @param {string} questionId
 * @param {{collapse?: boolean}} [options]
 * @returns {{spec: object, dropped: string[], question: object}}
 */
export function compileQuestion(analysis, questionId, options = {}) {
  const { collapse = false } = options;
  const idx = index(analysis);
  const question = analysis.questions.find((q) => q.id === questionId);
  if (!question) throw new Error(`no question "${questionId}" in this analysis`);
  if (question.shape === 'sequence') return compileSequence(analysis, question);

  const dropped = [];
  const omitted = [];
  const inScope = new Set(question.involves);
  const highlight = new Set(question.highlight || []);

  // Relations with both ends in scope are drawn. Relations with one end in
  // scope either vanish or become an edge to "elsewhere" — never silently.
  const drawn = [];
  const outside = new Set();
  for (const r of analysis.relations) {
    const a = inScope.has(r.from);
    const b = inScope.has(r.to);
    if (a && b) drawn.push(r);
    else if (a !== b) outside.add(a ? r.to : r.from);
  }

  const usesElsewhere = collapse && outside.size > 0;
  if (usesElsewhere) {
    const names = [...outside].map((id) => idx.components.get(id)?.name ?? id);
    dropped.push(`collapsed into "elsewhere": ${names.join(', ')}`);
    for (const r of analysis.relations) {
      const a = inScope.has(r.from);
      const b = inScope.has(r.to);
      if (a === b) continue;
      drawn.push({
        ...r,
        from: a ? r.from : ELSEWHERE,
        to: a ? ELSEWHERE : r.to,
        summary: r.summary,
        _collapsed: true,
      });
    }
  } else if (outside.size > 0) {
    const names = [...outside].map((id) => idx.components.get(id)?.name ?? id);
    omitted.push(...names);
    dropped.push(`out of scope, named in the card: ${names.join(', ')}`);
  }

  // One edge per pair once collapsed, or the renderer draws a bundle.
  const seen = new Set();
  let merged = 0;
  const relations = drawn.filter((r) => {
    const key = `${r.from}>${r.to}`;
    if (seen.has(key)) {
      merged += 1;
      return false;
    }
    seen.add(key);
    return true;
  });
  if (merged > 0) {
    dropped.push(`merged ${merged} relation${merged === 1 ? '' : 's'} that became parallel edges once collapsed`);
  }

  const nodes = question.involves.map((id) => idx.components.get(id));
  if (usesElsewhere) {
    nodes.push({
      id: ELSEWHERE,
      name: 'Elsewhere',
      kind: 'library',
      responsibility: 'Everything this question does not ask about.',
      detail: `${outside.size} more component${outside.size === 1 ? '' : 's'}`,
      status: 'built',
    });
  }

  // Which boundaries will actually be drawn has to be settled BEFORE layout.
  // A boundary that gets dropped for having one member in view must not still
  // push that member into a band of its own: that reserves a whole row band for
  // a box nobody will see, and drags every edge to it across the picture.
  const boundaries = boundariesFor(analysis, inScope, dropped);
  const drawnBoundaryOf = new Map();
  for (const b of boundaries) for (const id of b.wraps) drawnBoundaryOf.set(id, b.label);

  // Choose a width the node text can survive at, before writing any of it.
  //
  // The renderer scales the whole diagram to fit a desktop and then rejects text
  // that lands below six pixels, so a wide diagram silently costs every node its
  // detail line. Pulling the columns together buys those characters back, and it
  // is a far better trade than truncating six labels into fragments.
  let placed = layout(nodes, relations, { layers: analysis.layers, boundaryOf: drawnBoundaryOf });
  let budget = detailBudget(placed.width);
  const wanted = (c) => (c.detail ?? c.responsibility ?? '').length;
  const overBudget = () => nodes.filter((c) => wanted(c) > budget).length;

  for (const gapX of [140, 115, 95]) {
    if (overBudget() <= 1) break;
    const tighter = layout(nodes, relations, { layers: analysis.layers, boundaryOf: drawnBoundaryOf, gapX });
    const tighterBudget = detailBudget(tighter.width);
    if (tighterBudget <= budget) break;
    placed = tighter;
    budget = tighterBudget;
  }
  if (overBudget() > 0) {
    dropped.push(`shortened the detail on ${overBudget()} node(s) to stay readable at a 1440px desktop`);
  }
  const components = nodes.map((c) => {
    const spec = {
      id: c.id,
      type: TYPE_OF[c.kind] ?? 'backend',
      label: c.name,
      pos: placed.positions.get(c.id),
      size: [NODE_W, NODE_H],
    };
    const detail = shorten(c.detail ?? c.responsibility ?? '', budget);
    if (detail) spec.sublabel = detail;
    const marks = [];
    if (c.status && c.status !== 'built') marks.push(c.status);
    const ref = docRefFor(c, analysis);
    if (ref) marks.push(ref);
    if (marks.length) spec.tag = marks.join(' · ');
    const sources = sourcesFor(c, analysis);
    if (sources) spec.sources = sources;
    return spec;
  });

  const connections = relations.map((r) => {
    const route = placed.routes.get(`${r.from}>${r.to}`);
    const spec = {
      // A stable id, so two renders of the same analysis can be compared edge
      // by edge rather than by position.
      id: `${r.from}--${r.to}`,
      from: r.from,
      to: r.to,
      label: edgeLabel(r),
      ...(route ? { fromSide: route.fromSide, toSide: route.toSide, via: route.via } : {}),
      labelAt: placed.labels.get(`${r.from}>${r.to}`),
    };
    const variant = variantFor(r, highlight);
    if (variant) spec.variant = variant;
    return spec;
  });

  const cards = cardsFor(question, analysis, idx, omitted);
  const views = viewsFor(question, analysis, inScope);

  const spec = {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: {
      title: question.title,
      quality_profile: 'showcase',
      ...(analysis.system.repository ? { repository: analysis.system.repository } : {}),
      ...(legendFor(analysis) ? { legend: legendFor(analysis) } : {}),
      ...(views.length ? { views } : {}),
    },
    components,
    ...(boundaries.length ? { boundaries } : {}),
    connections,
    ...(cards.length ? { cards } : {}),
  };

  return { spec, dropped, question };
}

/** Compile every question. */
export function compileAll(analysis, options) {
  return analysis.questions.map((q) => ({ id: q.id, ...compileQuestion(analysis, q.id, options) }));
}

function variantFor(relation, highlight) {
  if (relation.status === 'planned') return 'dashed';
  if (relation.crosses) return 'security';
  if (highlight.has(relation.from) && highlight.has(relation.to)) return 'emphasis';
  if (relation.mechanism === 'event' || relation.mechanism === 'queue') return 'dashed';
  return null;
}

/**
 * The edge label. `summary` says what the relation is for; the mechanism is
 * appended only when it fits, because the renderer's clearance rules punish a
 * long label far more than a reader punishes a missing protocol name.
 */
function edgeLabel(relation) {
  const hint = MECHANISM_HINT[relation.mechanism];
  const summary = relation.summary;
  if (!hint) return summary;
  const combined = `${summary} · ${hint}`;
  return combined.length <= 34 ? combined : summary;
}

/**
 * Fit text to a budget on a word boundary. A trailing comma left behind by the
 * trim reads as a truncation bug rather than an abbreviation, so it goes too.
 *
 * When not even the first word fits, the answer is nothing, not a stump: a
 * reader can forgive a missing detail line and cannot forgive "replicat". The
 * caller drops the line and says so.
 */
export function shorten(text, budget) {
  if (!text) return '';
  const clean = text.replace(/\.$/, '').trim();
  if (clean.length <= budget) return clean;
  const words = clean.split(/\s+/);
  let out = '';
  for (const word of words) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > budget) break;
    out = next;
  }
  return out.replace(TRAILING, '');
}

/**
 * The section a component was read from, short enough to sit under the node.
 *
 * Only the first reference: a node has one line for this, and a component that
 * needs three citations is telling you it should be two components. The rest
 * survive in the generated document, which has room.
 */
function docRefFor(component, analysis) {
  if (analysis.system.domain !== 'document') return null;
  const ref = component.doc_refs?.find((d) => d.section);
  return ref ? ref.section.slice(0, 24) : null;
}

/**
 * Legend label overrides, or null to leave archify's own wording alone.
 *
 * Built from the domain default and then from `system.legend`, so an author can
 * take the defaults, correct one word, and keep the rest.
 */
function legendFor(analysis) {
  const defaults = DOMAIN_LEGEND[analysis.system.domain] ?? {};
  const merged = { ...defaults, ...(analysis.system.legend ?? {}) };
  const entries = Object.fromEntries(
    Object.entries(merged)
      .filter(([, label]) => typeof label === 'string' && label.trim())
      .map(([kind, label]) => [kind, { label: label.trim() }]),
  );
  return Object.keys(entries).length ? { entries } : null;
}

/**
 * Source links are only emitted when they can actually be verified.
 *
 * For a document that means something different from a repository. There is no
 * revision to pin and no line to resolve, so the reference is the section the
 * claim came from, carried as the badge's label. The path still has to be the
 * document itself, which keeps the link answerable: a reader can open it and
 * find the section named.
 */
function sourcesFor(component, analysis) {
  // A document has no revision to pin, and archify's `sources` is repository
  // evidence by contract — it refuses to render without /meta/repository. The
  // section reference goes on the node's tag instead, where a reader looking at
  // the box can see which part of the paper it came from.
  if (analysis.system.domain === 'document') return null;
  if (!analysis.system.repository) return null;
  if (!component.evidence || component.evidence.length === 0) return null;
  return component.evidence.slice(0, 3).map((e) => ({
    path: e.path,
    ...(e.line ? { line: e.line } : {}),
    ...(e.end_line ? { end_line: e.end_line } : {}),
    ...(e.label ? { label: e.label } : {}),
  }));
}

/**
 * A boundary is drawn only when every member it has in this question is present
 * AND it still holds at least two of them; a one-node box states nothing the
 * node does not already state.
 */
function boundariesFor(analysis, inScope, dropped) {
  const out = [];
  for (const b of analysis.boundaries || []) {
    const present = b.contains.filter((id) => inScope.has(id));
    if (present.length === 0) continue;
    if (present.length < 2) {
      dropped.push(`boundary "${b.id}" not drawn: only one of its members is in this view`);
      continue;
    }
    if (present.length < b.contains.length) {
      dropped.push(`boundary "${b.id}" drawn around ${present.length} of ${b.contains.length} members`);
    }
    out.push({
      kind: b.kind === 'trust' || b.kind === 'licence' ? 'security-group' : 'region',
      label: `${b.label} — ${b.claim}`.length <= 90 ? `${b.label} — ${b.claim}` : b.label,
      wraps: present,
      pad: 20,
    });
  }
  return out;
}

/**
 * Three cards fit beside a diagram. The order they are built in is the order
 * they survive in, so what a view LEAVES OUT is built before the supporting
 * facts: an omission the reader cannot see is the one thing a diagram must never
 * drop, and an earlier version of this quietly did exactly that.
 */
export function cardsFor(question, analysis, idx, omitted = []) {
  const cards = [];

  if (question.answer) {
    cards.push({
      dot: CARD_DOT.answer,
      title: 'The short answer',
      items: sentences(question.answer).slice(0, 3),
    });
  }

  if (question.omits || omitted.length) {
    const items = question.omits ? sentences(question.omits) : [];
    if (omitted.length) items.push(`Connected but out of scope: ${omitted.slice(0, 6).join(', ')}`);
    cards.push({ dot: CARD_DOT.omits, title: 'Not shown here', items: items.slice(0, 3) });
  }

  const chosen = (question.facts || []).map((id) => idx.facts.get(id)).filter(Boolean);
  const byKind = new Map();
  for (const f of chosen) {
    if (!byKind.has(f.kind)) byKind.set(f.kind, []);
    byKind.get(f.kind).push(f);
  }
  for (const [kind, facts] of byKind) {
    if (cards.length >= 3) break;
    cards.push({
      dot: CARD_DOT[kind] ?? 'slate',
      title: titleFor(kind),
      items: facts.slice(0, 3).map((f) => (f.because ? `${f.claim} — ${f.because}` : f.claim)),
    });
  }

  return cards.slice(0, 3);
}

const titleFor = (kind) => ({
  doctrine: 'Doctrine',
  guarantee: 'What it guarantees',
  constraint: 'Constraints',
  tradeoff: 'Trade-offs',
  risk: 'Risks',
}[kind] ?? kind);

function sentences(text) {
  return String(text)
    .split(/(?<=[.;])\s+/)
    .map((s) => s.replace(/[.;]$/, '').trim())
    .filter(Boolean);
}

/**
 * Guided views: one per boundary in the picture, plus the highlight set. Capped
 * at four so the strip stays readable, and only emitted when a view would show
 * strictly fewer nodes than the diagram already does.
 */
export function viewsFor(question, analysis, inScope) {
  const views = [];
  if (question.highlight && question.highlight.length >= 2 && question.highlight.length < inScope.size) {
    views.push({
      id: 'answer',
      label: clamp(question.title, 48),
      focus: question.highlight,
      note: clamp(question.answer || question.ask, 140),
    });
  }
  for (const b of analysis.boundaries || []) {
    if (views.length >= 4) break;
    const present = b.contains.filter((id) => inScope.has(id));
    if (present.length < 2 || present.length >= inScope.size) continue;
    views.push({
      id: b.id,
      label: clamp(b.label, 48),
      focus: present,
      note: clamp(b.claim, 140),
    });
  }
  return views;
}

const clamp = (text, max) => {
  const clean = String(text).trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
};
