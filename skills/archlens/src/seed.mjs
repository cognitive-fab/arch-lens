// A first draft of the analysis, from something the repository already states.
//
// A compose file names the services and which one waits for which. A
// workspace manifest names the packages and which one imports which. Neither
// says what anything is *for*, and that sentence is the whole point of the
// analysis — so a seed writes the skeleton with evidence attached and leaves a
// TODO where the responsibility goes, and the validator warns on every TODO
// until a person or the model has replaced it. A seeded analysis renders, which
// is useful for a first look, and it says on every node that it is a draft.
//
// What the seed will not do is guess. A mechanism it cannot know is left to the
// default the target's kind implies and marked in a note; `what_crosses` is left
// empty so the validator asks for it; a boundary is drawn only where the input
// draws one (a compose network), with a claim that says TODO.

import { parseYaml } from './yaml.mjs';

const TODO = (what) => `TODO: ${what}`;

/** Image name -> what kind of thing it is, when the name says. */
const IMAGE_KINDS = [
  [/^(?:.*\/)?(postgres|postgresql|mysql|mariadb|mongo|mongodb|cockroach|timescale|clickhouse|cassandra|scylla|neo4j|couchdb|elasticsearch|opensearch|meilisearch|typesense)\b/, 'store'],
  [/^(?:.*\/)?(redis|valkey|memcached|keydb|dragonfly)\b/, 'cache'],
  [/^(?:.*\/)?(rabbitmq|kafka|redpanda|nats|mosquitto|emqx|activemq|pulsar)\b/, 'queue'],
  [/^(?:.*\/)?(nginx|traefik|caddy|envoy|haproxy|kong|apisix)\b/, 'gateway'],
  [/^(?:.*\/)?(minio|localstack|seaweedfs|garage)\b/, 'file-store'],
  [/^(?:.*\/)?(prometheus|grafana|jaeger|otel|opentelemetry|loki|tempo)\b/, 'third-party'],
];

const MECHANISM_TO = {
  store: 'database',
  cache: 'database',
  'file-store': 'https',
  queue: 'queue',
  gateway: 'http',
  'third-party': 'http',
};

