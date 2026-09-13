// Evidence for a document, checked the way code evidence is.
//
// A paper has no revision to pin and no line to resolve, but a citation into
// it can still be true or false: the file is there or it is not, the section
// exists or it does not, the quote is on the page it claims or somewhere else.
// This resolves every `doc_refs` entry against the documents themselves and
// reports what it could not confirm rather than treating an unverifiable
// citation as a verified one.
//
// Plain text and markdown are read directly. A PDF is read through `pdftotext`
// when it is installed, which is a probe, not a dependency: without it, a PDF
// citation is reported as unverified by name, and the report says what to
// install. Pages come from the form feeds pdftotext writes between them, so a
// quote found on a page can be checked against the page the citation claims.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEXT = /\.(?:md|markdown|txt|rst|tex|adoc|org)$/i;
const PDF = /\.pdf$/i;

/** Every document citation in the analysis. */
export function docCitations(analysis) {
  const out = [];
  const add = (owner, kind) => {
    for (const d of owner.doc_refs ?? []) out.push({ owner, kind, ref: d, what: kind === 'relation' ? `${owner.from} -> ${owner.to}` : owner.id });
  };
  for (const c of analysis.components) add(c, 'component');
  for (const r of analysis.relations) add(r, 'relation');
  for (const b of analysis.boundaries ?? []) add(b, 'boundary');
  for (const f of analysis.facts ?? []) add(f, 'fact');
  return out;
}

let pdftotextAvailable = null;
export function hasPdftotext() {
  if (pdftotextAvailable === null) {
    try {
      execFileSync('pdftotext', ['-v'], { stdio: ['ignore', 'pipe', 'pipe'] });
      pdftotextAvailable = true;
    } catch (error) {
      // pdftotext -v prints its version to stderr and exits 0 on some builds
      // and 99 on others; only a missing binary is a real "no".
      pdftotextAvailable = error.code !== 'ENOENT';
    }
  }
  return pdftotextAvailable;
}

/**
 * The pages of a document, as text. One entry for a text file; one per page
 * for a PDF. Null when the document cannot be read here.
 */
