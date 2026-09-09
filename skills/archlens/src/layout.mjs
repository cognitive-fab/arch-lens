// Coordinates, so a person never types one.
//
// Hand-placing a diagram is where the time went before this existed, and it is
// work with no judgement in it: rank the nodes by which way the arrows point,
// order each rank so the edges cross as little as possible, then multiply by a
// grid. The interesting decisions all happened upstream, in the analysis.
//
// Two things here are not generic graph drawing, and both come from watching the
// renderer reject real diagrams:
//
//   - Boundary members are kept CONTIGUOUS within a column. A boundary box is
//     drawn as the bounding box of its members, so a stranger sitting between
//     two of them is drawn inside the box, and the picture then claims something
//     the analysis never said.
//   - Edge labels are placed in the CORRIDOR between two columns and staggered
//     against each other, because the renderer's clearance rule is about labels
//     colliding with other routes, not about labels colliding with nodes.

export const NODE_W = 150;
export const NODE_H = 62;
export const GAP_X = 170; // clear gap between columns, not centre distance
export const GAP_Y = 64;
export const MARGIN_X = 60;
export const MARGIN_Y = 48;
export const BAND_GAP = 60; // clear air between two boundary bands

/**
 * Rank every component. A declared layer wins; otherwise the longest path from a
 * source in the relation graph, which puts callers left of what they call.
 */
