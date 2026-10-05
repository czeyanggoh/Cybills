// An email, as a PDF.
//
// Some paperwork IS the email: an order confirmation typed into the body, a
// supplier's "please pay to this PayNow" with the amount in a forwarded thread
// and nothing attached. There is no file to fetch from behind its links — the
// links are a logo and a mail client's footer — so the document stands in the
// inbox with nothing behind it, and a bill published from it reaches Xero with
// no paper at all. This writes the message out as the paper: who sent it, to
// whom, when, about what, and what it said.
//
// TEXT, deliberately. Rendering a mail's HTML as its sender saw it needs a
// browser, which this server does not carry, and what an auditor wants off the
// page is the words. A leaf: it knows nothing of mail stores or bills.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export type EmailForPdf = {
  from: string;
  to: string;
  subject: string;
  /** Already formatted for a person to read. */
  date: string;
  text: string;
  /** Why this page exists, printed small at the top. */
  caption?: string;
};

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•',
};

/**
 * The words of an HTML mail, laid out roughly as it read: a block is a line, a
 * table row is a line with its cells spaced apart, a list item is a dash.
 *
 * Only reached for where the plain-text part is missing or was cut short — the
 * sender's own text part is their own rendering, and better than ours.
 */
export function htmlToText(html: string): string {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/t[dh]>/gi, '   ')
    .replace(/<\/(p|div|tr|table|h[1-6]|li|ul|ol|blockquote)>/gi, '\n')
    .replace(/<hr\b[^>]*>/gi, '\n----------------------------------------\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16) || 32))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// One line of text cut to the width it has. A word wider than the line (a URL,
// a tracking number) is broken where it runs out rather than left to run off
// the page.
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  let line = '';
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= width;
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (fits(next)) {
      line = next;
      continue;
    }
    if (line) out.push(line);
    line = word;
    while (line && !fits(line)) {
      let cut = line.length - 1;
      while (cut > 1 && !fits(line.slice(0, cut))) cut--;
      out.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  out.push(line);
  return out;
}

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 50;
const MAX_CHARS = 100_000;

export async function emailAsPdf(mail: EmailForPdf): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdf.setTitle(mail.subject || 'Email');
  pdf.setProducer('CYBills');

  // The standard fonts hold Western text only, and drawing a character they
  // lack throws. So anything outside them is printed as "?": a page that says
  // a character was there beats no page.
  const known = new Set(regular.getCharacterSet());
  const clean = (s: string) =>
    [...String(s ?? '').replace(/\t/g, '    ')]
      .map((ch) => (ch === '\n' || known.has(ch.codePointAt(0)!) ? ch : ch < ' ' ? '' : '?'))
      .join('');

  const grey = rgb(0.42, 0.45, 0.5);
  const ink = rgb(0.07, 0.07, 0.07);
  const width = A4.w - MARGIN * 2;
  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const newPage = () => {
    page = pdf.addPage([A4.w, A4.h]);
    pages.push(page);
    y = A4.h - MARGIN;
  };
  const draw = (text: string, font: PDFFont, size: number, x: number, color = ink, lead = size * 1.4) => {
    if (y - lead < MARGIN + 16) newPage();
    y -= lead;
    if (text) page.drawText(text, { x, y, size, font, color });
  };
  newPage();

  if (mail.caption) for (const l of wrap(clean(mail.caption), regular, 8, width)) draw(l, regular, 8, MARGIN, grey);
  y -= 6;
  for (const l of wrap(clean(mail.subject || '(no subject)'), bold, 14, width)) draw(l, bold, 14, MARGIN);
  y -= 8;

  const LABEL = 56;
  for (const [label, value] of [['From', mail.from], ['To', mail.to], ['Date', mail.date]] as const) {
    const lines = wrap(clean(value || '-'), regular, 10, width - LABEL);
    lines.forEach((l, i) => {
      draw(l, regular, 10, MARGIN + LABEL);
      if (i === 0) page.drawText(label, { x: MARGIN, y, size: 10, font: regular, color: grey });
    });
  }
  y -= 10;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: A4.w - MARGIN, y }, thickness: 0.5, color: rgb(0.82, 0.84, 0.86) });
  y -= 6;

  const body = clean(String(mail.text || '').replace(/\r\n?/g, '\n').slice(0, MAX_CHARS)).trim();
  if (!body) draw('The message had no text.', regular, 10, MARGIN, grey);
  for (const para of body ? body.split('\n') : []) {
    // A blank line is a gap, kept: where the sender left one is how a forwarded
    // thread shows where one message stops and the next begins.
    if (!para.trim()) {
      y -= 7;
      continue;
    }
    for (const l of wrap(para.replace(/\s+$/, ''), regular, 10, width)) draw(l, regular, 10, MARGIN);
  }

  pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${pages.length}`;
    p.drawText(label, { x: A4.w - MARGIN - regular.widthOfTextAtSize(label, 8), y: MARGIN - 14, size: 8, font: regular, color: grey });
  });

  return Buffer.from(await pdf.save());
}

/** A file name for it: what the sender called the mail, made safe to store. */
export function emailPdfName(subject: string): string {
  const base = String(subject ?? '')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${base || 'Email'}.pdf`;
}
