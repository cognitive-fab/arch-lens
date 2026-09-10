// The same analysis, as prose.
//
// This exists so the diagram and the document cannot disagree. Every fact in the
// rendered markdown came from the same file the diagrams compiled from, so
// "the doc says four engines, the picture shows two" becomes impossible rather
// than merely embarrassing.
//
// The order is deliberate: what the system is for, then the questions it answers
// with their diagrams, then the component and relation tables, then the facts.
// A reader who stops after the questions has the architecture; the tables are
// reference.

import { index } from './model.mjs';
import { glossaryFor } from './brief.mjs';

const STATUS_MARK = { built: '', partial: ' *(partial)*', planned: ' *(planned)*' };

export function renderMarkdown(analysis, { diagrams = new Map() } = {}) {
  const idx = index(analysis);
  const out = [];
  const w = (line = '') => out.push(line);

  w(`# ${analysis.system.name} — architecture`);
  w();
  w(analysis.system.purpose);
  w();

  if (analysis.system.repository) {
    const { url, revision } = analysis.system.repository;
    w(`Analysed at [\`${revision.slice(0, 7)}\`](${url.replace(/\/$/, '')}/tree/${revision}).`);
    w();
  }

  if (analysis.system.sources?.length) {
    w('**Read from.** ' + analysis.system.sources.map((s) => `${s.ref} (${s.kind})`).join('; ') + '.');
    w();
  }

  w('> Generated from the analysis by archlens. Edit the analysis, never this file.');
  w();

  // --- questions ----------------------------------------------------------
  w('## What this architecture answers');
  w();
  for (const q of analysis.questions) {
    w(`### ${q.title}`);
    w();
    w(`**${q.ask}**`);
    w();
    if (q.context) {
      w(q.context);
      w();
    }
    if (q.answer) {
      w(q.answer);
      w();
    }
    const diagram = diagrams.get(q.id);
    if (diagram) {
      w(`[Open the diagram](${diagram}) — ${q.involves.length} components.`);
      w();
    }
    const parts = q.involves.map((id) => idx.components.get(id)).filter(Boolean);
    w('| Component | Responsibility |');
    w('|---|---|');
    for (const c of parts) {
      const mark = STATUS_MARK[c.status ?? 'built'] ?? '';
      w(`| **${c.name}**${mark} | ${c.responsibility} |`);
    }
    w();
    if (q.omits) {
      w(`**Deliberately not shown.** ${q.omits}`);
      w();
    }
    if (q.narrative) {
      w('#### The long read');
      w();
      w(q.narrative);
      w();
    }
    const terms = glossaryFor(q, analysis, idx);
    if (terms.length) {
      w('#### Terms used here');
      w();
      for (const t of terms) w(`- **${t.term}** — ${t.definition}`);
      w();
    }
  }

  // --- boundaries ---------------------------------------------------------
  if (analysis.boundaries?.length) {
    w('## Boundaries');
    w();
    w('A boundary is a claim about everything inside it.');
    w();
    for (const b of analysis.boundaries) {
      w(`### ${b.label}`);
      w();
      w(`*${b.kind} boundary.* ${b.claim}`);
      w();
      w('Contains: ' + b.contains.map((id) => idx.components.get(id)?.name ?? id).join(', ') + '.');
      w();
      const crossings = analysis.relations.filter((r) => r.crosses === b.id);
      if (crossings.length) {
        w('Crossed by:');
        w();
        for (const r of crossings) {
          const from = idx.components.get(r.from)?.name ?? r.from;
          const to = idx.components.get(r.to)?.name ?? r.to;
          w(`- **${from} → ${to}** over ${r.mechanism}. ${r.what_crosses ?? r.summary}`);
        }
        w();
      }
    }
  }

  // --- components ---------------------------------------------------------
  w('## Components');
  w();
  const byLayer = groupByLayer(analysis, idx);
  for (const [layerLabel, components] of byLayer) {
    if (layerLabel) {
      w(`### ${layerLabel}`);
      w();
    }
    for (const c of components) {
      const mark = STATUS_MARK[c.status ?? 'built'] ?? '';
      w(`**${c.name}**${mark} — ${c.responsibility}`);
      w();
      const bullets = [];
      if (c.evidence?.length) {
        bullets.push('Source: ' + c.evidence.map((e) => `\`${e.path}${e.line ? `:${e.line}` : ''}\``).join(', '));
      }
      if (c.doc_refs?.length) {
        bullets.push('Documented in: ' + c.doc_refs.map((d) => `\`${d.path}\`${d.section ? ` ${d.section}` : ''}`).join(', '));
      }
      for (const note of c.notes ?? []) bullets.push(note);
      for (const b of bullets) w(`- ${b}`);
      if (bullets.length) w();
    }
  }

  // --- relations ----------------------------------------------------------
  w('## What moves between them');
  w();
  w('| From | To | Mechanism | What crosses |');
  w('|---|---|---|---|');
  for (const r of analysis.relations) {
    const from = idx.components.get(r.from)?.name ?? r.from;
    const to = idx.components.get(r.to)?.name ?? r.to;
    const crossing = r.crosses ? ` *(crosses ${idx.boundaries.get(r.crosses)?.label ?? r.crosses})*` : '';
    w(`| ${from} | ${to} | ${r.mechanism} | ${r.what_crosses ?? r.summary}${crossing} |`);
  }
  w();

  // --- facts --------------------------------------------------------------
  if (analysis.facts?.length) {
    w('## Doctrines, guarantees and trade-offs');
    w();
    for (const kind of ['doctrine', 'guarantee', 'constraint', 'tradeoff', 'risk']) {
      const facts = analysis.facts.filter((f) => f.kind === kind);
      if (!facts.length) continue;
      w(`### ${kind === 'tradeoff' ? 'Trade-offs' : `${kind[0].toUpperCase()}${kind.slice(1)}s`}`);
      w();
      for (const f of facts) {
        w(`- **${f.claim}**${f.because ? ` ${f.because}` : ''}`);
      }
      w();
    }
  }

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function groupByLayer(analysis, idx) {
  if (!analysis.layers?.length) return [[null, analysis.components]];
  const ordered = [...analysis.layers].sort((a, b) => a.order - b.order);
  const groups = [];
  for (const layer of ordered) {
    const members = analysis.components.filter((c) => c.layer === layer.id);
    if (members.length) groups.push([layer.label, members]);
  }
  const orphans = analysis.components.filter((c) => !c.layer || !idx.layers.has(c.layer));
  if (orphans.length) groups.push(['Unplaced', orphans]);
  return groups;
}
