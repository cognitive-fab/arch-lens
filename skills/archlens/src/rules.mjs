// Constraints a machine can check.
//
// A fact of kind `constraint` is prose: "nothing downstream can reach back
// into the database". Most such sentences are really a rule about edges —
// which parts may talk to which — and a rule about edges can be checked twice:
// against the analysis itself, where a declared relation that breaks it means
// the document contradicts its own doctrine; and against the code, where an
// import from one component's files into another's is an edge whether or not
// anyone declared it.
//
// Two rule shapes cover the constraints architecture documents actually make.
// Each names components or boundaries by id; a boundary stands for all its
// members, and the code a component owns is what its evidence cites.
//
//   { "kind": "no-relation", "from": X, "to": Y }
//       nothing in X reaches anything in Y.
//   { "kind": "only-via", "to": Y, "via": [A, B] }
//       everything that reaches Y comes from A or B (or from inside Y).
//
// The model check is exact. The code check is as good as import resolution,
// which is honest about what it could not resolve.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { index } from './model.mjs';

export const RULE_KINDS = new Set(['no-relation', 'only-via']);

/** Component ids a rule side stands for: the id itself, or a boundary's members. */
export function membersOf(idx, id) {
  if (idx.components.has(id)) return [id];
  const b = idx.boundaries.get(id);
  return b ? [...b.contains] : [];
}

/**
 * Shape and reference errors in a rule; empty when it is well formed.
 * Used by the validator, so the messages are the validator's.
 */
export function ruleProblems(rule, idx) {
  const out = [];
  if (!rule || typeof rule !== 'object') return [{ where: '', message: 'rule must be an object' }];
  if (!RULE_KINDS.has(rule.kind)) return [{ where: '.kind', message: `unknown rule kind ${JSON.stringify(rule.kind)}`, fix: `use one of: ${[...RULE_KINDS].join(', ')}` }];
  const known = (id) => idx.components.has(id) || idx.boundaries.has(id);
  if (rule.kind === 'no-relation') {
    for (const side of ['from', 'to']) {
      if (!known(rule[side])) out.push({ where: `.${side}`, message: `rule ${side} "${rule[side]}" is neither a component nor a boundary` });
    }
  } else {
    if (!known(rule.to)) out.push({ where: '.to', message: `rule to "${rule.to}" is neither a component nor a boundary` });
    if (!Array.isArray(rule.via) || rule.via.length === 0) out.push({ where: '.via', message: 'rule via must list at least one component or boundary' });
    else rule.via.forEach((id, i) => {
      if (!known(id)) out.push({ where: `.via[${i}]`, message: `rule via "${id}" is neither a component nor a boundary` });
    });
  }
  return out;
}

/**
 * Check every rule against the analysis's own relations.
 *
 * @returns {Array<{fact: object, relation: object, message: string}>}
 */
export function checkRulesAgainstModel(analysis) {
  const idx = index(analysis);
  const out = [];
  for (const fact of analysis.facts ?? []) {
    if (!fact.rule || ruleProblems(fact.rule, idx).length) continue;
    const rule = fact.rule;
    if (rule.kind === 'no-relation') {
      const from = new Set(membersOf(idx, rule.from));
      const to = new Set(membersOf(idx, rule.to));
      for (const r of analysis.relations) {
        if (from.has(r.from) && to.has(r.to)) {
          out.push({ fact, relation: r, message: `declares "${r.from}" -> "${r.to}", which the constraint "${fact.claim}" forbids` });
        }
      }
    } else {
      const to = new Set(membersOf(idx, rule.to));
      const via = new Set(rule.via.flatMap((id) => membersOf(idx, id)));
      for (const r of analysis.relations) {
        if (to.has(r.to) && !via.has(r.from) && !to.has(r.from)) {
          out.push({ fact, relation: r, message: `declares "${r.from}" -> "${r.to}", but the constraint "${fact.claim}" allows "${r.to}" to be reached only via ${rule.via.join(', ')}` });
        }
      }
    }
  }
  return out;
}

// --- the code side ----------------------------------------------------------------

const SOURCE = /\.(?:[cm]?[jt]sx?|go|py)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '__pycache__', '.venv', 'venv']);

