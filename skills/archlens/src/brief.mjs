// The prose the diagram cannot hold.
//
// A diagram has room for two words per node and three short cards beside it.
// That is enough to answer a question for someone who already knows the system
// and not nearly enough for someone meeting it for the first time. The cards
// stay as they are — they are the right size for what they do. This adds what
// was missing underneath: what the question is even about, the long read, and
// the words a newcomer will not know.
//
// It is injected after delivery rather than compiled into the specification,
// because archify's node labels are budgeted for a diagram and this is not
// diagram content. The injection point is immediately before </body>, which
// leaves the SVG, the toolbar and every script untouched. Colours come from
// archify's own custom properties so the section follows the theme toggle
// without knowing anything about it.

import { readFileSync, writeFileSync } from 'node:fs';
import { docLink, docCite } from './docs.mjs';

const MARKER = 'data-archlens-brief';

const esc = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Paragraphs, split on blank lines, so a narrative can have shape. */
const paras = (text) => String(text)
  .split(/\n\s*\n/)
  .map((p) => p.trim())
  .filter(Boolean);

/**
 * Terms this question actually uses.
 *
 * Filtering matters more than it looks: a glossary of forty terms under a
 * six-node diagram is a wall, and the reader stops trusting that any of it is
 * relevant. A term earns its place by appearing in the question's own prose or
 * in the name of a component the diagram draws.
 */
export function glossaryFor(question, analysis, idx) {
  const entries = analysis.glossary ?? [];
  if (!entries.length) return [];

  const haystack = [
    question.ask,
    question.context,
    question.answer,
    question.narrative,
    question.omits,
    ...(question.steps ?? []).map((s) => `${s.says ?? ''} ${s.note ?? ''} ${s.phase ?? ''}`),
    ...(question.involves ?? []).map((id) => {
      const c = idx?.components?.get(id);
      return c ? `${c.name} ${c.responsibility ?? ''} ${c.detail ?? ''}` : '';
    }),
    // The edges are on the diagram too, and their labels name things a reader
    // will ask about just as often as the boxes do.
    ...(analysis.relations ?? [])
      .filter((r) => (question.involves ?? []).includes(r.from) && (question.involves ?? []).includes(r.to))
      .map((r) => `${r.summary ?? ''} ${r.what_crosses ?? ''}`),
  ].filter(Boolean).join(' ').toLowerCase();

  return entries.filter((entry) => {
    const forms = [entry.term, ...(entry.also ?? [])];
    return forms.some((form) => haystack.includes(String(form).toLowerCase()));
  });
}

/**
 * What a document subject cites, per component the question draws. The diagram
 * has no source links for a paper — archify's are repository evidence — so this
 * is where the reader gets the page.
 */
export function citedFor(question, analysis, idx) {
  if (analysis.system.domain !== 'document') return [];
  const out = [];
  for (const id of question.involves ?? []) {
    const c = idx?.components?.get(id);
    for (const d of c?.doc_refs ?? []) out.push({ component: c, ref: d });
  }
  return out;
}

/** The section, or '' when the analysis gave it nothing to say. */
export function briefHtml(question, analysis, idx) {
  const glossary = glossaryFor(question, analysis, idx);
  const cited = citedFor(question, analysis, idx);
  const hasProse = Boolean(question.context || question.narrative);
  if (!hasProse && !glossary.length && !cited.length) return '';

  const out = [];
  out.push(`<section ${MARKER} aria-labelledby="archlens-brief-title" hidden>`);
  out.push('  <div class="archlens-brief-inner">');

  // The prose column, sitting under the two left columns of the diagram.
  out.push('    <div class="archlens-prose">');
  out.push(`      <h2 id="archlens-brief-title">${esc(question.title)}</h2>`);
  out.push(`      <p class="archlens-ask">${esc(question.ask)}</p>`);

  if (question.context) {
    out.push('      <div class="archlens-context">');
    for (const p of paras(question.context)) out.push(`        <p>${esc(p)}</p>`);
    out.push('      </div>');
  }

  if (question.narrative) {
    out.push('      <h3>The long read</h3>');
    out.push('      <div class="archlens-narrative">');
    for (const p of paras(question.narrative)) out.push(`        <p>${esc(p)}</p>`);
    out.push('      </div>');
  }

  if (cited.length) {
    out.push('      <h3>Cited</h3>');
    out.push('      <ul class="archlens-cited">');
    for (const { component, ref } of cited) {
      const cite = docCite(ref);
      const quote = ref.quote ? ` <q>${esc(ref.quote)}</q>` : '';
      out.push(`        <li><strong>${esc(component.name)}</strong> — <a href="${esc(docLink(ref))}">${esc(ref.path)}${cite ? ` ${esc(cite)}` : ''}</a>${quote}</li>`);
    }
    out.push('      </ul>');
  }
  out.push('    </div>');

  // The glossary is reference, not argument: it belongs beside the prose in the
  // rightmost column, where a reader can glance at it without losing their line.
  if (glossary.length) {
    out.push('    <aside class="archlens-terms">');
    out.push('      <h3>Terms used here</h3>');
    out.push('      <dl class="archlens-glossary">');
    for (const entry of glossary) {
      out.push(`        <dt>${esc(entry.term)}</dt>`);
      out.push(`        <dd>${esc(entry.definition)}</dd>`);
    }
    out.push('      </dl>');
    out.push('    </aside>');
  }

  out.push('  </div>');
  out.push('</section>');
  out.push(REVEAL);
  return out.join('\n');
}

