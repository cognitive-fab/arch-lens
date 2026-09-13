// The change, as git tells it.
//
// Two shapes of question: "what is in my working tree that HEAD does not have"
// (no base) and "what does this branch change against that one" (a base). Both
// come back as the same list of files with the line ranges that moved, which is
// all the review needs to know.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** New-side line ranges from a unified diff with zero context. */
export function hunksOf(diffText) {
  const out = [];
  for (const m of diffText.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    // A pure deletion has count 0; it still marks a place in the new file.
    out.push([start, start + Math.max(count, 1) - 1]);
  }
  return out;
}

/**
 * Changed files with their hunks.
 *
 * @param {string} repoRoot
 * @param {{base?: string}} [options]  a ref to compare against; without one,
 *   the working tree (staged, unstaged and untracked) is read against HEAD
 * @returns {Array<{path: string, status: string, hunks: Array<[number, number]>}>}
 */
export function changesIn(repoRoot, { base } = {}) {
  const range = base ? [`${base}...HEAD`] : ['HEAD'];
  // A repository with no commits yet has no HEAD to diff against: everything
  // in it is new, which is a fine answer for a review.
  if (!base && !hasHead(repoRoot)) {
    const tracked = git(repoRoot, ['ls-files']).trim().split('\n');
    const untracked = git(repoRoot, ['ls-files', '--others', '--exclude-standard']).trim().split('\n');
    return [...tracked, ...untracked].filter(Boolean).map((path) => ({ path: path.replace(/\\/g, '/'), status: 'A', hunks: [] }));
  }
  const status = git(repoRoot, ['diff', '--name-status', '-M', ...range]).trim();
  const changes = [];
  for (const line of status.split('\n').filter(Boolean)) {
    const [code, ...paths] = line.split('\t');
    const path = paths[paths.length - 1];
    changes.push({ path: path.replace(/\\/g, '/'), status: code[0], hunks: [] });
  }
  if (!base) {
    const untracked = git(repoRoot, ['ls-files', '--others', '--exclude-standard']).trim();
    for (const path of untracked.split('\n').filter(Boolean)) {
      changes.push({ path: path.replace(/\\/g, '/'), status: 'A', hunks: [] });
    }
  }
  for (const change of changes) {
    if (change.status === 'D' || !existsSync(join(repoRoot, change.path))) continue;
    try {
      const diff = change.status === 'A' && !base
        ? git(repoRoot, ['diff', '--no-index', '-U0', '--', '/dev/null', change.path])
        : git(repoRoot, ['diff', '-U0', ...range, '--', change.path]);
      change.hunks = hunksOf(diff);
    } catch (error) {
      // `diff --no-index` exits 1 when the files differ, which they do.
      change.hunks = hunksOf(error.stdout ?? '');
    }
  }
  return changes;
}

function hasHead(repoRoot) {
  try {
    git(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/** Whether a repository-relative path exists in the working tree. */
export const existsIn = (repoRoot) => (path) => existsSync(join(repoRoot, path));