/** Every source file under a repository, repository-relative with forward slashes. */
export function sourceFiles(repoRoot) {
  const out = [];
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.name.startsWith('.') && d.name !== '.') continue;
      const abs = join(dir, d.name);
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) walk(abs);
      } else if (SOURCE.test(d.name)) {
        out.push(relative(repoRoot, abs).replace(/\\/g, '/'));
      }
    }
  };
  walk(repoRoot);
  return out;
}

/**
 * Import specifiers in one file, with their line numbers. Three languages,
 * the statement forms people actually write; anything cleverer is missed and
 * the report says how many imports were not resolved.
 */
export function importsIn(text, path) {
  const out = [];
  const lines = text.split('\n');
  const push = (spec, i) => out.push({ spec, line: i + 1 });
  if (/\.py$/.test(path)) {
    lines.forEach((l, i) => {
      let m = l.match(/^\s*from\s+([.\w]+)\s+import\b/);
      if (m) return push(m[1], i);
      m = l.match(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/);
      if (m) for (const s of m[1].split(',')) push(s.trim(), i);
    });
    return out;
  }
  if (/\.go$/.test(path)) {
    let inBlock = false;
    lines.forEach((l, i) => {
      if (/^\s*import\s*\(/.test(l)) { inBlock = true; return; }
      if (inBlock && /^\s*\)/.test(l)) { inBlock = false; return; }
      const m = inBlock ? l.match(/"([^"]+)"/) : l.match(/^\s*import\s+(?:\w+\s+)?"([^"]+)"/);
      if (m) push(m[1], i);
    });
    return out;
  }
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      push(m[1] ?? m[2] ?? m[3] ?? m[4], i);
    }
  });
  return out;
}

const JS_EXT = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts'];

/**
 * Where an import lands in the repository, or null when it is a package, the
 * standard library, or something this cannot follow.
 */