export function pagesOf(absPath) {
  if (TEXT.test(absPath)) return [readFileSync(absPath, 'utf8')];
  if (PDF.test(absPath)) {
    if (!hasPdftotext()) return null;
    const text = execFileSync('pdftotext', ['-layout', absPath, '-'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const pages = text.split('\f');
    if (pages.length > 1 && !pages[pages.length - 1].trim()) pages.pop();
    return pages;
  }
  return null;
}

const fold = (s) => String(s).toLowerCase().replace(/[‘’“”]/g, "'").replace(/[^a-z0-9]+/g, ' ').trim();

/** Which page (1-based) a quote appears on, or 0. Whitespace and punctuation are folded. */
export function findQuote(pages, quote) {
  const needle = fold(quote);
  if (!needle) return 0;
  for (let i = 0; i < pages.length; i += 1) {
    if (fold(pages[i]).includes(needle)) return i + 1;
  }
  // A quote that straddles a page break is still a real quote.
  for (let i = 0; i + 1 < pages.length; i += 1) {
    if (fold(`${pages[i]} ${pages[i + 1]}`).includes(needle)) return i + 1;
  }
  return 0;
}

/**
 * Which page a section heading appears on, or 0. "§3.2", "3.2", "3.2 Method"
 * and "Method" are all accepted: a number is looked for at the start of a line
 * followed by a title; words are looked for as a heading line or, failing
 * that, anywhere.
 */
export function findSection(pages, section) {
  const clean = String(section).replace(/^§\s*/, '').trim();
  const m = clean.match(/^([A-Z]?\d+(?:\.\d+)*)\.?\s*(.*)$/);
  const number = m?.[1] ?? null;
  const words = fold(m ? m[2] : clean);
  const lineRe = number ? new RegExp(`^\\s*(?:#+\\s*)?${number.replace(/\./g, '\\.')}\\.?\\s+\\S`, 'm') : null;
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    if (lineRe && lineRe.test(page)) return i + 1;
    if (!number && words) {
      const headingRe = new RegExp(`^\\s*(?:#+\\s*|\\d+(?:\\.\\d+)*\\.?\\s+)?${words.replace(/ /g, '\\s+')}\\s*$`, 'mi');
      if (headingRe.test(page)) return i + 1;
    }
  }
  if (!number && words) {
    for (let i = 0; i < pages.length; i += 1) if (fold(pages[i]).includes(words)) return i + 1;
  }
  return 0;
}

/**
 * Check every document citation against the documents under `root`.
 *
 * @returns {{gone: object[], unverified: object[], missing: object[], mispaged: object[], fine: number, total: number, ok: boolean}}
 */
export function checkDocRefs(analysis, root) {
  const gone = [];
  const unverified = [];
  const missing = [];
  const mispaged = [];
  let fine = 0;
  const cache = new Map();
  const pagesFor = (path) => {
    if (!cache.has(path)) cache.set(path, pagesOf(join(root, path)));
    return cache.get(path);
  };

  const cites = docCitations(analysis);
  for (const cite of cites) {
    const { ref } = cite;
    const entry = { ...cite, path: ref.path };
    if (!existsSync(join(root, ref.path))) {
      gone.push({ ...entry, reason: 'not found' });
      continue;
    }
    const pages = pagesFor(ref.path);
    if (pages === null) {
      unverified.push({ ...entry, reason: PDF.test(ref.path) ? 'pdftotext is not installed' : 'not a text or PDF document' });
      continue;
    }
    let problem = false;
    if (ref.page && PDF.test(ref.path) && ref.page > pages.length) {
      gone.push({ ...entry, reason: `cites page ${ref.page} of ${pages.length}` });
      continue;
    }
    if (ref.quote) {
      const at = findQuote(pages, ref.quote);
      if (!at) {
        missing.push({ ...entry, reason: `quote not found: "${ref.quote.slice(0, 60)}${ref.quote.length > 60 ? '…' : ''}"` });
        problem = true;
      } else if (ref.page && pages.length > 1 && at !== ref.page) {
        mispaged.push({ ...entry, claimed: ref.page, found: at });
        problem = true;
      }
    }
    if (ref.section && !problem) {
      const at = findSection(pages, ref.section);
      if (!at) {
        missing.push({ ...entry, reason: `section "${ref.section}" not found` });
        problem = true;
      } else if (ref.page && !ref.quote && pages.length > 1 && at !== ref.page) {
        mispaged.push({ ...entry, claimed: ref.page, found: at });
        problem = true;
      }
    }
    if (!problem) fine += 1;
  }

  return {
    gone, unverified, missing, mispaged, fine,
    total: cites.length,
    ok: gone.length === 0 && missing.length === 0 && mispaged.length === 0,
  };
}

export function renderDocCheck(result) {
  const out = [];
  const w = (line = '') => out.push(line);
  w(`cited    ${result.total} document reference(s): ${result.fine} confirmed, ${result.unverified.length} unverified, ${result.missing.length + result.mispaged.length} wrong, ${result.gone.length} gone`);
  w();
  if (result.gone.length) {
    w('Gone — the analysis points at nothing:');
    for (const g of result.gone) w(`  ${g.kind} ${g.what}  ${g.path}  (${g.reason})`);
    w();
  }
  if (result.missing.length) {
    w('Not in the document where the analysis says:');
    for (const m of result.missing) w(`  ${m.kind} ${m.what}  ${m.path}  (${m.reason})`);
    w();
  }
  if (result.mispaged.length) {
    w('On a different page than cited:');
    for (const m of result.mispaged) w(`  ${m.kind} ${m.what}  ${m.path}  cites p. ${m.claimed}, found on p. ${m.found}`);
    w();
  }
  if (result.unverified.length) {
    w('Could not be checked here:');
    for (const u of result.unverified) w(`  ${u.kind} ${u.what}  ${u.path}  (${u.reason})`);
    if (result.unverified.some((u) => /pdftotext/.test(u.reason))) w('  Install poppler (pdftotext) to verify PDF citations.');
    w();
  }
  if (result.ok) w(result.unverified.length ? 'Every citation that could be checked holds.' : 'Every citation holds.');
  else w('Fix the citations above before the analysis is trusted again.');
  return `${out.join('\n')}\n`;
}

/** A link into the document, with a page anchor when there is one. */
export function docLink(ref) {
  const anchor = ref.page ? `#page=${ref.page}` : '';
  return `${ref.path}${anchor}`;
}

/** "§3.2, p. 12" — whatever the citation carries, in reading order. */
export function docCite(ref) {
  const parts = [];
  if (ref.section) parts.push(ref.section);
  if (ref.page) parts.push(`p. ${ref.page}`);
  return parts.join(', ');
}
