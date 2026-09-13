// A two-page PDF with real text, small enough to write by hand, so the
// document check can be tested against pdftotext without shipping a binary.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGES = [
  ['1 Introduction', 'We study replication.', '2 Method', 'The encoder reads sentence pairs and emits alignments.'],
  ['3 Experiments', 'We train on WMT14 with 4.5M pairs.', '3.2 Ablation', 'Removing the aligner costs 1.2 BLEU.'],
];

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function writePdf(dir, name = 'paper.pdf') {
  const objs = [];
  const add = (o) => objs.push(o);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const contents = PAGES.map((lines) => {
    let y = 760;
    const ops = ['BT', '/F1 12 Tf'];
    for (const l of lines) {
      ops.push(`1 0 0 1 72 ${y} Tm (${esc(l)}) Tj`);
      y -= 20;
    }
    ops.push('ET');
    const stream = ops.join('\n');
    return add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  const pagesIndex = objs.length + PAGES.length + 1;
  const pageIds = contents.map((c) => add(`<< /Type /Page /Parent ${pagesIndex} 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  add(`<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesIndex} 0 R >>`);

  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(join(dir, name), Buffer.from(out, 'latin1'));
}
