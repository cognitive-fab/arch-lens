#!/usr/bin/env node
// Assemble the skill directory.
//
// A skill is a self-contained folder: an agent reads SKILL.md and then runs the
// commands it names, relative to that folder. Copying SKILL.md alone produces a
// skill that reads perfectly and cannot execute a single instruction in it —
// which is exactly what shipped the first time, so this script exists to make
// installing reproducible rather than something done by hand from memory.
//
//   node scripts/install-skill.mjs                 # every agent found
//   node scripts/install-skill.mjs ~/somewhere/x   # one explicit target

import { cpSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** What the skill needs at runtime. SKILL.md is copied last, from skills/. */
const PAYLOAD = ['bin', 'src', 'schemas', 'examples', 'docs', 'package.json', 'README.md'];

/** Agent skill directories, by the folder that proves the agent is installed. */
const TARGETS = [
  { agent: 'Claude Code', probe: join(homedir(), '.claude'), dir: join(homedir(), '.claude', 'skills', 'archlens') },
  { agent: 'Cursor', probe: join(homedir(), '.cursor'), dir: join(homedir(), '.cursor', 'skills', 'archlens') },
  { agent: 'Codex', probe: join(homedir(), '.codex'), dir: join(homedir(), '.codex', 'skills', 'archlens') },
  { agent: 'OpenCode', probe: join(homedir(), '.config', 'opencode'), dir: join(homedir(), '.config', 'opencode', 'skill', 'archlens') },
];

const explicit = process.argv[2];
const targets = explicit
  ? [{ agent: 'explicit target', probe: null, dir: resolve(explicit) }]
  : TARGETS.filter((t) => existsSync(t.probe));

if (targets.length === 0) {
  process.stderr.write('no agent directory found; pass one explicitly\n');
  process.exit(1);
}

for (const target of targets) {
  // Replace rather than merge: a stale file from an older version is worse than
  // a missing one, because it still answers when something reads it.
  if (existsSync(target.dir)) rmSync(target.dir, { recursive: true, force: true });
  mkdirSync(target.dir, { recursive: true });

  for (const entry of PAYLOAD) {
    const from = join(root, entry);
    if (!existsSync(from)) continue;
    cpSync(from, join(target.dir, entry), { recursive: true });
  }
  cpSync(join(root, 'skills', 'archlens', 'SKILL.md'), join(target.dir, 'SKILL.md'));

  const installed = readdirSync(target.dir).sort().join(', ');
  process.stdout.write(`${target.agent}\n  ${target.dir}\n  ${installed}\n`);
}

process.stdout.write('\nVerify with:\n  node <skill-dir>/bin/archlens.mjs doctor\n');
