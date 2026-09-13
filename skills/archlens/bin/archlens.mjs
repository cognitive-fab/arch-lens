#!/usr/bin/env node
// archlens — an architecture analysis, rendered.
//
// Findings first: every command reports what it could not do before it reports
// what it did, because a diagram that quietly dropped a boundary is worse than
// one that failed.

import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, relative as relativePath, posix } from 'node:path';

import { loadAnalysis, validateAnalysis, index } from '../src/model.mjs';
import { compileQuestion, compileAll } from '../src/compile.mjs';
import { repair, compactVertically } from '../src/repair.mjs';
import { widenSequence } from '../src/sequence.mjs';
import { renderMarkdown } from '../src/markdown.mjs';
import { archifyRoot, deliver, visualCheck, compare } from '../src/archify.mjs';
import { injectBrief } from '../src/brief.mjs';
import { ask, renderAsk } from '../src/ask.mjs';
import { review, renderReview } from '../src/review.mjs';
import { changesIn, existsIn } from '../src/git.mjs';
import { seedCompose, seedWorkspaces } from '../src/seed.mjs';
import { parseYaml } from '../src/yaml.mjs';
import { checkDrift, renderDrift } from '../src/drift.mjs';
import { diffAnalyses, renderDiff } from '../src/diff.mjs';
import { checkRulesAgainstModel, checkRulesAgainstCode, renderEnforce } from '../src/rules.mjs';

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

  archlens ask <analysis.json> "<question>" [--json]
      Gather what the analysis says about a question — components, relations,
      facts, questions already answered, terms — each with its evidence, and
      name what the question asks about that the analysis never mentions.

  archlens review <analysis.json> --repo-root <dir> [--base <ref>] [--json]
      Read a change against the analysis: which components its files are
      evidence for, which boundaries it spans and what they claim, which
      relations and diagrams to re-check, and which changed files the analysis
      has no component for. Without --base, the working tree against HEAD.

  archlens seed <compose.yml | package.json | pnpm-workspace.yaml> [out.analysis.json]
                                            [--name <system name>] [--repo-root <dir>]
      Draft an analysis from what the repository already states: compose
      services and what each waits for, or workspace packages and what each
      imports. Every responsibility is a TODO the validator will keep warning
      about until it is written.

  archlens check <analysis.json> --repo-root <dir> [--json]
      Is the analysis still true of the code? Re-resolve every evidence
      reference against the working tree and, when the pinned revision is
      available, report what changed since it. Exits 1 when a citation points
      at nothing — the check to run in CI.

  archlens compare <base.analysis.json> <head.analysis.json> [out-dir] [--repo-root <dir>]
      What changed between two analyses: components, relations, boundaries,
      facts and questions, added, removed and changed. With an out-dir, also
      render archify's visual comparison for every architecture question the
      two have in common.

  archlens enforce <analysis.json> [--repo-root <dir>] [--json]
      Check every constraint that carries a rule: against the analysis's own
      relations, and with --repo-root against the imports in the code each
      component's evidence cites. Exits 1 on a violation.

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
    case 'ask': return cmdAsk();
    case 'review': return cmdReview();
    case 'seed': return cmdSeed();
    case 'check': return cmdCheck();
    case 'compare': return cmdCompare();
    case 'enforce': return cmdEnforce();
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
    if (spec.diagram_type === 'sequence') {
      say(`  draws    a sequence: ${spec.participants.length} participants, ${spec.messages.length} messages, ${(spec.segments || []).length} phases`);
    } else {
      say(`  draws    ${spec.components.length} components, ${spec.connections.length} relations, ${(spec.boundaries || []).length} boundaries`);
    }
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

  const idx = index(analysis);
  const produced = new Map();
  let failures = 0;

  for (const target of targets) {
    const type = target.spec.diagram_type;
    const stem = `${target.id}.${type}`;
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

    const delivery = deliver(specPath, htmlPath, { repoRoot: repoRoot ?? undefined, type });
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
      // collision that was already settled. A sequence owns no rows to pull;
      // it widens instead, and the reader's fit-to-width makes it shorter.
      let check = visualCheck(htmlPath);
      for (let attempt = 1; attempt <= 3 && !check.ok; attempt += 1) {
        if (type === 'sequence') {
          say(`  browser  overflows; widening the sequence (attempt ${attempt} of 3)`);
          widenSequence(target.spec, 1.15);
        } else {
          say(`  browser  overflows; pulling the rows together (attempt ${attempt} of 3)`);
          compactVertically(target.spec, 0.8);
        }
        const again = repair(target.spec, specPath, { repoRoot });
        if (!again.ok) break;
        const redelivered = deliver(specPath, htmlPath, { repoRoot: repoRoot ?? undefined, type });
        if (!redelivered.ok) break;
        check = visualCheck(htmlPath);
      }
      say(`  browser  ${check.ok ? 'contained at every checked viewport' : 'STILL OVERFLOWING — open it and look'}`);
      if (!check.ok) failures += 1;
    }

    // After the check loop, never before: a re-delivery would overwrite it.
    if (injectBrief(htmlPath, target.question, analysis, idx)) {
      say('  brief    context, narrative and glossary added below the diagram');
    } else if (!target.question.context && !target.question.narrative) {
      say('  brief    none — the question has no context or narrative to add');
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
      const rel = `${q.id}.${q.shape ?? 'architecture'}.html`;
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

function cmdAsk() {
  const { analysis } = readAnalysis();
  const question = positional.slice(1).join(' ').trim();
  if (!question) fail('a question is required, in quotes');
  const result = ask(analysis, question);
  if (has('json')) {
    const { idx, ...rest } = result;
    const plain = {
      ...rest,
      components: rest.components.map((m) => ({ id: m.component.id, score: m.score, matched: [...m.found] })),
      relations: rest.relations.map((m) => ({ from: m.relation.from, to: m.relation.to, score: m.score, matched: [...m.found] })),
      facts: rest.facts.map((m) => ({ id: m.fact.id, score: m.score, matched: [...m.found] })),
      questions: rest.questions.map((m) => ({ id: m.question.id, score: m.score, matched: [...m.found] })),
      boundaries: rest.boundaries.map((m) => ({ id: m.boundary.id, score: m.score, matched: [...m.found] })),
      glossary: rest.glossary.map((t) => t.term),
    };
    return say(JSON.stringify(plain, null, 2));
  }
  process.stdout.write(renderAsk(result));
  // Exit 3 means "the analysis does not have this", for a caller that must not
  // answer from anything else.
  if (result.empty || result.coverage < 0.5) process.exit(3);
}

function cmdReview() {
  const { analysis } = readAnalysis();
  const repoRoot = flag('repo-root') ? resolve(flag('repo-root')) : null;
  if (!repoRoot) fail('--repo-root is required: the change is read from git there');
  const base = flag('base') ?? undefined;
  const changes = changesIn(repoRoot, { base });
  const result = review(analysis, changes, { exists: existsIn(repoRoot) });
  if (has('json')) {
    const { idx, ...rest } = result;
    return say(JSON.stringify({
      ...rest,
      touched: rest.touched.map((t) => ({ id: t.component.id, files: t.files })),
      relationsChanged: rest.relationsChanged.map((m) => ({ from: m.relation.from, to: m.relation.to, path: m.path, how: m.how })),
      questions: rest.questions.map((m) => ({ id: m.question.id, touched: m.touched })),
      boundaries: rest.boundaries.map((m) => ({ id: m.boundary.id, claim: m.boundary.claim, touched: m.touched })),
      relationsBetween: rest.relationsBetween.map((r) => ({ from: r.from, to: r.to })),
      crossingsFrom: rest.crossingsFrom.map((r) => ({ from: r.from, to: r.to, crosses: r.crosses })),
      facts: rest.facts.map((f) => f.id),
      gone: rest.gone.map((g) => ({ id: g.component.id, path: g.path })),
    }, null, 2));
  }
  process.stdout.write(renderReview(result));
  // Exit 2: the analysis now cites something that is not there.
  if (result.gone.length) process.exit(2);
}

function cmdSeed() {
  const input = positional[0];
  if (!input) fail('an input file is required: a compose file, a package.json with workspaces, or pnpm-workspace.yaml');
  const inputPath = resolve(input);
  // Evidence is repository-relative, and `review` will later compare it with
  // what git reports, so the root has to be the repository's — not the input's
  // directory, which for deploy/docker-compose.yml would be one level wrong.
  const repoRoot = flag('repo-root') ? resolve(flag('repo-root')) : gitRootOf(dirname(inputPath)) ?? dirname(inputPath);
  const rel = (p) => p.replace(/\\/g, '/');
  const relative = (abs) => {
    const r = rel(relativePath(repoRoot, abs));
    if (r.startsWith('../') || r === '..' || /^[A-Za-z]:/.test(r)) {
      fail(`"${input}" is not under the repository root ${repoRoot}; pass --repo-root to the directory the evidence should be relative to`);
    }
    return r;
  };
  const base = input.split(/[\\/]/).pop();
  const name = flag('name') ?? undefined;

  let seeded;
  if (/compose.*\.ya?ml$/i.test(base) || /\.ya?ml$/i.test(base) && !/pnpm-workspace/.test(base)) {
    seeded = seedCompose(readFileSync(inputPath, 'utf8'), relative(inputPath), { name });
  } else if (base === 'package.json' || /pnpm-workspace\.ya?ml$/.test(base)) {
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    let patterns = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces?.packages ?? [];
    if (/pnpm-workspace/.test(base)) patterns = parseYaml(readFileSync(inputPath, 'utf8'))?.packages ?? [];
    if (!patterns.length) fail(`${input} declares no workspaces`);
    const members = [];
    for (const pattern of patterns) {
      if (String(pattern).startsWith('!')) continue;
      for (const dir of expandWorkspace(repoRoot, String(pattern))) {
        const pkgPath = join(repoRoot, dir, 'package.json');
        if (!existsSync(pkgPath)) continue;
        members.push({ dir: rel(dir), pkg: JSON.parse(readFileSync(pkgPath, 'utf8')) });
      }
    }
    if (!members.length) fail('no workspace package.json files found under the declared patterns');
    seeded = seedWorkspaces(rootPkg, members, { name });
  } else {
    fail(`do not know how to seed from "${base}": expected a compose file, package.json, or pnpm-workspace.yaml`);
  }

  const { analysis, notes } = seeded;
  const out = positional[1];
  // With no output path the analysis goes to stdout, so the commentary must not.
  const tell = out ? say : (line) => process.stderr.write(`${line}
`);
  for (const n of notes) tell(`note     ${n}`);
  const result = validateAnalysis(analysis);
  for (const e of result.errors) tell(`error    ${e.where}: ${e.message}`);
  const todos = result.warnings.filter((w) => /TODO/.test(w.message)).length;
  tell(`seeded   ${analysis.components.length} components, ${analysis.relations.length} relations, ${(analysis.boundaries ?? []).length} boundaries, ${analysis.questions.length} question(s)`);
  tell(`todo     ${todos} sentence(s) to write before this is an analysis; validate will list them`);
  const json = `${JSON.stringify(analysis, null, 2)}\n`;
  if (!out) return process.stdout.write(json);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), json, 'utf8');
  say(`wrote    ${resolve(out)}`);
}

