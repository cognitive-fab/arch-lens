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
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = stripComment(raw);
    if (!line.trim()) return;
    if (/^---|^\.\.\./.test(line)) throw new Error(`line ${i + 1}: multi-document YAML is not supported`);
    if (/^\s*[&*]/.test(line) || /:\s*[&*]\w/.test(line)) throw new Error(`line ${i + 1}: YAML anchors and aliases are not supported`);
    if (/:\s*[|>][-+]?\s*$/.test(line)) throw new Error(`line ${i + 1}: block scalars are not supported`);
    lines.push({ n: i + 1, indent: line.match(/^ */)[0].length, text: line.trim() });
  });
  const [value] = parseBlock(lines, 0, -1);
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
    } else if (ch === '"' || ch === "'") {
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

/** Parse the block starting at `at`, whose lines are indented more than `parentIndent`. */
function parseBlock(lines, at, parentIndent) {
  if (at >= lines.length || lines[at].indent <= parentIndent) return [null, at];
  const indent = lines[at].indent;
  if (lines[at].text.startsWith('- ') || lines[at].text === '-') return parseList(lines, at, indent);
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
      const [value, next] = parseBlock(lines, i + 1, indent);
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
    } else if (/^("[^"]*"|'[^']*'|[^:#]+?)\s*:(?:\s+.*)?$/.test(rest)) {
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
