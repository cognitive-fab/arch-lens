// The repair loop: let the renderer's complaints drive the edits.
//
// This is the piece that pays for the whole plugin. archify's diagnostics are
// unusually good — a label collision arrives with the exact `labelAt` that would
// resolve it, a readability failure arrives with the projected font size and the
// floor it missed — and a person reading those and editing JSON by hand is doing
// arithmetic a loop should do. Every fix below is mechanical and reversible.
//
// The stopping rule is archify's own: keep going while the objective error count
// reaches a NEW MINIMUM, and stop after two rounds that do not improve it. That
// avoids the failure mode where two constraints fight and each round "fixes" the
// other's fix forever.

import { writeFileSync } from 'node:fs';
import { validate } from './archify.mjs';

const TRAILING = /(?:[\s,;:·+\-\/]|\b(?:a|an|and|as|at|by|for|from|in|into|of|on|or|the|to|with|your|its|their)\b)+$/i;

const MAX_ROUNDS = 10;
const STALL_LIMIT = 2;

/**
 * Validate a spec and repair it until it passes or stops improving.
 *
 * @param {object} spec  archify architecture specification, mutated in place
 * @param {string} specPath  where to write it between rounds
 * @param {{repoRoot?: string, onRound?: Function}} options
 * @returns {{ok: boolean, rounds: number, report: object, applied: string[], unresolved: object[]}}
 */
export function repair(spec, specPath, options = {}) {
  const { repoRoot, onRound } = options;
  const applied = [];
  let best = Infinity;
  let stalls = 0;
  let report = null;

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    writeSpec(specPath, spec);
    report = validate(specPath, { repoRoot });
    const diagnostics = collect(report);
    const count = diagnostics.length;
    if (onRound) onRound({ round, count, diagnostics });

    if (report.ok) return { ok: true, rounds: round, report, applied, unresolved: [] };

    if (count < best) {
      best = count;
      stalls = 0;
    } else {
      stalls += 1;
      if (stalls > STALL_LIMIT) break;
    }

    const changes = applyAll(spec, diagnostics);
    if (changes.length === 0) break; // nothing here knows how to fix this
    applied.push(...changes.map((c) => `round ${round}: ${c}`));
  }

  writeSpec(specPath, spec);
  report = validate(specPath, { repoRoot });
  return {
    ok: Boolean(report.ok),
    rounds: MAX_ROUNDS,
    report,
    applied,
    unresolved: collect(report),
  };
}

/**
 * Write the specification, dropping the loop's own bookkeeping.
 *
 * Keys prefixed `__` are how a repair remembers what it already tried; the
 * renderer's schema forbids unknown properties, so they never reach the file.
 */
function writeSpec(path, spec) {
  const json = JSON.stringify(spec, (key, value) => (key.startsWith('__') ? undefined : value), 2);
  writeFileSync(path, `${json}
`, 'utf8');
}

/**
 * Diagnostics arrive in two places and two shapes.
 *
 * `report.diagnostics` nests the useful numbers under `evidence`; the composition
 * checker's own `issues` put the same fields at the top level. Normalising here
 * means every handler below can read one shape, which is why this function looks
 * more defensive than it should have to.
 */
