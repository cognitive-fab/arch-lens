// The analysis model: load it, and refuse it when it is not one.
//
// The checks here are the ones a JSON Schema cannot make. Shape is easy and a
// schema would do it; what matters is REFERENTIAL truth — a question that names
// a component nobody declared, a boundary that claims to contain a stranger, a
// relation whose endpoints do not exist. Those are the errors that produce a
// diagram which looks fine and says something false.
//
// There is a second class of check here, and it is the opinionated one: an
// analysis that carries no evidence, or a question with no answer, VALIDATES but
// WARNS. The model is meant to make a thin analysis visibly thin rather than
// quietly renderable.

import { readFileSync } from 'node:fs';

const ID = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

const KINDS = new Set([
  'cli', 'ui', 'api', 'service', 'worker', 'library', 'engine',
  'store', 'file-store', 'queue', 'cache',
  'sandbox', 'gateway', 'broker',
  'model-provider', 'external-service', 'third-party',
  'workflow', 'schema', 'config',
]);

const MECHANISMS = new Set([
  'in-process call', 'http', 'https', 'grpc', 'stdio', 'spawn',
  'file', 'database', 'queue', 'event', 'signal', 'manual',
]);

const BOUNDARY_KINDS = new Set(['trust', 'process', 'network', 'deployment', 'licence', 'ownership']);
const STATUSES = new Set(['built', 'partial', 'planned']);
const FACT_KINDS = new Set(['doctrine', 'guarantee', 'constraint', 'tradeoff', 'risk']);

/** A problem the caller can print. `where` is a JSON-ish path into the document. */
const problem = (severity, where, message, fix) => ({ severity, where, message, ...(fix ? { fix } : {}) });

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, min = 1, max = Infinity) => typeof v === 'string' && v.length >= min && v.length <= max;

/**
 * Validate an analysis document.
 *
 * @param {unknown} doc
 * @returns {{ok: boolean, errors: object[], warnings: object[]}}
 */