export function rank(components, relations, layers) {
  const order = new Map((layers || []).map((l) => [l.id, l.order]));
  const ids = components.map((c) => c.id);
  const declared = new Map();
  for (const c of components) {
    if (c.layer !== undefined && order.has(c.layer)) declared.set(c.id, order.get(c.layer));
  }
  if (declared.size === ids.length) return normalise(declared);

  // Longest-path ranking over the acyclic part of the graph. Cycles are real in
  // architecture (a broker calls back), so a back edge is dropped rather than
  // treated as an error: it still gets drawn, it just does not set rank.
  const out = new Map(ids.map((id) => [id, []]));
  const indeg = new Map(ids.map((id) => [id, 0]));
  const seen = new Set();
  for (const r of relations) {
    const key = `${r.from}>${r.to}`;
    if (seen.has(key) || !out.has(r.from) || !out.has(r.to)) continue;
    seen.add(key);
    out.get(r.from).push(r.to);
    indeg.set(r.to, indeg.get(r.to) + 1);
  }
  const rankOf = new Map(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const pending = new Map(indeg);
  const visited = new Set(queue);
  while (queue.length) {
    const id = queue.shift();
    for (const next of out.get(id)) {
      rankOf.set(next, Math.max(rankOf.get(next), rankOf.get(id) + 1));
      pending.set(next, pending.get(next) - 1);
      if (pending.get(next) === 0 && !visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  // Anything left in a cycle keeps the rank its predecessors implied.
  for (const [id, r] of declared) rankOf.set(id, r);
  return normalise(separate(rankOf, relations));
}

/**
 * No relation may join two nodes in the same column.
 *
 * A same-column edge has to run vertically past whatever sits between its ends,
 * and "whatever sits between" is exactly the unrelated node the renderer refuses
 * to let an edge cross. Pushing the target one column right turns an impossible
 * route into a trivial one. Declared layers are respected first, so this only
 * moves nodes the analysis did not pin.
 */
function separate(rankOf, relations) {
  for (let pass = 0; pass < 8; pass += 1) {
    let moved = false;
    for (const r of relations) {
      if (!rankOf.has(r.from) || !rankOf.has(r.to)) continue;
      if (rankOf.get(r.from) === rankOf.get(r.to)) {
        rankOf.set(r.to, rankOf.get(r.to) + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return rankOf;
}

/** Spread repeated exits along a node's side instead of stacking them. */
function port(ports, id, side, x) {
  const key = `${id}:${side}`;
  const used = ports.get(key) ?? 0;
  ports.set(key, used + 1);
  const offset = used === 0 ? 0 : (used % 2 === 1 ? -1 : 1) * Math.ceil(used / 2) * 26;
  const centre = x + NODE_W / 2;
  const limit = NODE_W / 2 - 24;
  return Math.round(centre + Math.max(-limit, Math.min(limit, offset)));
}

function normalise(rankOf) {
  const used = [...new Set([...rankOf.values()])].sort((a, b) => a - b);
  const remap = new Map(used.map((v, i) => [v, i]));
  return new Map([...rankOf].map(([id, v]) => [id, remap.get(v)]));
}

/**
 * Trade height for width until the diagram is wider than it is tall.
 *
 * The renderer scales a diagram to fit the available WIDTH and lets the height
 * follow, so a tall narrow picture is never shrunk — it just runs off the bottom
 * of the viewport, and pulling the rows closer barely helps. What helps is
 * fewer rows. A column taller than the budget is split into adjacent columns of
 * the same rank, which is safe because no relation joins two nodes of one rank.
 */
function balance(columns, bandOf) {
  const total = columns.reduce((n, col) => n + col.length, 0);
  const tallest = Math.max(...columns.map((col) => col.length));

  const split = (maxRows) => {
    const out = [];
    for (const col of columns) {
      if (col.length <= maxRows) {
        out.push([...col]);
        continue;
      }
      for (let i = 0; i < col.length; i += maxRows) out.push(col.slice(i, i + maxRows));
    }
    return out;
  };

  const shape = (candidate) => {
    const bands = new Map();
    for (const col of candidate) {
      const counts = new Map();
      for (const id of col) counts.set(bandOf(id), (counts.get(bandOf(id)) ?? 0) + 1);
      for (const [band, n] of counts) bands.set(band, Math.max(bands.get(band) ?? 0, n));
    }
    const rows = [...bands.values()].reduce((a, b) => a + b, 0);
    const gaps = Math.max(0, bands.size - 1) * BAND_GAP;
    return {
      width: 2 * MARGIN_X + candidate.length * NODE_W + Math.max(0, candidate.length - 1) * GAP_X,
      height: 2 * MARGIN_Y + rows * NODE_H + Math.max(0, rows - 1) * GAP_Y + gaps,
    };
  };

  // The renderer fits a diagram to the available width and lets height follow,
  // so the rendered height is height x (930 / width) whether that scales up or
  // down. A narrow diagram is therefore stretched, not spared. Judge candidates
  // on that projected height rather than on their own proportions.
  const projected = ({ width, height }) => (height * 930) / width;

  // Take the tallest shape that fits. Extra columns cost every node its detail
  // text, so the flattest layout available is rarely the one you want.
  for (let maxRows = tallest; maxRows >= 1; maxRows -= 1) {
    const candidate = split(maxRows);
    if (candidate.length > Math.max(4, total)) break;
    if (projected(shape(candidate)) <= 520) return candidate;
  }
  return split(1);
}

/**
 * Order the nodes inside each column: barycentre sweeps to reduce crossings,
 * then a regrouping pass that makes each boundary's members contiguous.
 */
function orderColumns(columns, relations, boundaryOf) {
  const positionIn = (col, id) => col.indexOf(id);
  const neighbours = new Map();
  for (const r of relations) {
    if (!neighbours.has(r.from)) neighbours.set(r.from, []);
    if (!neighbours.has(r.to)) neighbours.set(r.to, []);
    neighbours.get(r.from).push(r.to);
    neighbours.get(r.to).push(r.from);
  }

  for (let sweep = 0; sweep < 4; sweep += 1) {
    const dir = sweep % 2 === 0 ? 1 : -1;
    const range = dir === 1 ? [...columns.keys()] : [...columns.keys()].reverse();
    for (const ci of range) {
      const col = columns[ci];
      const adjacent = columns[ci - dir];
      if (!adjacent) continue;
      const bary = new Map();
      for (const id of col) {
        const ns = (neighbours.get(id) || []).filter((n) => adjacent.includes(n));
        bary.set(id, ns.length ? ns.reduce((a, n) => a + positionIn(adjacent, n), 0) / ns.length : positionIn(col, id));
      }
      col.sort((a, b) => bary.get(a) - bary.get(b));
    }
  }

  // Contiguity: a boundary drawn around scattered members swallows strangers.
  for (const col of columns) {
    const groups = new Map();
    for (const id of col) {
      const key = boundaryOf.get(id) ?? '~none';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(id);
    }
    const rebuilt = [];
    for (const ids of groups.values()) rebuilt.push(...ids);
    col.splice(0, col.length, ...rebuilt);
  }
  return columns;
}

/**
 * Place components and edge labels.
 *
 * @returns {{positions: Map<string, [number, number]>, labels: Map<string, [number, number]>, width: number, height: number, columns: string[][]}}
 */
export function layout(components, relations, { layers, boundaryOf = new Map(), gapX = GAP_X } = {}) {
  const rankOf = rank(components, relations, layers);
  const maxRank = Math.max(0, ...rankOf.values());

  // Columns come from the relation graph; ROWS come from the boundaries. Each
  // boundary gets a horizontal band of its own, because the renderer draws a
  // boundary as the bounding box of its members: two boundaries whose members
  // interleave vertically produce two overlapping boxes, and an overlapping box
  // says something about containment that the analysis never said.
  const bandOf = (id) => boundaryOf.get(id) ?? '~none';

  let columns = Array.from({ length: maxRank + 1 }, () => []);
  for (const c of components) columns[rankOf.get(c.id)].push(c.id);
  orderColumns(columns, relations, boundaryOf);
  columns = balance(columns, bandOf);

  const bands = [];
  for (const col of columns) for (const id of col) {
    const band = bandOf(id);
    if (!bands.includes(band)) bands.push(band);
  }

  // How many rows each band needs is the most it occupies in any one column.
  const rowsIn = new Map(bands.map((b) => [b, 0]));
  for (const col of columns) {
    const counts = new Map();
    for (const id of col) counts.set(bandOf(id), (counts.get(bandOf(id)) ?? 0) + 1);
    for (const [band, n] of counts) rowsIn.set(band, Math.max(rowsIn.get(band), n));
  }

  const bandTop = new Map();
  let cursor = MARGIN_Y;
  for (const band of bands) {
    bandTop.set(band, cursor);
    cursor += rowsIn.get(band) * (NODE_H + GAP_Y) + BAND_GAP;
  }

  const positions = new Map();
  columns.forEach((col, ci) => {
    const used = new Map();
    for (const id of col) {
      const band = bandOf(id);
      const row = used.get(band) ?? 0;
      used.set(band, row + 1);
      // Centre a band's short columns against its own tallest, not the diagram's.
      const slack = ((rowsIn.get(band) - (col.filter((n) => bandOf(n) === band).length)) * (NODE_H + GAP_Y)) / 2;
      positions.set(id, [
        MARGIN_X + ci * (NODE_W + gapX),
        Math.round(bandTop.get(band) + slack + row * (NODE_H + GAP_Y)),
      ]);
    }
  });

  const routes = routeLongEdges(relations, positions, rankOf);
  const labels = placeLabels(relations, positions, rankOf, routes);

  const xs = [...positions.values()].map(([x]) => x);
  const ys = [...positions.values()].map(([, y]) => y);
  return {
    positions,
    labels,
    routes,
    columns,
    rankOf,
    width: Math.max(...xs) + NODE_W + MARGIN_X,
    height: Math.max(...ys) + NODE_H + MARGIN_Y,
  };
}

/**
 * An edge that skips a column runs straight through whatever occupies the column
 * it skipped. Give those edges a lane of their own in the gutter beside their
 * row, where no node ever sits, and stagger the lanes against each other.
 *
 * Short edges are left to automatic routing: the renderer does that better than
 * a fixed rule, and every explicit `via` is a coordinate somebody has to maintain.
 */
function routeLongEdges(relations, positions, rankOf) {
  const routes = new Map();
  const byColumn = new Map();
  for (const [id, [x, y]] of positions) {
    if (!byColumn.has(x)) byColumn.set(x, []);
    byColumn.get(x).push({ id, y });
  }
  // A lane is only usable if BOTH endpoints can reach it without climbing past a
  // neighbour in their own column: the vertical approach is what hits a node.
  const clearAbove = (id) => {
    const [x, y] = positions.get(id);
    return !byColumn.get(x).some((n) => n.id !== id && n.y < y);
  };
  const clearBelow = (id) => {
    const [x, y] = positions.get(id);
    return !byColumn.get(x).some((n) => n.id !== id && n.y > y);
  };

  const ports = new Map();
  let above = 0;
  let below = 0;
  for (const r of relations) {
    const a = positions.get(r.from);
    const b = positions.get(r.to);
    if (!a || !b) continue;
    if (Math.abs(rankOf.get(r.from) - rankOf.get(r.to)) < 2) continue;

    const canAbove = clearAbove(r.from) && clearAbove(r.to);
    const canBelow = clearBelow(r.from) && clearBelow(r.to);
    if (!canAbove && !canBelow) continue; // leave it to automatic routing and repair

    const useAbove = canAbove && (!canBelow || above <= below);
    const index = useAbove ? above++ : below++;
    const stagger = (index % 2 === 0 ? -1 : 1) * Math.ceil(index / 2) * 14;
    const laneY = useAbove
      ? Math.round(Math.min(a[1], b[1]) - GAP_Y / 2 + stagger)
      : Math.round(Math.max(a[1], b[1]) + NODE_H + GAP_Y / 2 + stagger);
    const side = useAbove ? 'top' : 'bottom';

    // Two lanes leaving the same node on the same side would descend on one
    // line, and an unrelated label sitting near that line has nowhere to go.
    // Ports may sit anywhere along a side, so spread them.
    const fromX = port(ports, r.from, side, a[0]);
    const toX = port(ports, r.to, side, b[0]);

    routes.set(`${r.from}>${r.to}`, {
      fromSide: side,
      toSide: side,
      via: [[fromX, laneY], [toX, laneY]],
      labelAt: [Math.round((fromX + toX) / 2), laneY],
    });
  }
  return routes;
}

/**
 * Put each edge label in the corridor between its columns, then pull apart any
 * two that landed on top of each other.
 */
function placeLabels(relations, positions, rankOf, routes = new Map()) {
  const labels = new Map();
  const corridors = new Map();

  for (const r of relations) {
    const a = positions.get(r.from);
    const b = positions.get(r.to);
    if (!a || !b) continue;
    const ra = rankOf.get(r.from);
    const rb = rankOf.get(r.to);
    const key = `${r.from}>${r.to}`;
    if (routes.has(key)) {
      labels.set(key, routes.get(key).labelAt);
      continue;
    }

    let x;
    let y;
    if (ra === rb) {
      // Same column: the route runs vertically beside the nodes.
      x = a[0] + NODE_W / 2;
      y = Math.round((a[1] + b[1]) / 2 + NODE_H / 2);
    } else {
      const left = ra < rb ? a : b;
      x = Math.round(left[0] + NODE_W + GAP_X / 2);
      y = ra === rb ? a[1] + 15 : Math.round(Math.min(a[1], b[1]) + NODE_H / 2 - 16);
      if (Math.abs(a[1] - b[1]) < 4) y = a[1] + 15;
    }
    const corridorKey = `${Math.min(ra, rb)}:${Math.max(ra, rb)}`;
    if (!corridors.has(corridorKey)) corridors.set(corridorKey, []);
    corridors.get(corridorKey).push({ key, x, y });
  }

  for (const entries of corridors.values()) {
    entries.sort((p, q) => p.y - q.y);
    let previous = -Infinity;
    for (const entry of entries) {
      if (entry.y - previous < 34) entry.y = previous + 34;
      previous = entry.y;
      labels.set(entry.key, [entry.x, entry.y]);
    }
  }
  return labels;
}

/**
 * The longest sublabel the renderer will accept at a 1440px desktop.
 *
 * The renderer shrinks node text to fit and then rejects anything projecting
 * below 6px once the whole diagram is scaled into ~930px of usable width. Both
 * halves of that are width, so the budget is a function of the viewBox: a wider
 * diagram can carry less text per node, which is the opposite of the intuition
 * and the reason this is computed rather than guessed.
 */
export function detailBudget(viewBoxWidth, nodeWidth = NODE_W) {
  const usable = nodeWidth - 8;
  // The renderer's viewBox is a little wider than the node extents: boundary
  // padding and the legend both claim room. Budgeting against the bare extent
  // produces text that fits the layout and fails the artifact, so pad it.
  const projectedScale = 930 / Math.max(viewBoxWidth * 1.08, 930);
  const requiredSourceFont = 6 / projectedScale;
  return Math.max(8, Math.floor(usable / (0.6 * requiredSourceFont)));
}