function collect(report) {
  const out = [];
  const push = (d) => {
    if (!d || (!d.code && !d.message)) return;
    out.push(d.evidence ? d : { ...d, evidence: d });
  };
  for (const d of report.diagnostics || []) push(d);
  for (const i of report.checker?.composition?.issues || []) push(i);
  // De-duplicate: a composition issue is usually mirrored into diagnostics.
  const seen = new Set();
  return out.filter((d) => {
    const key = `${d.code}:${d.message ?? ''}:${JSON.stringify(d.evidence ?? d)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyAll(spec, diagnostics) {
  const changes = [];
  const touchedConnections = new Set();
  const touchedComponents = new Set();
  spec.__squeezedThisRound = false;

  // Three nodes failing readability at once is not three verbose labels; it is
  // one diagram too wide for a desktop. Narrow it and re-measure before touching
  // a single word the analysis chose.
  const readability = diagnostics.filter((d) => d.code === 'composition/desktop-readability').length;
  if (readability >= 3 && (spec.__squeezes ?? 0) < 4) {
    spec.__squeezes = (spec.__squeezes ?? 0) + 1;
    spec.__squeezedThisRound = true;
    const applied = compactHorizontally(spec, 0.84);
    if (applied) return [`narrowed the diagram to ${Math.round(applied * 100)}% of its width: ${readability} nodes were below the readable floor`];
  }

  for (const d of diagnostics) {
    const change = applyOne(spec, d, touchedConnections, touchedComponents);
    if (change) changes.push(change);
  }
  return changes;
}

function applyOne(spec, diagnostic, touchedConnections, touchedComponents) {
  const code = diagnostic.code ?? '';
  const message = diagnostic.message ?? '';

  if (code === 'composition/label-route-clearance') return fixClearance(spec, diagnostic, touchedConnections);
  if (code === 'composition/desktop-readability') return fixReadability(spec, diagnostic, touchedComponents);
  if (code === 'clean-flow/endpoint-side-direction') return fixEndpointSide(spec, diagnostic, touchedConnections);
  if (code === 'clean-flow/edge-through-node') return fixObstacle(spec, diagnostic, touchedConnections);
  if (code === 'composition/ambiguous-corridor' || code === 'composition/proper-crossing') {
    return fixSharedCorridor(spec, diagnostic, touchedConnections);
  }

  if (/Suggested fix: labelAt/.test(message)) return fixSuggestedLabel(spec, message, touchedConnections);
  if (/^Sublabel .* needs ~\d+px/.test(message)) return fixSublabelWidth(spec, message, touchedComponents);
  if (/overlaps component/.test(message)) return fixSuggestedLabel(spec, message, touchedConnections);

  return null;
}

/**
 * A label sitting on another relationship's route. Push it perpendicular to that
 * route, which is the only direction that gains clearance.
 */
function fixClearance(spec, diagnostic, touched) {
  const index = diagnostic.subject?.index ?? diagnostic.evidence?.labelRect?.relationIndex;
  const connection = typeof index === 'number' ? spec.connections[index] : null;
  if (!connection || touched.has(connection)) return null;

  const rect = diagnostic.evidence?.labelRect;
  const segFrom = diagnostic.evidence?.from;
  const segTo = diagnostic.evidence?.to;
  if (!rect || !segFrom || !segTo) return null;

  const minimum = diagnostic.evidence?.minimumPx ?? 4;
  const vertical = Math.abs(segFrom[0] - segTo[0]) < Math.abs(segFrom[1] - segTo[1]);
  const at = connection.labelAt ?? [rect.lx ?? rect.x, rect.ly ?? rect.y];

  // Each visit pushes further than the last. Without this, two labels that
  // collide with each other swap places every round and the loop never settles.
  const step = (connection.__pushes = (connection.__pushes ?? 0) + 1);

  if (vertical) {
    const push = rect.width / 2 + minimum + 8 + (step - 1) * 18;
    const away = at[0] >= segFrom[0] ? 1 : -1;
    connection.labelAt = [Math.round(at[0] + away * push), at[1]];
  } else {
    const push = rect.height / 2 + minimum + 10 + (step - 1) * 18;
    const away = at[1] >= segFrom[1] ? 1 : -1;
    connection.labelAt = [at[0], Math.round(at[1] + away * push)];
  }
  touched.add(connection);
  return `moved label "${connection.label}" clear of a crossing route`;
}

/**
 * Node text projected below the readable floor. Shorten it by the exact ratio the
 * renderer reported, with a little margin so one round is enough.
 */
function fixReadability(spec, diagnostic, touched) {
  const text = diagnostic.evidence?.text;
  if (!text) return null;
  const field = diagnostic.evidence?.detail === 'context' ? 'sublabel' : 'label';
  const component = spec.components.find((c) => c[field] === text);
  if (!component || touched.has(component)) return null;

  const projected = diagnostic.evidence?.projectedFontPx ?? 1;
  const minimum = diagnostic.evidence?.minimumProjectedFontPx ?? 6;
  const ratio = projected / minimum;
  const target = Math.max(6, Math.floor(text.length * ratio * 0.94));

  // Text this small is usually a symptom of a wide diagram, not of verbose
  // copy: the whole picture is scaled down to fit a desktop and every label
  // shrinks with it. Squeezing the columns together buys the same pixels back
  // without throwing away words the analysis chose deliberately.
  const hits = (component.__readabilityHits = (component.__readabilityHits ?? 0) + 1);
  if ((hits > 1 || target < text.length * 0.62) && (spec.__squeezes ?? 0) < 4 && !spec.__squeezedThisRound) {
    spec.__squeezedThisRound = true;
    spec.__squeezes = (spec.__squeezes ?? 0) + 1;
    const applied = compactHorizontally(spec, Math.max(0.72, ratio * 0.98));
    if (applied) return `narrowed the diagram to ${Math.round(applied * 100)}% of its width so node text stays readable`;
  }

  if (field === 'label') {
    // A name is not negotiable; widen the box instead.
    const [w, h] = component.size ?? [150, 62];
    component.size = [Math.round(w / ratio) + 4, h];
    touched.add(component);
    return `widened "${component.id}" so its name stays readable`;
  }

  const shortened = trimToWords(text, target);
  if (shortened === text) {
    delete component.sublabel;
    touched.add(component);
    return `dropped the detail on "${component.id}": it cannot be shortened enough to stay readable`;
  }
  component.sublabel = shortened;
  touched.add(component);
  return `shortened the detail on "${component.id}" to "${shortened}"`;
}

const rectOf = (component) => {
  const [x, y] = component.pos;
  const [w, h] = component.size ?? [150, 62];
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2, right: x + w, bottom: y + h };
};

/**
 * An edge running through a node that has nothing to do with it. Take it round.
 *
 * The renderer names the obstacle and the segment, which is everything needed to
 * pick a side and lay two waypoints. Going round the outside is what a person
 * draws here, and it keeps the endpoint-side contract: leave perpendicular to the
 * side you declared, arrive perpendicular to the side you declared.
 */
function fixObstacle(spec, diagnostic, touched) {
  const index = diagnostic.subject?.index;
  const connection = typeof index === 'number' ? spec.connections[index] : null;
  if (!connection || touched.has(connection)) return null;

  const obstacle = spec.components.find((c) => c.id === diagnostic.evidence?.obstacleId);
  const from = spec.components.find((c) => c.id === connection.from);
  const to = spec.components.find((c) => c.id === connection.to);
  if (!obstacle || !from || !to) return null;

  const o = rectOf(obstacle);
  const a = rectOf(from);
  const b = rectOf(to);
  const seg = diagnostic.evidence;
  const vertical = Math.abs((seg?.from?.[0] ?? 0) - (seg?.to?.[0] ?? 0)) < 2;

  if (vertical) {
    // Go around the left or right of the obstacle, whichever has more room.
    const others = spec.components.filter((c) => c !== obstacle && c !== from && c !== to).map(rectOf);
    const roomRight = Math.min(...others.filter((r) => r.x > o.right).map((r) => r.x - o.right), 400);
    const roomLeft = Math.min(...others.filter((r) => r.right < o.x).map((r) => o.x - r.right), 400);
    const goRight = roomRight >= roomLeft;
    const lane = goRight ? o.right + Math.min(60, Math.max(36, roomRight / 2)) : o.x - Math.min(60, Math.max(36, roomLeft / 2));
    const side = goRight ? 'right' : 'left';
    connection.fromSide = side;
    connection.toSide = side;
    connection.via = [[Math.round(lane), Math.round(a.cy)], [Math.round(lane), Math.round(b.cy)]];
    connection.labelAt = [Math.round(lane), Math.round((a.cy + b.cy) / 2)];
  } else {
    const goDown = o.cy >= (a.cy + b.cy) / 2;
    const lane = goDown ? o.bottom + 44 : o.y - 44;
    const side = goDown ? 'bottom' : 'top';
    connection.fromSide = side;
    connection.toSide = side;
    connection.via = [[Math.round(a.cx), Math.round(lane)], [Math.round(b.cx), Math.round(lane)]];
    connection.labelAt = [Math.round((a.cx + b.cx) / 2), Math.round(lane)];
  }
  touched.add(connection);
  return `routed "${connection.from}" -> "${connection.to}" around "${obstacle.id}"`;
}

/**
 * Two unrelated relationships sharing one visual corridor, or crossing. Give the
 * later of the two its own lane by bending it a little off the shared axis.
 */
function fixSharedCorridor(spec, diagnostic, touched) {
  const index = diagnostic.subject?.index;
  const connection = typeof index === 'number' ? spec.connections[index] : null;
  if (!connection || touched.has(connection)) return null;

  const from = spec.components.find((c) => c.id === connection.from);
  const to = spec.components.find((c) => c.id === connection.to);
  if (!from || !to) return null;
  const a = rectOf(from);
  const b = rectOf(to);

  // Count how many times this connection has already been bent, so repeated
  // visits push it further rather than oscillating around the same lane.
  const step = (connection.__bends = (connection.__bends ?? 0) + 1);
  const offset = 26 * step * (step % 2 === 0 ? -1 : 1);

  if (Math.abs(a.cy - b.cy) <= Math.abs(a.cx - b.cx)) {
    const lane = Math.round((a.cy + b.cy) / 2 + offset);
    const midX = Math.round((a.cx + b.cx) / 2);
    connection.fromSide = a.cx <= b.cx ? 'right' : 'left';
    connection.toSide = a.cx <= b.cx ? 'left' : 'right';
    connection.via = [[midX, Math.round(a.cy)], [midX, lane], [midX, Math.round(b.cy)]];
    connection.labelAt = [midX, lane];
  } else {
    const lane = Math.round((a.cx + b.cx) / 2 + offset);
    const midY = Math.round((a.cy + b.cy) / 2);
    connection.fromSide = a.cy <= b.cy ? 'bottom' : 'top';
    connection.toSide = a.cy <= b.cy ? 'top' : 'bottom';
    connection.via = [[Math.round(a.cx), midY], [lane, midY], [Math.round(b.cx), midY]];
    connection.labelAt = [lane, midY];
  }
  touched.add(connection);
  return `gave "${connection.from}" -> "${connection.to}" its own corridor`;
}

/** A declared side the route cannot honour. Hand the edge back to auto routing. */
function fixEndpointSide(spec, diagnostic, touched) {
  const index = diagnostic.subject?.index;
  const connection = typeof index === 'number' ? spec.connections[index] : null;
  if (!connection || touched.has(connection)) return null;
  delete connection.fromSide;
  delete connection.toSide;
  delete connection.route;
  delete connection.via;
  touched.add(connection);
  return `returned "${connection.from}" -> "${connection.to}" to automatic routing`;
}

/** The renderer printed the coordinate that works. Use it. */
function fixSuggestedLabel(spec, message, touched) {
  const label = message.match(/Label "([^"]+)" overlaps/)?.[1];
  const suggestion = message.match(/Suggested fix: labelAt \[(-?\d+), (-?\d+)\]/);
  if (!label) return null;

  const candidates = spec.connections.filter((c) => c.label === label && !touched.has(c));
  const connection = candidates[0];
  if (!connection) return null;

  if (suggestion) {
    connection.labelAt = [Number(suggestion[1]), Number(suggestion[2])];
  } else if (connection.labelAt) {
    connection.labelAt = [connection.labelAt[0], connection.labelAt[1] + 30];
  } else {
    return null;
  }
  touched.add(connection);
  return `took the renderer's suggested position for label "${label}"`;
}

/** A sublabel wider than its box. Widen a little, shorten the rest. */
function fixSublabelWidth(spec, message, touched) {
  const parsed = message.match(/Sublabel "([^"]+)" needs ~(\d+)px .* component "([^"]+)" provides (\d+)px/);
  if (!parsed) return null;
  const [, text, neededRaw, id, providedRaw] = parsed;
  const component = spec.components.find((c) => c.id === id);
  if (!component || touched.has(component)) return null;

  const needed = Number(neededRaw);
  const provided = Number(providedRaw);
  const deficit = needed - provided;

  if (deficit <= 24) {
    const [w, h] = component.size ?? [150, 62];
    component.size = [w + deficit + 6, h];
    touched.add(component);
    return `widened "${id}" by ${deficit + 6}px to fit its detail`;
  }
  const target = Math.max(6, Math.floor(text.length * (provided / needed) * 0.94));
  component.sublabel = trimToWords(text, target);
  touched.add(component);
  return `shortened the detail on "${id}" to "${component.sublabel}"`;
}

/** Trim on a word boundary and never leave dangling punctuation behind. */
function trimToWords(text, max) {
  if (text.length <= max) return text;
  const words = text.split(/\s+/);
  let out = '';
  for (const word of words) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > max) break;
    out = next;
  }
  return (out || text.slice(0, max)).replace(TRAILING, '');
}