export function validateAnalysis(doc) {
  const errors = [];
  const warnings = [];
  const err = (...a) => errors.push(problem('error', ...a));
  const warn = (...a) => warnings.push(problem('warning', ...a));

  if (!isObject(doc)) {
    return { ok: false, errors: [problem('error', '', 'analysis must be a JSON object')], warnings };
  }
  if (doc.schema_version !== 1) {
    err('schema_version', `unsupported schema_version ${JSON.stringify(doc.schema_version)}`, 'set schema_version to 1');
  }

  // --- system -------------------------------------------------------------
  const sys = doc.system;
  if (!isObject(sys)) {
    err('system', 'system is required');
  } else {
    if (!isStr(sys.name)) err('system.name', 'system.name is required');
    if (!isStr(sys.purpose)) err('system.purpose', 'system.purpose is required');
    if (sys.repository) {
      const r = sys.repository;
      if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(r.url || '')) {
        err('system.repository.url', 'repository.url must be a https://github.com/<owner>/<repo> URL');
      }
      if (!/^[a-fA-F0-9]{40}$/.test(r.revision || '')) {
        err('system.repository.revision', 'repository.revision must be a full 40-character commit sha');
      }
    }
    if (!Array.isArray(sys.sources) || sys.sources.length === 0) {
      warn('system.sources', 'the analysis records no sources, so a reader cannot tell what it was derived from',
        'add system.sources entries naming the code paths or documents that were read');
    }
  }

  // --- components ---------------------------------------------------------
  const components = Array.isArray(doc.components) ? doc.components : [];
  if (components.length === 0) err('components', 'at least one component is required');

  const byId = new Map();
  components.forEach((c, i) => {
    const at = `components[${i}]`;
    if (!isObject(c)) return err(at, 'component must be an object');
    if (!ID.test(c.id || '')) err(`${at}.id`, `invalid component id ${JSON.stringify(c.id)}`);
    else if (byId.has(c.id)) err(`${at}.id`, `duplicate component id "${c.id}"`);
    else byId.set(c.id, c);

    if (!isStr(c.name, 1, 40)) err(`${at}.name`, 'name is required and must be at most 40 characters');
    if (!KINDS.has(c.kind)) err(`${at}.kind`, `unknown component kind ${JSON.stringify(c.kind)}`, `use one of: ${[...KINDS].join(', ')}`);
    if (!isStr(c.responsibility)) err(`${at}.responsibility`, 'responsibility is required — one sentence saying what this component is answerable for');
    if (c.detail !== undefined && !isStr(c.detail, 1, 28)) err(`${at}.detail`, 'detail must be at most 28 characters');
    if (c.status !== undefined && !STATUSES.has(c.status)) err(`${at}.status`, `status must be built, partial or planned`);
    const conjunctions = (c.responsibility?.match(/ and /g) || []).length;
    if (conjunctions >= 2 || (c.responsibility && c.responsibility.length > 160)) {
      warn(`${at}.responsibility`, `"${c.name}" reads as more than one responsibility, which usually means it is more than one component`,
        'split it, or accept that the diagram will under-describe it');
    }
    validateEvidence(c.evidence, `${at}.evidence`, err);
  });

  const known = (id) => byId.has(id);

  // --- layers -------------------------------------------------------------
  const layerIds = new Set();
  if (doc.layers !== undefined) {
    if (!Array.isArray(doc.layers)) err('layers', 'layers must be an array');
    else doc.layers.forEach((l, i) => {
      const at = `layers[${i}]`;
      if (!ID.test(l?.id || '')) return err(`${at}.id`, 'invalid layer id');
      if (layerIds.has(l.id)) err(`${at}.id`, `duplicate layer id "${l.id}"`);
      layerIds.add(l.id);
      if (!isStr(l.label)) err(`${at}.label`, 'label is required');
      if (!Number.isInteger(l.order) || l.order < 0) err(`${at}.order`, 'order must be a non-negative integer');
    });
  }
  components.forEach((c, i) => {
    if (c?.layer !== undefined && !layerIds.has(c.layer)) {
      err(`components[${i}].layer`, `component "${c.id}" names layer "${c.layer}", which is not declared`);
    }
  });

  // --- boundaries ---------------------------------------------------------
  const boundaryIds = new Set();
  if (doc.boundaries !== undefined) {
    if (!Array.isArray(doc.boundaries)) err('boundaries', 'boundaries must be an array');
    else doc.boundaries.forEach((b, i) => {
      const at = `boundaries[${i}]`;
      if (!ID.test(b?.id || '')) return err(`${at}.id`, 'invalid boundary id');
      if (boundaryIds.has(b.id)) err(`${at}.id`, `duplicate boundary id "${b.id}"`);
      boundaryIds.add(b.id);
      if (!BOUNDARY_KINDS.has(b.kind)) err(`${at}.kind`, `unknown boundary kind ${JSON.stringify(b.kind)}`);
      if (!isStr(b.label)) err(`${at}.label`, 'label is required');
      if (!isStr(b.claim)) {
        err(`${at}.claim`, `boundary "${b.id}" makes no claim`,
          'say what is true of everything inside and not outside; a box that only groups is decoration');
      }
      if (!Array.isArray(b.contains) || b.contains.length === 0) err(`${at}.contains`, 'contains must list at least one component');
      else b.contains.forEach((id, j) => {
        if (!known(id)) err(`${at}.contains[${j}]`, `boundary "${b.id}" contains unknown component "${id}"`);
      });
      validateEvidence(b.evidence, `${at}.evidence`, err);
    });
  }

  // --- relations ----------------------------------------------------------
  const relations = Array.isArray(doc.relations) ? doc.relations : [];
  if (doc.relations !== undefined && !Array.isArray(doc.relations)) err('relations', 'relations must be an array');
  const seenEdge = new Set();
  relations.forEach((r, i) => {
    const at = `relations[${i}]`;
    if (!isObject(r)) return err(at, 'relation must be an object');
    if (!known(r.from)) err(`${at}.from`, `relation from unknown component "${r.from}"`);
    if (!known(r.to)) err(`${at}.to`, `relation to unknown component "${r.to}"`);
    if (r.from === r.to) err(`${at}`, `relation "${r.from}" -> "${r.to}" is a self-loop, which the renderer cannot draw`);
    if (!MECHANISMS.has(r.mechanism)) err(`${at}.mechanism`, `unknown mechanism ${JSON.stringify(r.mechanism)}`, `use one of: ${[...MECHANISMS].join(', ')}`);
    if (!isStr(r.summary, 1, 34)) err(`${at}.summary`, 'summary is required and must be at most 34 characters — it is the edge label');
    if (r.status !== undefined && !STATUSES.has(r.status)) err(`${at}.status`, 'status must be built, partial or planned');
    if (r.crosses !== undefined && !boundaryIds.has(r.crosses)) err(`${at}.crosses`, `relation crosses unknown boundary "${r.crosses}"`);
    if (!r.what_crosses) {
      warn(at, `relation "${r.from}" -> "${r.to}" does not say what crosses it`,
        'add what_crosses; it is the field a reader most often wants and prose most often omits');
    }
    const key = `${r.from}>${r.to}`;
    if (seenEdge.has(key)) warn(at, `duplicate relation "${key}" — the renderer will draw two edges between the same pair`);
    seenEdge.add(key);
    validateEvidence(r.evidence, `${at}.evidence`, err);
  });

  // A boundary crossing that nobody declared is the most common quiet error.
  if (Array.isArray(doc.boundaries)) {
    const owner = new Map();
    for (const b of doc.boundaries) for (const id of b.contains || []) owner.set(id, b.id);
    relations.forEach((r, i) => {
      const a = owner.get(r.from);
      const z = owner.get(r.to);
      if (a && z && a !== z && !r.crosses) {
        warn(`relations[${i}].crosses`,
          `"${r.from}" -> "${r.to}" leaves boundary "${a}" and enters "${z}" but declares no crossing`,
          `set crosses to "${z}" so the diagram can mark it`);
      }
    });
  }

  // --- facts --------------------------------------------------------------
  const factIds = new Set();
  if (doc.facts !== undefined) {
    if (!Array.isArray(doc.facts)) err('facts', 'facts must be an array');
    else doc.facts.forEach((f, i) => {
      const at = `facts[${i}]`;
      if (!ID.test(f?.id || '')) return err(`${at}.id`, 'invalid fact id');
      if (factIds.has(f.id)) err(`${at}.id`, `duplicate fact id "${f.id}"`);
      factIds.add(f.id);
      if (!FACT_KINDS.has(f.kind)) err(`${at}.kind`, `unknown fact kind ${JSON.stringify(f.kind)}`);
      if (!isStr(f.claim)) err(`${at}.claim`, 'claim is required');
      validateEvidence(f.evidence, `${at}.evidence`, err);
    });
  }

  // --- questions ----------------------------------------------------------
  const questions = Array.isArray(doc.questions) ? doc.questions : [];
  if (questions.length === 0) err('questions', 'at least one question is required — a diagram without a question is a picture of a codebase');
  const qIds = new Set();
  questions.forEach((q, i) => {
    const at = `questions[${i}]`;
    if (!ID.test(q?.id || '')) return err(`${at}.id`, 'invalid question id');
    if (qIds.has(q.id)) err(`${at}.id`, `duplicate question id "${q.id}"`);
    qIds.add(q.id);
    if (!isStr(q.title, 1, 60)) err(`${at}.title`, 'title is required and must be at most 60 characters');
    if (!isStr(q.ask)) err(`${at}.ask`, 'ask is required');
    else if (!q.ask.trim().endsWith('?')) warn(`${at}.ask`, `question "${q.id}" is not phrased as a question`);
    if (!Array.isArray(q.involves) || q.involves.length < 2) {
      err(`${at}.involves`, 'involves must name at least two components');
    } else {
      q.involves.forEach((id, j) => {
        if (!known(id)) err(`${at}.involves[${j}]`, `question "${q.id}" involves unknown component "${id}"`);
      });
      if (q.involves.length > 12) {
        warn(`${at}.involves`, `question "${q.id}" involves ${q.involves.length} components; a readable diagram holds about 12`,
          'split the question, or let the compiler collapse the periphery');
      }
    }
    for (const id of q.highlight || []) if (!known(id)) err(`${at}.highlight`, `unknown component "${id}"`);
    for (const id of q.facts || []) if (!factIds.has(id)) err(`${at}.facts`, `unknown fact "${id}"`);
    if (!q.answer) warn(`${at}.answer`, `question "${q.id}" has no answer, so its diagram will lead with nothing`);
  });

  // A component no question involves will never be drawn. That is allowed —
  // the analysis is broader than any one diagram — but it is worth saying.
  const involved = new Set(questions.flatMap((q) => q.involves || []));
  for (const c of components) {
    if (!involved.has(c.id)) {
      warn('questions', `component "${c.id}" is not involved in any question, so no diagram will show it`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function validateEvidence(list, at, err) {
  if (list === undefined) return;
  if (!Array.isArray(list)) return err(at, 'evidence must be an array');
  list.forEach((e, i) => {
    if (!isObject(e)) return err(`${at}[${i}]`, 'evidence entry must be an object');
    if (!isStr(e.path, 1, 240)) err(`${at}[${i}].path`, 'evidence.path is required');
    if (e.path && (e.path.startsWith('/') || e.path.includes('\\') || e.path.includes('..'))) {
      err(`${at}[${i}].path`, `evidence path "${e.path}" must be repository-relative with forward slashes and no ".."`);
    }
    if (e.line !== undefined && (!Number.isInteger(e.line) || e.line < 1)) err(`${at}[${i}].line`, 'line must be a positive integer');
    if (e.end_line !== undefined && e.line !== undefined && e.end_line < e.line) {
      err(`${at}[${i}].end_line`, 'end_line must not precede line');
    }
  });
}

/** Read and validate in one step. Throws with a readable report when invalid. */
export function loadAnalysis(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`could not read analysis "${path}": ${cause.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`analysis "${path}" is not valid JSON: ${cause.message}`);
  }
  const result = validateAnalysis(doc);
  if (!result.ok) {
    const lines = result.errors.map((e) => `  - ${e.where}: ${e.message}${e.fix ? `\n      fix: ${e.fix}` : ''}`);
    throw new Error(`analysis "${path}" is not valid:\n${lines.join('\n')}`);
  }
  return { analysis: doc, warnings: result.warnings };
}

/** Index helpers the compiler and the prose renderer both want. */
export function index(analysis) {
  const components = new Map(analysis.components.map((c) => [c.id, c]));
  const facts = new Map((analysis.facts || []).map((f) => [f.id, f]));
  const layers = new Map((analysis.layers || []).map((l) => [l.id, l]));
  const boundaries = new Map((analysis.boundaries || []).map((b) => [b.id, b]));
  const boundaryOf = new Map();
  for (const b of analysis.boundaries || []) for (const id of b.contains) boundaryOf.set(id, b.id);
  return { components, facts, layers, boundaries, boundaryOf };
}
