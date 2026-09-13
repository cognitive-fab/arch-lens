// Is the analysis still true of the code?
//
// An analysis pins a revision and cites evidence. Both go stale the moment the
// repository moves, and nothing in the file can tell you. This re-resolves
// every citation against the working tree and, when the pinned revision is
// available, asks git what happened to each cited file since — so the answer
// to "can we still trust this document" is a list, not a feeling.
//
// Three findings, in order of how much they matter:
//   gone     a cited path no longer exists, or a cited line range runs past
//            the end of the file. The analysis points at nothing.
//   built    a component marked planned whose evidence now resolves.
//            Either it got built and the status is stale, or the evidence was
//            speculative and should not have been there.
//   moved    a cited file changed since the pinned revision. The claim may
//            still hold; someone has to look.
// Plus the revision itself: how far HEAD is from the pin, and what to do.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Every citation in the analysis, with what it belongs to. */
export function citations(analysis) {
  const out = [];
  const add = (owner, kind, list) => {
    for (const e of list ?? []) out.push({ owner, kind, evidence: e });
  };
  for (const c of analysis.components) add(c, 'component', c.evidence);
  for (const r of analysis.relations) add(r, 'relation', r.evidence);
  for (const b of analysis.boundaries ?? []) add(b, 'boundary', b.evidence);
  for (const f of analysis.facts ?? []) add(f, 'fact', f.evidence);
  return out;
}

const label = (cite) => {
  const o = cite.owner;
  if (cite.kind === 'relation') return `${o.from} -> ${o.to}`;
  return o.id;
};

/**
 * Check every citation against a repository.
 *
 * @param {object} analysis
 * @param {string} repoRoot
 * @returns {object}
 */
export function checkDrift(analysis, repoRoot) {
  const pinned = analysis.system.repository?.revision ?? null;
  const head = safe(() => git(repoRoot, ['rev-parse', 'HEAD']).trim());
  const pinAvailable = Boolean(pinned && head && safe(() => git(repoRoot, ['cat-file', '-e', `${pinned}^{commit}`]) !== null));
  const ahead = pinAvailable ? Number(safe(() => git(repoRoot, ['rev-list', '--count', `${pinned}..HEAD`]).trim()) ?? 0) : null;

  // One git call for everything that changed since the pin, not one per file.
  const changedSince = new Map(); // path -> status letter
  if (pinAvailable) {
    const out = safe(() => git(repoRoot, ['diff', '--name-status', '-M', pinned, 'HEAD'])) ?? '';
    for (const line of out.split('\n').filter(Boolean)) {
      const [code, ...paths] = line.split('\t');
      const from = paths[0];
      const to = paths[paths.length - 1];
      changedSince.set(from.replace(/\\/g, '/'), code[0]);
      if (to !== from) changedSince.set(to.replace(/\\/g, '/'), code[0]);
    }
  }

  const gone = [];
  const moved = [];
  const built = [];
  const fine = [];
  const lineCount = new Map();
  const linesOf = (path) => {
    if (!lineCount.has(path)) {
      lineCount.set(path, readFileSync(join(repoRoot, path), 'utf8').split('\n').length);
    }
    return lineCount.get(path);
  };

  for (const cite of citations(analysis)) {
    const path = cite.evidence.path.replace(/\/+$/, '');
    const abs = join(repoRoot, path);
    const entry = { ...cite, path, what: label(cite) };
    if (!existsSync(abs)) {
      gone.push({ ...entry, reason: changedSince.get(path) === 'D' ? 'deleted since the pinned revision' : 'not in the working tree' });
      continue;
    }
    if (cite.evidence.line && statSync(abs).isFile()) {
      const last = cite.evidence.end_line ?? cite.evidence.line;
      const n = linesOf(path);
      if (last > n) {
        gone.push({ ...entry, reason: `cites lines ${cite.evidence.line}–${last} but the file has ${n}` });
        continue;
      }
    }
    // Anything under a cited directory counts as a change to the citation.
    const changed = [...changedSince.keys()].find((p) => p === path || p.startsWith(`${path}/`));
    if (changed) moved.push({ ...entry, changed, status: changedSince.get(changed) });
    else fine.push(entry);

    // Partial is expected to have evidence; planned is not, and when it does,
    // either the status is stale or the citation was a guess.
    if (cite.kind === 'component' && cite.owner.status === 'planned') built.push({ ...entry, status: 'planned' });
  }

  // Deduplicate `built`: one line per component, not per citation.
  const seen = new Set();
  const builtOnce = built.filter((b) => (seen.has(b.owner.id) ? false : seen.add(b.owner.id)));

  return {
    pinned,
    head,
    pinAvailable,
    ahead,
    total: gone.length + moved.length + fine.length,
    gone,
    moved,
    built: builtOnce,
    fine: fine.length,
    ok: gone.length === 0,
  };
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

export function renderDrift(result) {
  const out = [];
  const w = (line = '') => out.push(line);

  if (result.pinned) {
    const pin = result.pinned.slice(0, 7);
    if (!result.head) w(`pinned   ${pin}; no git HEAD here to compare with`);
    else if (!result.pinAvailable) w(`pinned   ${pin}, which this clone does not have; only existence was checked`);
    else if (result.ahead === 0) w(`pinned   ${pin}, which is HEAD`);
    else w(`pinned   ${pin}; HEAD ${result.head.slice(0, 7)} is ${result.ahead} commit(s) past it`);
  } else {
    w('pinned   nothing — the analysis names no repository revision, so only existence was checked');
  }
  w(`cited    ${result.total} evidence reference(s): ${result.fine} unchanged, ${result.moved.length} changed, ${result.gone.length} gone`);
  w();

  if (result.gone.length) {
    w('Gone — the analysis points at nothing:');
    for (const g of result.gone) w(`  ${g.kind} ${g.what}  ${g.path}  (${g.reason})`);
    w();
  }
  if (result.built.length) {
    w('Marked planned, but the evidence resolves — built since, or never evidence:');
    for (const b of result.built) w(`  ${b.what} (${b.status})  ${b.path}`);
    w();
  }
  if (result.moved.length) {
    w('Changed since the pinned revision — the claim may still hold; look:');
    for (const m of result.moved) {
      const note = m.changed !== m.path ? ` (${m.changed})` : '';
      w(`  ${m.kind} ${m.what}  ${m.path}${note}`);
    }
    w();
  }
  if (result.ok && result.moved.length === 0 && result.built.length === 0) {
    w('Nothing has moved. The analysis is as true of HEAD as it was of the pin.');
  } else if (result.ok) {
    w('Nothing is gone. Re-read the changed citations; if the claims hold, move the pin to HEAD.');
  } else {
    w('Fix the gone citations before the analysis is trusted again.');
  }
  return `${out.join('\n')}\n`;
}