/**
 * Pull the columns together without touching node sizes.
 *
 * Only the gaps may shrink — a narrower node would make the text worse, which is
 * the thing this is trying to fix. Returns the ratio actually achieved, or null
 * when the columns are already as tight as they usefully get.
 */
export function compactHorizontally(spec, ratio) {
  const xs = spec.components.map((c) => c.pos[0]);
  const widths = spec.components.map((c) => (c.size ?? [150, 62])[0]);
  const minX = Math.min(...xs);
  const maxRight = Math.max(...spec.components.map((c, i) => xs[i] + widths[i]));
  const span = Math.max(...xs) - minX;
  if (span <= 0) return null;

  const extent = maxRight - minX;
  const widest = Math.max(...widths);
  const g = (ratio * extent - widest) / span;
  if (!Number.isFinite(g) || g >= 0.98 || g < 0.35) return null;

  const move = (x) => Math.round(minX + (x - minX) * g);

  // A waypoint sitting on a node's centre line is not an arbitrary coordinate:
  // it is what makes the first and last segment leave perpendicular to the side
  // the connection declared. Scaling it like any other x breaks that contract and
  // the renderer rejects the route, so centres are re-anchored, not scaled.
  const centresBefore = spec.components.map((c) => ({
    id: c.id,
    x: c.pos[0] + (c.size ?? [150, 62])[0] / 2,
  }));
  for (const component of spec.components) component.pos = [move(component.pos[0]), component.pos[1]];
  const centreAfter = new Map(spec.components.map((c) => [c.id, c.pos[0] + (c.size ?? [150, 62])[0] / 2]));
  const remap = (x) => {
    const anchor = centresBefore.find((c) => Math.abs(c.x - x) <= 2);
    return anchor ? Math.round(centreAfter.get(anchor.id)) : move(x);
  };

  for (const connection of spec.connections || []) {
    if (connection.labelAt) connection.labelAt = [remap(connection.labelAt[0]), connection.labelAt[1]];
    if (connection.via) connection.via = connection.via.map(([x, y]) => [remap(x), y]);
  }
  return g;
}

/**
 * Vertical containment is judged in a browser, after delivery, so it is a
 * separate pass: pull the rows together and let the caller re-deliver.
 */
export function compactVertically(spec, factor = 0.82) {
  const ys = spec.components.map((c) => c.pos[1]);
  const top = Math.min(...ys);
  for (const component of spec.components) {
    component.pos = [component.pos[0], Math.round(top + (component.pos[1] - top) * factor)];
  }
  for (const connection of spec.connections || []) {
    if (connection.labelAt) {
      connection.labelAt = [connection.labelAt[0], Math.round(top + (connection.labelAt[1] - top) * factor)];
    }
  }
  return spec;
}