/**
 * `packages/*` and friends: a literal directory, or one directory level with a
 * star somewhere in its last segment (`apps/*`, `apps/*-app`, `*`). Deeper
 * globs are refused rather than half-matched, and every result is a clean
 * repository-relative path with no leading `./` or `/`.
 */
function expandWorkspace(repoRoot, pattern) {
  const clean = posix.normalize(pattern.replace(/\\/g, '/')).replace(/^\.\/?/, '').replace(/\/+$/, '').replace(/\/\*\*$/, '/*');
  if (clean === '.' || clean === '') return [];
  if (!clean.includes('*')) return existsSync(join(repoRoot, clean)) ? [clean] : [];
  const parts = clean.split('/');
  const last = parts.pop();
  const parent = parts.join('/');
  if (parent.includes('*') || last === '**') {
    fail(`workspace pattern "${pattern}" is deeper than one directory level of glob, which seed does not expand`);
  }
  const dir = parent ? join(repoRoot, parent) : repoRoot;
  if (!existsSync(dir)) return [];
  const matcher = new RegExp(`^${last.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && matcher.test(d.name))
    .map((d) => (parent ? `${parent}/${d.name}` : d.name));
}

/** The repository root above a directory, or null when git has no opinion. */
function gitRootOf(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function cmdCheck() {
  const { analysis } = readAnalysis();
  const repoRoot = flag('repo-root') ? resolve(flag('repo-root')) : null;
  if (!repoRoot) fail('--repo-root is required: the evidence is resolved there');
  const result = checkDrift(analysis, repoRoot);
  if (has('json')) {
    const strip = (list) => list.map(({ owner, evidence, ...rest }) => ({ ...rest, line: evidence.line, end_line: evidence.end_line }));
    return say(JSON.stringify({ ...result, gone: strip(result.gone), moved: strip(result.moved), built: strip(result.built) }, null, 2));
  }
  process.stdout.write(renderDrift(result));
  if (!result.ok) process.exit(1);
}

function cmdCompare() {
  const [basePath, headPath, outDir] = positional;
  if (!basePath || !headPath) fail('two analysis files are required: the base and the head');
  const base = loadAnalysis(resolve(basePath)).analysis;
  const head = loadAnalysis(resolve(headPath)).analysis;
  const result = diffAnalyses(base, head);
  process.stdout.write(renderDiff(result, base, head));
  if (!outDir) return;

  // The visual comparison is archify's, one per architecture question both
  // analyses ask. A question only one of them asks has nothing to compare to.
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const repoRoot = flag('repo-root') ? resolve(flag('repo-root')) : undefined;
  const shared = head.questions.filter((q) => (q.shape ?? 'architecture') === 'architecture' && base.questions.some((b) => b.id === q.id));
  let failures = 0;
  for (const q of shared) {
    const a = compileQuestion(base, q.id).spec;
    const b = compileQuestion(head, q.id).spec;
    const aPath = join(dir, `${q.id}.base.architecture.json`);
    const bPath = join(dir, `${q.id}.head.architecture.json`);
    const html = join(dir, `${q.id}.compare.html`);
    // The comparator wants two specifications that pass, so each side goes
    // through the same repair loop a render would give it.
    const fixed = [repair(a, aPath, { repoRoot }), repair(b, bPath, { repoRoot })];
    if (!fixed.every((r) => r.ok)) {
      failures += 1;
      say(`— ${q.id}: FAILED the ${fixed[0].ok ? 'head' : 'base'} specification did not pass the renderer's checks`);
      continue;
    }
    const report = compare(aPath, bPath, html, { repoRoot });
    if (!report.ok) {
      failures += 1;
      say(`— ${q.id}: FAILED ${report.error ?? (report.diagnostics ?? []).map((d) => d.message).join('; ') ?? 'unknown error'}`);
      continue;
    }
    const s = report.summary ?? {};
    const c = s.components ?? {};
    const k = s.connections ?? {};
    say(`— ${q.id}: components +${c.added ?? 0} -${c.removed ?? 0} ~${c.changed ?? 0}, connections +${k.added ?? 0} -${k.removed ?? 0} ~${k.changed ?? 0}`);
    say(`  wrote    ${html}`);
  }
  if (!shared.length) say('no architecture question is asked by both analyses, so there is nothing to draw');
  if (failures) process.exit(2);
}

function cmdEnforce() {
  const { analysis } = readAnalysis();
  const repoRoot = flag('repo-root') ? resolve(flag('repo-root')) : null;
  const model = checkRulesAgainstModel(analysis);
  const code = repoRoot ? checkRulesAgainstCode(analysis, repoRoot) : null;
  if (has('json')) {
    return say(JSON.stringify({
      model: model.map((m) => ({ fact: m.fact.id, from: m.relation.from, to: m.relation.to, message: m.message })),
      code: code && {
        ...code,
        violations: code.violations.map((v) => ({ fact: v.fact.id, from: v.from, to: v.to, sites: v.sites })),
      },
    }, null, 2));
  }
  process.stdout.write(renderEnforce(model, code, analysis));
  if (model.length || code?.violations.length) process.exit(1);
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
