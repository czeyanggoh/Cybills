// An email drawn as a PDF, as it was sent.
//
// The server can only write a mail out as TEXT — laying HTML out takes a
// browser, and it does not carry one. This page is one. So the message is
// drawn here, in a frame nobody sees, photographed and cut into A4 pages, and
// the server is handed the result to attach.
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import { mailFrameDoc, MAIL_FRAME_SANDBOX } from '@/lib/mailHtml';

const PAGE = { w: 595.28, h: 841.89, margin: 28 };
// A4 at 96dpi: the width a mail is laid out to, as a mail client's pane would.
const FRAME_WIDTH = 794;
// Browsers refuse a canvas much taller than this.
const MAX_CANVAS = 30000;

// Is this row of the picture one flat colour? A page is cut there rather than
// through a line of text.
function flatRow(ctx, y, width) {
  const row = ctx.getImageData(0, y, width, 1).data;
  for (let i = 4; i < row.length; i += 4) {
    if (Math.abs(row[i] - row[0]) > 6 || Math.abs(row[i + 1] - row[1]) > 6 || Math.abs(row[i + 2] - row[2]) > 6) {
      return false;
    }
  }
  return true;
}

/**
 * `{ html, envelope: { subject, from, to, date, caption } }` -> base64 of a PDF.
 * Throws where the message could not be drawn; the caller falls back to the
 * server's text page.
 */
export async function renderMailPdf({ html, envelope }) {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', MAIL_FRAME_SANDBOX);
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${FRAME_WIDTH}px;height:1000px;border:0;`;
  try {
    await new Promise((resolve, reject) => {
      frame.onload = resolve;
      frame.onerror = reject;
      frame.srcdoc = mailFrameDoc(html, envelope);
      document.body.appendChild(frame);
    });
    const doc = frame.contentDocument;
    if (!doc?.body) throw new Error('The message could not be laid out.');
    const width = Math.max(FRAME_WIDTH, doc.documentElement.scrollWidth);
    frame.style.width = `${width}px`;
    const height = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
    frame.style.height = `${height}px`;

    const scale = Math.min(2, MAX_CANVAS / height);
    const canvas = await html2canvas(doc.body, {
      scale,
      backgroundColor: '#ffffff',
      width,
      height,
      windowWidth: width,
      windowHeight: height,
      logging: false,
    });
    if (!canvas.width || !canvas.height) throw new Error('The message drew as nothing.');

    const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
    pdf.setProperties({ title: envelope?.subject || 'Email', creator: 'CYBills' });
    const usableW = PAGE.w - PAGE.margin * 2;
    const usableH = PAGE.h - PAGE.margin * 2;
    const pxPerPt = canvas.width / usableW;
    const pagePx = Math.floor(usableH * pxPerPt);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    let top = 0;
    let first = true;
    while (top < canvas.height) {
      let bottom = Math.min(top + pagePx, canvas.height);
      if (bottom < canvas.height) {
        // Back up to a gap between lines, a fifth of a page at most.
        const floor = bottom - Math.floor(pagePx / 5);
        for (let y = bottom; y > floor; y--) {
          if (flatRow(ctx, y, canvas.width)) {
            bottom = y;
            break;
          }
        }
      }
      const slice = document.createElement('canvas');
      slice.width = canvas.width;
      slice.height = bottom - top;
      const sctx = slice.getContext('2d');
      sctx.fillStyle = '#ffffff';
      sctx.fillRect(0, 0, slice.width, slice.height);
      sctx.drawImage(canvas, 0, top, canvas.width, slice.height, 0, 0, canvas.width, slice.height);
      if (!first) pdf.addPage();
      pdf.addImage(slice.toDataURL('image/jpeg', 0.9), 'JPEG', PAGE.margin, PAGE.margin, usableW, slice.height / pxPerPt);
      first = false;
      top = bottom;
    }
    const pages = pdf.getNumberOfPages();
    pdf.setFontSize(8);
    pdf.setTextColor(110);
    for (let i = 1; i <= pages; i++) {
      pdf.setPage(i);
      pdf.text(`Page ${i} of ${pages}`, PAGE.w - PAGE.margin, PAGE.h - 12, { align: 'right' });
    }
    return pdf.output('datauristring').split(',').pop();
  } finally {
    frame.remove();
  }
}