// Revealed only once archify's reader has settled, and only after its width is
// pinned.
//
// archify's adaptive reader exists to fit a wide diagram into one screen: it
// measures `max(documentElement.scrollHeight, body.scrollHeight) - innerHeight`
// and, whenever the page overflows the viewport, narrows `.container` through
// --archify-reader-width to buy back vertical room. Narrowing changes the height
// of the header and cards it observes, which schedules another measurement.
//
// On a diagram-only page that converges. Put prose below the diagram and it
// cannot: the page now always overflows, so the reader shrinks, re-measures,
// still overflows, restores, and oscillates — visibly flashing between two zoom
// factors, with the main thread pegged. Hiding the section until after load was
// not enough, because the reader keeps measuring for the life of the page.
//
// So the width is frozen at whatever the reader chose while it still had a
// diagram-only page to reason about, and pinned with !important. The reader may
// go on setting the variable; nothing reads it any more, no observed element
// resizes, and the loop has nothing to feed on. The cost is honest and small:
// a page that carries a narrative gives up automatic re-fitting, which was
// never going to fit a page with a narrative on it anyway.
const REVEAL = `<script ${MARKER}>
  (function () {
    var pinAndReveal = function () {
      var html = document.documentElement;
      var chosen = (html.style.getPropertyValue('--archify-reader-width') || '').trim();
      var pin = document.createElement('style');
      pin.setAttribute('${MARKER}', '');
      pin.textContent = '.container{max-width:' + (chosen || '1440px') + ' !important;}';
      document.head.appendChild(pin);
      var el = document.querySelector('section[${MARKER}]');
      if (el) el.hidden = false;
    };
    if (document.readyState === 'complete') setTimeout(pinAndReveal, 1200);
    else window.addEventListener('load', function () { setTimeout(pinAndReveal, 1200); });
  })();
</script>`;

const STYLE = `<style ${MARKER}>
  section[${MARKER}] {
    background: var(--bg, #0d1117);
    color: var(--text, #e6edf3);
    border-top: 1px solid var(--panel-border, rgba(255,255,255,0.12));
    padding: 32px 24px 56px;
    font: 400 15px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  /* Two thirds prose, one third reference — the same split the diagram above
     uses, so the narrative reads under the picture it describes rather than
     down the middle of it. */
  section[${MARKER}] .archlens-brief-inner {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    gap: 0 48px;
    align-items: start;
    max-width: 1180px;
    margin: 0 auto;
  }
  section[${MARKER}] .archlens-prose { grid-column: 1; min-width: 0; }
  section[${MARKER}] .archlens-terms {
    grid-column: 2;
    min-width: 0;
    border-left: 1px solid var(--panel-border, rgba(255,255,255,0.12));
    padding-left: 24px;
  }
  section[${MARKER}] .archlens-terms h3 { margin-top: 0; }
  @media (max-width: 900px) {
    section[${MARKER}] .archlens-brief-inner { grid-template-columns: minmax(0, 1fr); gap: 0; }
    section[${MARKER}] .archlens-prose,
    section[${MARKER}] .archlens-terms { grid-column: 1; }
    section[${MARKER}] .archlens-terms {
      border-left: 0; padding-left: 0; margin-top: 32px;
    }
    section[${MARKER}] .archlens-terms h3 { margin-top: 32px; }
  }
  section[${MARKER}] h2 { font-size: 1.35rem; line-height: 1.3; margin: 0 0 4px; }
  section[${MARKER}] h3 {
    font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--text-muted, #9aa4b2); margin: 32px 0 8px;
  }
  section[${MARKER}] .archlens-ask {
    color: var(--text-muted, #9aa4b2); font-size: 1.02rem; margin: 0 0 20px;
  }
  section[${MARKER}] p { margin: 0 0 14px; }
  section[${MARKER}] .archlens-context {
    border-left: 3px solid var(--guide-accent, #6aa6ff);
    padding-left: 16px;
  }
  section[${MARKER}] .archlens-glossary { margin: 0; }
  section[${MARKER}] .archlens-cited { margin: 0; padding-left: 1.2em; }
  section[${MARKER}] .archlens-cited li { margin: 0 0 6px; }
  section[${MARKER}] .archlens-cited q { opacity: 0.8; }
  section[${MARKER}] .archlens-glossary dt {
    font-weight: 600; margin-top: 14px;
  }
  section[${MARKER}] .archlens-glossary dd {
    margin: 2px 0 0; color: var(--text-muted, #9aa4b2);
  }
  @media print { section[${MARKER}] { break-before: page; } }
</style>`;

/**
 * Put the brief into a delivered page.
 *
 * Idempotent: a previous brief is removed first, so re-rendering after the
 * browser check re-delivered the file cannot stack two copies. Returns false
 * when there was nothing to add, so the caller can stay quiet about it.
 */
export function injectBrief(htmlPath, question, analysis, idx) {
  const body = briefHtml(question, analysis, idx);
  if (!body) return false;

  let html = readFileSync(htmlPath, 'utf8');
  html = html.replace(new RegExp(`\\n?<style ${MARKER}>[\\s\\S]*?</style>`, 'g'), '');
  html = html.replace(new RegExp(`\\n?<section ${MARKER}[\\s\\S]*?</section>`, 'g'), '');
  html = html.replace(new RegExp(`\\n?<script ${MARKER}>[\\s\\S]*?</script>`, 'g'), '');

  const close = html.lastIndexOf('</body>');
  if (close === -1) return false;

  writeFileSync(
    htmlPath,
    `${html.slice(0, close)}${STYLE}\n${body}\n${html.slice(close)}`,
    'utf8',
  );
  return true;
}
