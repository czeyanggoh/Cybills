// Combining the files behind one document into a single PDF.
//
// The Files tab lets a person choose which of the files a mail carried (and the
// email itself) stand as ONE document's proof. One file is used as it is; more
// are joined, in the order they were picked: PDFs page for page, a PNG or JPEG
// on a page of its own. Anything else is refused by name rather than dropped,
// since a "combined" file quietly missing one of the ones picked is worse than
// an error.
import type { Readable } from 'node:stream';
import { PDFDocument } from 'pdf-lib';

export type Part = { name: string; bytes: Buffer };

export class CombineError extends Error {}

const A4 = { w: 595.28, h: 841.89, margin: 28 };

export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';
const isPng = (b: Buffer) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;

export async function combineToPdf(parts: Part[]): Promise<Buffer> {
  const out = await PDFDocument.create();
  for (const part of parts) {
    if (isPdf(part.bytes)) {
      let src: PDFDocument;
      try {
        src = await PDFDocument.load(part.bytes);
      } catch {
        throw new CombineError(`${part.name} could not be opened (it may be password-protected or damaged).`);
      }
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    } else if (isPng(part.bytes) || isJpeg(part.bytes)) {
      const img = isPng(part.bytes) ? await out.embedPng(part.bytes) : await out.embedJpg(part.bytes);
      const room = { w: A4.w - 2 * A4.margin, h: A4.h - 2 * A4.margin };
      const scale = Math.min(room.w / img.width, room.h / img.height, 1);
      const w = img.width * scale;
      const h = img.height * scale;
      const page = out.addPage([A4.w, A4.h]);
      page.drawImage(img, { x: (A4.w - w) / 2, y: A4.h - A4.margin - h, width: w, height: h });
    } else {
      throw new CombineError(`${part.name} is not a PDF, PNG or JPEG, so it cannot be combined.`);
    }
  }
  if (!out.getPageCount()) throw new CombineError('There is nothing to combine.');
  return Buffer.from(await out.save());
}
