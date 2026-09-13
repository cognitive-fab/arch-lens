// Where archify is, and how to talk to it.
//
// archify is a dependency, not a fork. It ships no package export surface worth
// binding, so it is found by a directory probe and driven by its own CLI in JSON
// mode. The probe checks for a marker file rather than a directory name, because
// a folder called `archify` containing something else is the failure that
// actually happens.
//
// An explicit override is used or it throws. Falling back from a bad override
// would quietly render with a different archify than the one the caller named.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const MARKER = ['bin', 'archify.mjs'];

const CANDIDATES = () => [
  process.env.ARCHLENS_ARCHIFY,
  join(homedir(), '.claude', 'skills', 'archify'),
  join(homedir(), '.cursor', 'skills', 'archify'),
  join(homedir(), '.codex', 'skills', 'archify'),
  join(homedir(), '.config', 'opencode', 'skill', 'archify'),
  resolve(process.cwd(), 'node_modules', 'archify'),
];

const has = (dir) => Boolean(dir) && existsSync(join(dir, ...MARKER));

/** Absolute path to an archify checkout, or a named failure. */
export function archifyRoot() {
  const override = process.env.ARCHLENS_ARCHIFY;
  if (override) {
    if (!has(override)) {
      throw new Error(`ARCHLENS_ARCHIFY is set to "${override}", which is not an archify checkout (no bin/archify.mjs)`);
    }
    return resolve(override);
  }
  for (const dir of CANDIDATES()) {
    if (has(dir)) return resolve(dir);
  }
  throw new Error(
    'could not find archify. Install it as a skill (npx skills add tt-a1i/archify -g) ' +
    'or set ARCHLENS_ARCHIFY to a checkout containing bin/archify.mjs',
  );
}

/**
 * Run one archify subcommand in JSON mode.
 *
 * A non-zero exit is NOT an exception here: archify reports a failed validation
 * on stdout as JSON with `ok:false`, and that report is the thing the repair loop
 * exists to read. Only an unparseable reply is a crash.
 */
export function runArchify(args, { cwd } = {}) {
  const bin = join(archifyRoot(), ...MARKER);
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, [bin, ...args], {
      cwd: cwd ?? process.cwd(),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    stdout = error.stdout ?? '';
    status = error.status ?? 1;
    if (!stdout.trim()) {
      throw new Error(`archify ${args[0]} failed with no JSON reply: ${(error.stderr || error.message).toString().trim()}`);
    }
  }
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error(`archify ${args[0]} did not return JSON:\n${stdout.slice(0, 800)}`);
  }
  return { report, status };
}

// `--repo-root` is evidence verification, and archify accepts it for architecture
// diagrams only; a sequence carries no source links, so the flag is not sent.
const evidenceArgs = (type, repoRoot) => (type === 'architecture' && repoRoot ? ['--repo-root', repoRoot] : []);

export const validate = (specPath, { repoRoot, type = 'architecture' } = {}) =>
  runArchify([
    'validate', type, specPath, '--quality', 'showcase', '--json',
    ...evidenceArgs(type, repoRoot),
  ]).report;

export const deliver = (specPath, outPath, { repoRoot, type = 'architecture' } = {}) =>
  runArchify([
    'deliver', type, specPath, outPath, '--quality', 'showcase', '--json',
    ...evidenceArgs(type, repoRoot),
  ]).report;

export const visualCheck = (htmlPath) => runArchify(['visual-check', htmlPath, '--json']).report;

export const compare = (basePath, headPath, outPath, { repoRoot } = {}) =>
  runArchify([
    'compare', 'architecture', basePath, headPath, outPath, '--quality', 'showcase', '--json',
    ...(repoRoot ? ['--repo-root', repoRoot] : []),
  ]).report;
