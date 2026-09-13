// A question with an order to it, rendered as a sequence.
//
// Half the questions worth asking of a system are not "what are the parts" but
// "what happens when": a commit, a request, a restore. An architecture diagram
// answers those badly, because a box-and-arrow graph has no time axis and the
// reader has to reconstruct the order from the labels. A sequence has the order
// built in, and nothing else.
//
// The same model feeds it. A question that declares `shape: "sequence"` lists
// its `steps` in order, and every step is an exchange along a relation the
// analysis already declares — the compiler refuses one that is not, because a
// sequence that shows a message the model says never crosses is a story, not a
// projection. What changes is only what gets drawn: participants instead of
// nodes, messages instead of edges, phases instead of boundaries.

import { index } from './model.mjs';
import { TYPE_OF, MECHANISM_HINT, cardsFor, viewsFor, shorten } from './compile.mjs';

/** Vertical rhythm, in viewBox units. archify refuses a message above y=160. */
const FIRST_Y = 190;
const STEP_Y = 40;
const PHASE_GAP = 26;
const PHASE_PAD = 20;
const BOTTOM = 100; // the renderer keeps the last ~85 units for the lifeline feet

/**
 * The renderer fits the diagram to the reader's width and lets the height
 * follow, exactly as it does for an architecture: at 1440x900, once the toolbar
 * and the cards have taken their share, a sequence taller than about half its
 * width runs off the bottom. So the width is derived from the height, never the
 * other way round, and a long sequence gets wider rather than taller.
 */
const MIN_ASPECT = 2.05;
const MIN_WIDTH = 820;
const PER_PARTICIPANT = 140;

/**
 * A participant's detail line is set at 7px in the renderer's own units and is
 * not budgeted by width the way a node's is. Scaled into 930px of desktop it
 * survives only while the viewBox is narrower than this; past it, the line is
 * dropped whole rather than shipped unreadable, and the report says so.
 */
const DETAIL_MAX_WIDTH = Math.floor((7 * 930) / 6);

const VARIANT_OF_KIND = {
  call: null,
  return: 'return',
  async: 'dashed',
};

/**
 * Compile one sequence-shaped question into an archify sequence specification.
 *
 * @param {object} analysis
 * @param {object} question  already known to have shape "sequence"
 * @returns {{spec: object, dropped: string[], question: object}}
 */