const slug = (name) => {
  const s = String(name).toLowerCase().replace(/^@/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(s) ? s : `x-${s}`;
};

/**
 * Seed from a compose file.
 *
 * @param {string} text  the file's contents
 * @param {string} path  repository-relative path, for evidence
 * @param {{name?: string}} [options]
 */
export function seedCompose(text, path, options = {}) {
  const doc = parseYaml(text);
  const services = doc?.services;
  if (!services || typeof services !== 'object') throw new Error(`${path}: no "services" mapping`);

  const components = [];
  const relations = [];
  const notes = [];
  const idOf = new Map();
  for (const name of Object.keys(services)) idOf.set(name, slug(name));

  for (const [name, svc] of Object.entries(services)) {
    const s = svc ?? {};
    const image = typeof s.image === 'string' ? s.image : null;
    let kind = 'service';
    for (const [re, k] of IMAGE_KINDS) if (image && re.test(image)) { kind = k; break; }
    const component = {
      id: idOf.get(name),
      name: name.slice(0, 40),
      kind,
      responsibility: TODO(`what is "${name}" answerable for?`),
      detail: (image ? image.split('/').pop().split('@')[0] : s.build ? 'built here' : '').slice(0, 28) || undefined,
      status: 'built',
      evidence: [{ path, label: `services.${name}` }],
    };
    if (!component.detail) delete component.detail;
    const cnotes = [];
    if (image) cnotes.push(`Runs image ${image}.`);
    if (s.build) cnotes.push(`Built from ${typeof s.build === 'string' ? s.build : s.build.context ?? '.'}.`);
    if (cnotes.length) component.notes = cnotes;
    components.push(component);

    const deps = s.depends_on;
    const targets = Array.isArray(deps) ? deps : deps && typeof deps === 'object' ? Object.keys(deps) : [];
    for (const target of [...targets, ...(Array.isArray(s.links) ? s.links.map((l) => String(l).split(':')[0]) : [])]) {
      if (!idOf.has(target) || target === name) continue;
      relations.push({ from: name, to: target });
    }
  }

  const seen = new Set();
  const relationSpecs = [];
  for (const { from, to } of relations) {
    const key = `${from}>${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const target = components.find((c) => c.id === idOf.get(to));
    const mechanism = MECHANISM_TO[target.kind] ?? 'http';
    relationSpecs.push({
      from: idOf.get(from),
      to: idOf.get(to),
      mechanism,
      summary: 'depends on',
      status: 'built',
      evidence: [{ path, label: `services.${from}.depends_on` }],
    });
    notes.push(`${from} -> ${to}: mechanism guessed as "${mechanism}" from the target's kind; depends_on says only that it waits`);
  }

  // A compose network is the one boundary the file actually draws.
  const boundaries = [];
  const networks = doc.networks && typeof doc.networks === 'object' ? Object.keys(doc.networks) : [];
  for (const net of networks) {
    const members = Object.entries(services)
      .filter(([, s]) => {
        const n = s?.networks;
        return Array.isArray(n) ? n.includes(net) : n && typeof n === 'object' && net in n;
      })
      .map(([name]) => idOf.get(name));
    if (members.length >= 2) {
      boundaries.push({
        id: slug(`net-${net}`),
        kind: 'network',
        label: `Network ${net}`,
        claim: TODO(`what is true of everything on "${net}" and nothing off it?`),
        contains: members,
        evidence: [{ path, label: `networks.${net}` }],
      });
    }
  }

  return finish({
    name: options.name ?? 'Compose stack',
    purpose: TODO('one sentence on what this stack is for'),
    source: { kind: 'code', ref: path, note: 'seeded by archlens seed from the compose file; every TODO is a sentence nobody has written yet' },
    components,
    relations: relationSpecs,
    boundaries,
    notes,
  });
}

/**
 * Seed from a JavaScript workspace: the root package.json's `workspaces`, and
 * each member's own package.json.
 *
 * @param {object} root  the root package.json, parsed
 * @param {Array<{dir: string, pkg: object}>} members  each workspace package,
 *   with its repository-relative directory and parsed package.json
 * @param {{name?: string}} [options]
 */
export function seedWorkspaces(root, members, options = {}) {
  const byName = new Map(members.filter((m) => m.pkg?.name).map((m) => [m.pkg.name, m]));
  const components = members.filter((m) => m.pkg?.name).map((m) => {
    const p = m.pkg;
    const kind = p.bin ? 'cli' : /(^|\/)(api|server|service)s?$/.test(m.dir) ? 'service' : 'library';
    const c = {
      id: slug(p.name),
      name: p.name.slice(0, 40),
      kind,
      responsibility: TODO(`what is ${p.name} answerable for?`),
      status: 'built',
      evidence: [{ path: `${m.dir.replace(/\/+$/, '')}/package.json` }],
    };
    if (p.description) c.notes = [String(p.description)];
    return c;
  });

  const relations = [];
  const notes = [];
  for (const m of members) {
    if (!m.pkg?.name) continue;
    const deps = { ...(m.pkg.dependencies ?? {}), ...(m.pkg.peerDependencies ?? {}) };
    for (const dep of Object.keys(deps)) {
      if (!byName.has(dep) || dep === m.pkg.name) continue;
      relations.push({
        from: slug(m.pkg.name),
        to: slug(dep),
        mechanism: 'in-process call',
        summary: 'imports',
        status: 'built',
        evidence: [{ path: `${m.dir.replace(/\/+$/, '')}/package.json`, label: `dependencies.${dep}` }],
      });
    }
    const devOnly = Object.keys(m.pkg.devDependencies ?? {}).filter((d) => byName.has(d) && !(d in deps));
    if (devOnly.length) notes.push(`${m.pkg.name} depends on ${devOnly.join(', ')} only at development time; not drawn`);
  }

  return finish({
    name: options.name ?? root.name ?? 'Workspace',
    purpose: TODO('one sentence on what this workspace is for'),
    source: { kind: 'code', ref: 'package.json', note: 'seeded by archlens seed from the workspace manifests; every TODO is a sentence nobody has written yet' },
    components,
    relations,
    boundaries: [],
    notes,
  });
}

/** Assemble a draft analysis and its first question. */
function finish({ name, purpose, source, components, relations, boundaries, notes }) {
  if (components.length === 0) throw new Error('nothing to seed from: no components found');
  const involves = components.slice(0, 12).map((c) => c.id);
  if (components.length > 12) {
    notes.push(`${components.length} components; the first question involves the first 12 — split it into narrower questions`);
  }
  const questions = [{
    id: 'parts',
    title: 'What the parts are',
    ask: 'What are the parts, and which depends on which?',
    answer: TODO('the short answer, once the responsibilities are written'),
    involves,
  }];
  if (components.length < 2) {
    // A question needs two components; a one-service stack gets none, and the
    // validator will say so.
    questions.length = 0;
  }
  const analysis = {
    schema_version: 1,
    system: { name, purpose, sources: [source] },
    components,
    relations,
    ...(boundaries.length ? { boundaries } : {}),
    questions,
  };
  return { analysis, notes };
}