export function resolveImport(spec, fromPath, repoRoot, { goModule } = {}) {
  const exists = (p) => existsSync(join(repoRoot, p));
  const isFile = (p) => exists(p) && statSync(join(repoRoot, p)).isFile();
  const isDir = (p) => exists(p) && statSync(join(repoRoot, p)).isDirectory();
  const norm = (p) => posix.normalize(p).replace(/^\.\//, '');

  if (/\.py$/.test(fromPath)) {
    const dots = spec.match(/^\.*/)[0].length;
    const rest = spec.slice(dots).split('.').filter(Boolean);
    let base;
    if (dots > 0) {
      base = posix.dirname(fromPath);
      for (let i = 1; i < dots; i += 1) base = posix.dirname(base);
    } else {
      base = '';
    }
    const candidates = [];
    for (let n = rest.length; n >= 1; n -= 1) {
      const p = [base, ...rest.slice(0, n)].filter(Boolean).join('/');
      candidates.push(`${p}.py`, `${p}/__init__.py`);
    }
    const file = candidates.map(norm).find(isFile);
    if (file) return file;
    // A namespace package: a directory with no __init__.py. The directory is
    // the right answer for ownership even if no single file is.
    const dir = norm([base, ...rest].filter(Boolean).join('/'));
    return rest.length && isDir(dir) ? dir : null;
  }

  if (/\.go$/.test(fromPath)) {
    if (!goModule || !spec.startsWith(`${goModule}/`) && spec !== goModule) return null;
    const dir = spec === goModule ? '.' : spec.slice(goModule.length + 1);
    return isDir(dir) ? norm(dir) : null;
  }

  if (!spec.startsWith('.') && !spec.startsWith('/')) return null; // a package
  const base = spec.startsWith('/') ? spec.slice(1) : posix.join(posix.dirname(fromPath), spec);
  const candidates = [base, ...JS_EXT.map((e) => base + e), ...JS_EXT.map((e) => `${base}/index${e}`)];
  // TypeScript lets `./x.js` mean `./x.ts`.
  if (/\.js$/.test(base)) candidates.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
  return candidates.map(norm).find(isFile) ?? null;
}

/** Which component's evidence a path falls under, if any. Longest citation wins. */
function ownerOf(path, owners) {
  let best = null;
  for (const o of owners) {
    if (path === o.path || path.startsWith(`${o.path}/`)) {
      if (!best || o.path.length > best.path.length) best = o;
    }
  }
  return best?.id ?? null;
}

/**
 * Check every rule against the imports in the code.
 *
 * @returns {{violations: Array, files: number, imports: number, unresolved: number, uncited: string[]}}
 */
export function checkRulesAgainstCode(analysis, repoRoot) {
  const idx = index(analysis);
  const rules = (analysis.facts ?? []).filter((f) => f.rule && !ruleProblems(f.rule, idx).length);
  const owners = [];
  for (const c of analysis.components) {
    for (const e of c.evidence ?? []) owners.push({ id: c.id, path: e.path.replace(/\/+$/, '') });
  }
  const goModule = existsSync(join(repoRoot, 'go.mod'))
    ? readFileSync(join(repoRoot, 'go.mod'), 'utf8').match(/^module\s+(\S+)/m)?.[1] ?? null
    : null;

  const violations = [];
  let imports = 0;
  let unresolved = 0;
  const edges = new Map(); // "a>b" -> [{file, line, spec}]
  const files = sourceFiles(repoRoot);
  for (const file of files) {
    const from = ownerOf(file, owners);
    if (!from) continue;
    const text = readFileSync(join(repoRoot, file), 'utf8');
    for (const imp of importsIn(text, file)) {
      imports += 1;
      const target = resolveImport(imp.spec, file, repoRoot, { goModule });
      if (!target) {
        // Packages and the standard library are not edges in this model.
        if (!/^\.|^\//.test(imp.spec) && !(goModule && imp.spec.startsWith(goModule))) continue;
        unresolved += 1;
        continue;
      }
      const to = ownerOf(target, owners);
      if (!to || to === from) continue;
      const key = `${from}>${to}`;
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push({ file, line: imp.line, spec: imp.spec, target });
    }
  }

  for (const fact of rules) {
    const rule = fact.rule;
    for (const [key, sites] of edges) {
      const [a, b] = key.split('>');
      let broken = false;
      if (rule.kind === 'no-relation') {
        broken = membersOf(idx, rule.from).includes(a) && membersOf(idx, rule.to).includes(b);
      } else {
        const to = membersOf(idx, rule.to);
        const via = rule.via.flatMap((id) => membersOf(idx, id));
        broken = to.includes(b) && !via.includes(a) && !to.includes(a);
      }
      if (broken) violations.push({ fact, from: a, to: b, sites });
    }
  }

  // Edges the code has that the analysis does not declare are not a rule
  // violation, but they are the thing a rule is most often about to miss.
  const declared = new Set(analysis.relations.map((r) => `${r.from}>${r.to}`));
  const undeclared = [...edges].filter(([key]) => !declared.has(key)).map(([key, sites]) => ({ from: key.split('>')[0], to: key.split('>')[1], sites }));

  return { violations, undeclared, rules: rules.length, files: files.length, imports, unresolved };
}

export function renderEnforce(modelFindings, codeResult, analysis) {
  const idx = index(analysis);
  const name = (id) => idx.components.get(id)?.name ?? id;
  const out = [];
  const w = (line = '') => out.push(line);

  const rules = (analysis.facts ?? []).filter((f) => f.rule);
  w(`rules    ${rules.length} checkable constraint(s)`);
  if (codeResult) w(`scanned  ${codeResult.files} source file(s), ${codeResult.imports} import(s) in cited code, ${codeResult.unresolved} not resolved`);
  w();

  if (modelFindings.length) {
    w('The analysis contradicts its own constraints:');
    for (const f of modelFindings) w(`  ${f.fact.id}: ${f.message}`);
    w();
  }
  if (codeResult?.violations.length) {
    w('The code breaks a constraint:');
    for (const v of codeResult.violations) {
      w(`  ${v.fact.id}  ${v.fact.claim}`);
      w(`    ${name(v.from)} imports ${name(v.to)}:`);
      for (const s of v.sites.slice(0, 6)) w(`      ${s.file}:${s.line}  ${s.spec}`);
      if (v.sites.length > 6) w(`      … and ${v.sites.length - 6} more`);
    }
    w();
  }
  if (codeResult?.undeclared.length) {
    w('Edges in the code the analysis does not declare — not violations, but undocumented:');
    for (const u of codeResult.undeclared) w(`  ${name(u.from)} -> ${name(u.to)}  (${u.sites.length} import(s), e.g. ${u.sites[0].file}:${u.sites[0].line})`);
    w();
  }
  if (!modelFindings.length && !codeResult?.violations.length) {
    w(rules.length ? 'Every constraint holds.' : 'No constraint carries a rule, so nothing was checked. Add `rule` to a constraint fact.');
  }
  return `${out.join('\n')}\n`;
}