export function compileSequence(analysis, question) {
  const idx = index(analysis);
  const dropped = [];
  const inScope = new Set(question.involves);
  const highlight = new Set(question.highlight || []);

  // What the question touches but does not involve, for the card. The same rule
  // as an architecture: nothing vanishes without being named.
  const outside = new Set();
  for (const r of (analysis.relations ?? [])) {
    const a = inScope.has(r.from);
    const b = inScope.has(r.to);
    if (a !== b) outside.add(a ? r.to : r.from);
  }
  const omitted = [...outside].map((id) => idx.components.get(id)?.name ?? id);
  if (omitted.length) dropped.push(`out of scope, named in the card: ${omitted.join(', ')}`);

  // A sequence has lifelines, not regions. A boundary that would have been drawn
  // is said aloud instead, so the reader knows the picture lost it on purpose.
  for (const b of analysis.boundaries || []) {
    const present = b.contains.filter((id) => inScope.has(id));
    if (present.length >= 2) dropped.push(`boundary "${b.id}" not drawn: a sequence has no regions`);
  }
  if (analysis.system.repository) {
    dropped.push('source links not carried: the renderer verifies evidence on architecture diagrams only');
  }

  // --- messages, in the order the question gave them -----------------------
  const steps = question.steps;
  const ys = [];
  const segments = [];
  let y = FIRST_Y;
  let phase = null;
  let phaseStart = null;
  const closePhase = (lastY) => {
    if (phase !== null) segments.push({ from: phaseStart - PHASE_PAD, to: lastY + PHASE_PAD, label: phase });
  };
  steps.forEach((step, i) => {
    const next = step.phase ?? null;
    if (i > 0 && next !== phase) {
      closePhase(ys[i - 1]);
      y += PHASE_GAP;
    }
    if (next !== phase) {
      phase = next;
      phaseStart = y;
    }
    ys.push(y);
    y += STEP_Y;
  });
  closePhase(ys[ys.length - 1]);

  const relationOf = (from, to) => (analysis.relations ?? []).find((r) => r.from === from && r.to === to);
  const messages = steps.map((step, i) => {
    const relation = relationOf(step.from, step.to) ?? relationOf(step.to, step.from);
    const spec = {
      id: `s${i + 1}`,
      from: step.from,
      to: step.to,
      y: ys[i],
      label: messageLabel(step, relation),
    };
    const variant = variantFor(step, relation, highlight);
    if (variant) spec.variant = variant;
    if (step.note) spec.note = step.note;
    return spec;
  });

  // Idle lifelines are allowed — a participant can be there to be pointedly
  // not spoken to — but they are worth a line, because usually it is a step the
  // author forgot.
  const touched = new Set(steps.flatMap((s) => [s.from, s.to]));
  const idle = question.involves.filter((id) => !touched.has(id));
  if (idle.length) {
    dropped.push(`idle: ${idle.map((id) => idx.components.get(id)?.name ?? id).join(', ')} take part in no step`);
  }

  // --- proportion -----------------------------------------------------------
  const height = ys[ys.length - 1] + BOTTOM;
  const width = Math.max(MIN_WIDTH, question.involves.length * PER_PARTICIPANT, Math.ceil(height * MIN_ASPECT));

  const withDetail = width <= DETAIL_MAX_WIDTH;
  if (!withDetail) {
    dropped.push(`participant detail not shown: ${steps.length} steps make the sequence wider than the detail line stays readable at`);
  }
  const participants = question.involves.map((id) => {
    const c = idx.components.get(id);
    const spec = { id: c.id, type: TYPE_OF[c.kind] ?? 'backend', label: c.name };
    const detail = withDetail ? shorten(c.detail ?? c.responsibility ?? '', 28) : '';
    if (detail) spec.sublabel = detail;
    return spec;
  });

  // --- activations ------------------------------------------------------------
  // A participant is busy from the first message that reaches it to the last
  // that leaves it. That is a claim about span, not about blocking, and it is
  // only made when there are two messages to span.
  const activations = [];
  for (const id of question.involves) {
    const mine = messages.filter((m) => m.from === id || m.to === id);
    if (mine.length < 2) continue;
    activations.push({
      participant: id,
      from: mine[0].y - 5,
      to: mine[mine.length - 1].y + 6,
      type: participants.find((p) => p.id === id).type,
    });
  }

  const cards = cardsFor(question, analysis, idx, omitted);
  const views = viewsFor(question, analysis, inScope);
  const legend = legendFor(analysis);

  const spec = {
    schema_version: 1,
    diagram_type: 'sequence',
    meta: {
      title: question.title,
      quality_profile: 'showcase',
      viewBox: [width, height],
      column_fit: 'spread',
      ...(legend ? { legend } : {}),
      ...(views.length ? { views } : {}),
    },
    participants,
    ...(segments.some((s) => s.label) ? { segments: segments.filter((s) => s.label) } : {}),
    messages,
    ...(activations.length ? { activations } : {}),
    ...(cards.length ? { cards } : {}),
  };

  return { spec, dropped, question };
}

/**
 * archify's own legend names the line styles after a web request. On a
 * projection of an analysis they mean something more specific, and the legend
 * should say what.
 */
const SEQUENCE_LEGEND = {
  emphasis: 'the answer’s path',
  return: 'reply',
  dashed: 'async or planned',
  security: 'crosses a boundary',
  default: 'message',
};

/**
 * A sequence legend names line styles, not box types, so `system.legend` is
 * consulted only for the keys a sequence has. An author who relabelled
 * "Backend" for a paper has said nothing about what a dashed arrow means.
 */
function legendFor(analysis) {
  const merged = { ...SEQUENCE_LEGEND };
  for (const key of Object.keys(SEQUENCE_LEGEND)) {
    const label = analysis.system.legend?.[key];
    if (typeof label === 'string' && label.trim()) merged[key] = label.trim();
  }
  return { entries: Object.fromEntries(Object.entries(merged).map(([k, label]) => [k, { label }])) };
}

/**
 * The step says what crosses; the relation says how. The mechanism is appended
 * only when it fits, for the same reason as on an edge label.
 */
function messageLabel(step, relation) {
  const text = step.says ?? relation?.summary ?? '';
  const hint = relation ? MECHANISM_HINT[relation.mechanism] : null;
  if (!hint || step.kind === 'return') return text;
  const combined = `${text} · ${hint}`;
  return combined.length <= 34 ? combined : text;
}

function variantFor(step, relation, highlight) {
  const own = VARIANT_OF_KIND[step.kind ?? 'call'];
  if (own) return own;
  if (relation?.status === 'planned') return 'dashed';
  if (relation?.crosses) return 'security';
  if (highlight.has(step.from) && highlight.has(step.to)) return 'emphasis';
  if (relation?.mechanism === 'event' || relation?.mechanism === 'queue') return 'dashed';
  return null;
}

/**
 * Vertical containment is judged in a browser after delivery. A sequence cannot
 * pull its rows together — the renderer owns the message rhythm — so it takes
 * the other lever and widens, which the reader's fit-to-width turns into a
 * shorter picture.
 */
export function widenSequence(spec, factor = 1.15) {
  const [w, h] = spec.meta.viewBox;
  spec.meta.viewBox = [Math.ceil(w * factor), h];
  return spec;
}
