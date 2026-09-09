#!/usr/bin/env node
// archlens — an architecture analysis, rendered.
//
// Findings first: every command reports what it could not do before it reports
// what it did, because a diagram that quietly dropped a boundary is worse than
// one that failed.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { loadAnalysis, validateAnalysis } from '../src/model.mjs';
import { compileQuestion, compileAll } from '../src/compile.mjs';
import { repair, compactVertically } from '../src/repair.mjs';
import { renderMarkdown } from '../src/markdown.mjs';
import { archifyRoot, deliver, visualCheck } from '../src/archify.mjs';

const USAGE = `archlens — an architecture analysis, rendered

  archlens validate <analysis.json>
      Check the analysis for referential errors and thin spots.

  archlens questions <analysis.json>
      List the questions and what each one would draw.

  archlens render <analysis.json> <out-dir> [--question <id>] [--repo-root <dir>]
                                            [--no-check] [--collapse]
      Compile every question to an archify specification, repair it against the
      renderer's diagnostics, deliver the HTML, and check it in a browser.

  archlens doc <analysis.json> [out.md] [--diagrams <dir>]
      Render the analysis as a markdown architecture document.

  archlens doctor
      Report where archify was found and whether it runs.
`;

const args = process.argv.slice(2);
const command = args[0];

const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);
const positional = args.slice(1).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));

const say = (line = '') => process.stdout.write(`${line}\n`);
const fail = (line) => {
  process.stderr.write(`${line}\n`);
  process.exit(1);
};

try {
  await main();
} catch (error) {
  fail(error.message);
}

async function main() {
  switch (command) {
    case 'validate': return cmdValidate();
    case 'questions': return cmdQuestions();
    case 'render': return cmdRender();
    case 'doc': return cmdDoc();
    case 'doctor': return cmdDoctor();
    case '--help': case '-h': case undefined: return say(USAGE);
    default: return fail(`unknown command "${command}"\n\n${USAGE}`);
  }
}

function readAnalysis() {
  const path = positional[0];
  if (!path) fail('an analysis file is required');
  return { path: resolve(path), ...loadAnalysis(resolve(path)) };
}

function cmdValidate() {
  const path = positional[0];
  if (!path) fail('an analysis file is required');
  let doc;
  try {
    doc = JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    return fail(`could not read "${path}": ${error.message}`);
  }
  const result = validateAnalysis(doc);
  for (const e of result.errors) say(`error   ${e.where}: ${e.message}${e.fix ? `\n        fix: ${e.fix}` : ''}`);
  for (const wn of result.warnings) say(`warning ${wn.where}: ${wn.message}${wn.fix ? `\n        fix: ${wn.fix}` : ''}`);
  say();
  say(`${result.errors.length} error(s), ${result.warnings.length} warning(s)`);
  if (!result.ok) process.exit(1);
  say(`"${doc.system.name}": ${doc.components.length} components, ${doc.relations.length} relations, ${doc.questions.length} questions.`);
}

function cmdQuestions() {
  const { analysis, warnings } = readAnalysis();
  for (const w of warnings) say(`warning ${w.where}: ${w.message}`);
  if (warnings.length) say();
  for (const q of analysis.questions) {
    const { spec, dropped } = compileQuestion(analysis, q.id);
    say(`${q.id}  ${q.title}`);
    say(`  asks     ${q.ask}`);
    say(`  draws    ${spec.components.length} components, ${spec.connections.length} relations, ${(spec.boundaries || []).length} boundaries`);
    for (const d of dropped) say(`  dropped  ${d}`);
    say();
  }
}

