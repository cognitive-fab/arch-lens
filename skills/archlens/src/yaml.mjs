// Enough YAML to read a compose file.
//
// A compose file is block mappings, block and flow lists, and scalars. It is
// not anchors, multi-documents, block scalars or tags, and this parser refuses
// those by name rather than guessing. Pulling in a full YAML library would
// mean a dependency for a tool that otherwise has none, and the subset that
// compose files actually use fits in a page.

/**
 * @param {string} text
 * @returns {unknown}
 */
export function parseYaml(text) {
  const lines = [];
  let documents = 0;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = stripComment(raw);
    if (!line.trim()) return;
    if (/^---(\s|$)/.test(line)) {
      // One leading marker is just how some files begin. A second one is a
      // second document, and so is anything that came before the first.
      documents += 1;
      if (documents > 1 || lines.length > 0) throw new Error(`line ${i + 1}: multi-document YAML is not supported`);
      return;
    }
    if (/^\.\.\.(\s|$)/.test(line)) throw new Error(`line ${i + 1}: multi-document YAML is not supported`);
    if (/^\s*[&*]/.test(line) || /:\s*[&*]\w/.test(line)) throw new Error(`line ${i + 1}: YAML anchors and aliases are not supported`);
    if (/(?::|^\s*-)\s*[|>][-+]?\s*$/.test(line)) throw new Error(`line ${i + 1}: block scalars are not supported`);
    lines.push({ n: i + 1, indent: line.match(/^ */)[0].length, text: line.trim() });
  });
  const [value, next] = parseBlock(lines, 0, -1);
  if (next < lines.length) {
    // A line the descent could not attach is an indentation error, and the
    // one thing this parser must never do is drop it and carry on.
    throw new Error(`line ${lines[next].n}: unexpected indentation at "${lines[next].text}"`);
  }
  return value;
}

function stripComment(raw) {
  let out = '';
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
    } else if ((ch === '"' || ch === "'") && opensScalar(raw, i)) {
      quote = ch;
      out += ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) {
      break;
    } else {
      out += ch;
    }
  }
  return out.replace(/\s+$/, '');
}

/**
 * A quote opens a scalar only at the start of one: after `key: `, after `- `,
 * at the start of the line, or after `[`, `{` or `,` in a flow collection. An
 * apostrophe inside a plain value is just an apostrophe.
 */
function opensScalar(raw, i) {
  const before = raw.slice(0, i);
  return /(?:^|:\s+|^\s*-\s+|[[{,]\s*)$/.test(before);
}

/**
 * Parse the block starting at `at`, whose lines are indented more than
 * `parentIndent` — except that a list may sit at the same indent as the key it
 * belongs to, which is the compact style most compose files use.
 */
function parseBlock(lines, at, parentIndent, { listMayAlign = false } = {}) {
  if (at >= lines.length) return [null, at];
  const isItem = lines[at].text.startsWith('- ') || lines[at].text === '-';
  const indent = lines[at].indent;
  if (indent < parentIndent || (indent === parentIndent && !(isItem && listMayAlign))) return [null, at];
  if (isItem) return parseList(lines, at, indent);
  return parseMap(lines, at, indent);
}

function parseMap(lines, at, indent) {
  const out = {};
  let i = at;
  while (i < lines.length && lines[i].indent === indent) {
    const { text, n } = lines[i];
    const m = text.match(/^("[^"]*"|'[^']*'|[^:#]+?)\s*:(?:\s+(.*))?$/);
    if (!m) throw new Error(`line ${n}: expected "key: value", got "${text}"`);
    const key = scalar(m[1]);
    const rest = m[2];
    if (rest !== undefined && rest !== '') {
      out[key] = scalar(rest);
      i += 1;
    } else {
      const [value, next] = parseBlock(lines, i + 1, indent, { listMayAlign: true });
      out[key] = value === null ? null : value;
      i = next;
    }
  }
  return [out, i];
}

function parseList(lines, at, indent) {
  const out = [];
  let i = at;
  while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
    const { text, n } = lines[i];
    const rest = text.slice(1).trim();
    if (rest === '') {
      const [value, next] = parseBlock(lines, i + 1, indent);
      out.push(value);
      i = next;
    } else if (!/^[[{]/.test(rest) && /^("[^"]*"|'[^']*'|[^:#]+?)\s*:(?:\s+.*)?$/.test(rest)) {
      // "- key: value" opens a mapping whose remaining keys are indented to
      // line up with the key. Re-present the first pair as a line at that indent.
      const inner = indent + 2;
      const first = { n, indent: inner, text: rest };
      const spliced = [first, ...lines.slice(i + 1)];
      const [value, consumed] = parseMap(spliced, 0, inner);
      out.push(value);
      i = i + consumed; // the first synthetic line stands in for lines[i]
    } else {
      out.push(scalar(rest));
      i += 1;
    }
  }
  return [out, i];
}

function scalar(text) {
  const t = text.trim();
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();
    return inner ? splitFlow(inner).map(scalar) : [];
  }
  if (t.startsWith('{') && t.endsWith('}')) {
    const out = {};
    const inner = t.slice(1, -1).trim();
    for (const part of inner ? splitFlow(inner) : []) {
      const m = part.match(/^([^:]+):\s*(.*)$/);
      if (m) out[scalar(m[1])] = scalar(m[2]);
    }
    return out;
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

function splitFlow(inner) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '[' || ch === '{') {
      depth += 1;
      cur += ch;
    } else if (ch === ']' || ch === '}') {
      depth -= 1;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