function cmdRender() {
  const { analysis, warnings } = readAnalysis();
  const outDir = positional[1];
  if (!outDir) fail('an output directory is required');
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });

  const repoRoot = flag('repo-root') ? resolve(flag('repo-root')) : null;
  if (analysis.system.repository && !repoRoot) {
    say('note    the analysis names a repository but no --repo-root was given; source links will not be verified');
  }
  for (const w of warnings) say(`warning ${w.where}: ${w.message}`);
  if (warnings.length) say();

  const only = flag('question');
  const targets = only
    ? [{ id: only, ...compileQuestion(analysis, only, { collapse: has('collapse') }) }]
    : compileAll(analysis, { collapse: has('collapse') });

  const produced = new Map();
  let failures = 0;

  for (const target of targets) {
    const stem = `${target.id}.architecture`;
    const specPath = join(dir, `${stem}.json`);
    const htmlPath = join(dir, `${stem}.html`);
    say(`— ${target.id}: ${target.question.title}`);
    for (const d of target.dropped) say(`  dropped  ${d}`);

    const result = repair(target.spec, specPath, {
      repoRoot,
      onRound: ({ round, count }) => {
        if (count > 0) say(`  repair   round ${round}: ${count} diagnostic(s)`);
      },
    });
    for (const a of result.applied) say(`  fixed    ${a}`);

    if (!result.ok) {
      failures += 1;
      say(`  FAILED   ${result.unresolved.length} unresolved diagnostic(s):`);
      for (const d of result.unresolved.slice(0, 5)) say(`           ${(d.message ?? d.code ?? '').split('\n')[0]}`);
      say();
      continue;
    }

    const delivery = deliver(specPath, htmlPath, { repoRoot: repoRoot ?? undefined });
    if (!delivery.ok) {
      failures += 1;
      say(`  FAILED   delivery: ${delivery.error ?? 'unknown error'}`);
      say();
      continue;
    }
    say(`  checks   ${delivery.validation.checksPassed}/${delivery.validation.checkCount}, ${delivery.validation.errors} error(s), ${delivery.validation.warnings} warning(s)`);
    if (delivery.evidence) {
      say(`  evidence ${delivery.evidence.references} source link(s) verified at ${delivery.evidence.revision.slice(0, 7)}`);
    }

    if (!has('no-check')) {
      // Vertical containment is only knowable in a browser, so it is measured
      // after delivery and fixed by pulling the rows together. One pass is not
      // always enough — a tall diagram can need three — and each attempt has to
      // re-run the repair loop, because moving rows can re-open a label
      // collision that was already settled.
      let check = visualCheck(htmlPath);
      for (let attempt = 1; attempt <= 3 && !check.ok; attempt += 1) {
        say(`  browser  overflows; pulling the rows together (attempt ${attempt} of 3)`);
        compactVertically(target.spec, 0.8);
        const again = repair(target.spec, specPath, { repoRoot });
        if (!again.ok) break;
        const redelivered = deliver(specPath, htmlPath, { repoRoot: repoRoot ?? undefined });
        if (!redelivered.ok) break;
        check = visualCheck(htmlPath);
      }
      say(`  browser  ${check.ok ? 'contained at every checked viewport' : 'STILL OVERFLOWING — open it and look'}`);
      if (!check.ok) failures += 1;
    }

    produced.set(target.id, `${stem}.html`);
    say(`  wrote    ${htmlPath}`);
    say();
  }

  const docPath = join(dir, 'README.md');
  writeFileSync(docPath, renderMarkdown(analysis, { diagrams: produced }), 'utf8');
  say(`wrote    ${docPath}`);
  say(`${produced.size}/${targets.length} diagram(s) delivered.`);
  if (failures) process.exit(2);
}

function cmdDoc() {
  const { analysis, warnings } = readAnalysis();
  for (const w of warnings) process.stderr.write(`warning ${w.where}: ${w.message}\n`);
  const diagramsDir = flag('diagrams');
  const diagrams = new Map();
  if (diagramsDir) {
    for (const q of analysis.questions) {
      const rel = `${q.id}.architecture.html`;
      if (existsSync(join(resolve(diagramsDir), rel))) diagrams.set(q.id, rel);
    }
  }
  const markdown = renderMarkdown(analysis, { diagrams });
  const out = positional[1];
  if (!out) return process.stdout.write(markdown);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), markdown, 'utf8');
  say(`wrote ${resolve(out)}`);
}

function cmdDoctor() {
  say('archlens doctor');
  say();
  say(`[ok] Node.js ${process.version}`);
  let root;
  try {
    root = archifyRoot();
    say(`[ok] archify at ${root}`);
  } catch (error) {
    say(`[!!] ${error.message}`);
    process.exit(1);
  }
  say(`[ok] renderer entry ${join(root, 'bin', 'archify.mjs')}`);
  say();
  say('archlens is ready.');
}
