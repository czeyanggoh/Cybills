import { PDFDocument } from 'pdf-lib';
import { displayItemId, billFileUrl } from '@/lib/bills';
import { recordEvent } from '@/lib/salesEvents';
import { recordExport } from '@/lib/exportsStore';
import { makeZip } from '@/lib/zip';

// Client-side Costs/Sales export — CSV (exact Dext column layout), PDF (items +
// a submission-history page), or ZIP (CSV + PDF). Every export is recorded so it
// can be re-downloaded from the Exports tab.

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const n2 = (v) => num(v).toFixed(2);

// Format a date as DD-Mon-YYYY (Dext's export format).
function fmtDate(d) {
  if (!d || d === '—') return '';
  const s = String(d).trim();
  const m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})$/);
  if (m) return `${pad(m[1])}-${cap(m[2].slice(0, 3))}-${m[3]}`;
  const dt = new Date(s);
  if (!Number.isNaN(dt.getTime())) return `${pad(dt.getDate())}-${MON[dt.getMonth()]}-${dt.getFullYear()}`;
  return s;
}
function isoDate() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const esc = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLines = (rows) => rows.map((r) => r.map(esc).join(',')).join('\n');

const idOf = (d) => displayItemId(d.id ?? d.itemId);

// Absolute, clickable link to the receipt's original file (Dext puts a link in
// the Image column). Persisted bills stream from the file endpoint; fall back to
// any imageUrl the row carries. Absolute so it stays clickable in Excel/Numbers.
const ORIGIN = typeof window !== 'undefined' ? window.location.origin : '';
function imageUrlFor(d) {
  if (d.hasFile && (d.id ?? d.itemId)) return `${ORIGIN}${billFileUrl(d.id ?? d.itemId)}`;
  if (d.imageUrl) return /^https?:\/\//.test(d.imageUrl) ? d.imageUrl : `${ORIGIN}${d.imageUrl}`;
  return '';
}

// --- CSV --------------------------------------------------------------------
const SALES_COLS = ['Item ID', 'Type', 'Date', 'Due Date', 'Invoice Number', 'Customer', 'Category', 'Project', 'Tax', 'Total', 'Currency', 'Tax (SGD)', 'Total (SGD)', 'Note', 'Description', 'Image'];
function buildSalesCsv(rows) {
  const body = rows.map((d) => [
    idOf(d), d.type || 'Sales invoice', fmtDate(d.date), fmtDate(d.dueDate), d.ref || d.invoiceNumber || '',
    d.customer || '', d.category || '', d.project || '', n2(d.tax), n2(d.total), d.currency || 'SGD',
    n2(d.tax), n2(d.total), d.note || '', d.description || '', imageUrlFor(d),
  ]);
  return csvLines([SALES_COLS, ...body]);
}

const COST_COLS = ['Receipt ID', 'Type', 'Date', 'Due Date', 'Invoice Number', 'Supplier', 'Category', 'Customer', 'Project', 'Payment Method', 'Bank Account', 'Tax', 'Total', 'Currency', 'Tax (SGD)', 'Total (SGD)', 'Status', 'Owner', 'Note', 'Description', 'Image'];
function buildCostCsv(rows) {
  const body = rows.map((d) => [
    idOf(d), d.type || 'Receipt', fmtDate(d.date), fmtDate(d.dueDate), d.invoiceNumber || '',
    d.supplier || '', d.category || '', d.customer || '', d.project || '', d.paymentMethod || '', d.bankAccount || '',
    n2(d.tax), n2(d.total), d.currency || 'SGD', n2(d.tax), n2(d.total),
    d.status === 'ready' ? 'processed' : d.status || 'processed', d.user || d.owner || '', d.note || '', d.description || '', imageUrlFor(d),
  ]);
  return csvLines([COST_COLS, ...body]);
}

// --- PDF (merged receipt documents, Dext-style) -----------------------------
// The Costs/Sales PDF export is a concatenation of the actual receipt files:
// each image receipt becomes a page; each multi-page PDF receipt keeps its
// native pages. Built with pdf-lib so existing PDF pages can be copied in.
const A4 = { w: 595.28, h: 841.89 };

// Fetch a row's original receipt bytes + content type from the file endpoint.
async function fetchReceipt(d) {
  const id = d.id ?? d.itemId;
  if (!d.hasFile || !id) return null;
  try {
    const res = await fetch(billFileUrl(id));
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const type = (res.headers.get('content-type') || d.contentType || '').toLowerCase();
    return { buf, type };
  } catch {
    return null;
  }
}

// Re-encode any browser-decodable image (webp/gif/…) to PNG bytes so pdf-lib
// (which only embeds JPG/PNG) can place it.
async function toPngBytes(buf, type) {
  const url = URL.createObjectURL(new Blob([buf], { type: type || 'image/png' }));
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const b64 = canvas.toDataURL('image/png').split(',')[1];
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const isPdfBytes = (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF

// Merge every selected receipt into one PDF. Returns { bytes, added, missing }.
// Exported so the Costs "Merge documents" action can reuse the exact same
// image/PDF-combining logic the PDF export uses.
export async function buildReceiptsPdf(rows) {
  const out = await PDFDocument.create();
  let added = 0;
  let missing = 0;
  for (const d of rows) {
    // eslint-disable-next-line no-await-in-loop
    const rec = await fetchReceipt(d);
    if (!rec) { missing += 1; continue; }
    try {
      if (rec.type.includes('pdf') || isPdfBytes(rec.buf)) {
        // eslint-disable-next-line no-await-in-loop
        const src = await PDFDocument.load(rec.buf, { ignoreEncryption: true });
        // eslint-disable-next-line no-await-in-loop
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      } else {
        let img;
        if (rec.type.includes('jpg') || rec.type.includes('jpeg')) img = await out.embedJpg(rec.buf);
        else if (rec.type.includes('png')) img = await out.embedPng(rec.buf);
        else img = await out.embedPng(await toPngBytes(rec.buf, rec.type));
        const page = out.addPage([A4.w, A4.h]);
        const m = 24;
        const scale = Math.min((A4.w - m * 2) / img.width, (A4.h - m * 2) / img.height, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        page.drawImage(img, { x: (A4.w - w) / 2, y: (A4.h - h) / 2, width: w, height: h });
      }
      added += 1;
    } catch {
      missing += 1;
    }
  }
  if (added === 0) {
    const page = out.addPage([A4.w, A4.h]);
    page.drawText('No receipt images available for the selected items.', { x: 40, y: A4.h - 80, size: 12 });
  }
  const bytes = await out.save();
  return { bytes, added, missing };
}

// --- ZIP (individual receipt files, Dext-style) -----------------------------
const ymd = (d) => {
  if (!d || d === '—') return '';
  const dt = new Date(String(d).trim());
  return Number.isNaN(dt.getTime()) ? '' : `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
};
function extFor(type, fileName) {
  const t = (type || '').toLowerCase();
  if (t.includes('pdf')) return 'pdf';
  if (t.includes('png')) return 'png';
  if (t.includes('webp')) return 'webp';
  if (t.includes('gif')) return 'gif';
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  const m = /\.([a-z0-9]+)$/i.exec(fileName || '');
  return m ? m[1].toLowerCase() : 'bin';
}
const sanitizeName = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();

// Dext-style receipt filename: "<Supplier> - <YYYY-MM-DD> - <id>.<ext>".
function receiptName(d, type) {
  const party = sanitizeName(d.supplier || d.customer || d.type || '');
  const stem = [party, ymd(d.date), displayItemId(d.id ?? d.itemId)].filter(Boolean).join(' - ');
  return `${stem}.${extFor(type, d.fileName)}`;
}

// ZIP of every receipt's original file plus the CSV — matching Dext's receipt
// export (a folder of the individual documents). Returns { blob, added }.
async function buildReceiptsZip(rows, { csvText, base }) {
  const files = [{ name: `${base}.csv`, data: new TextEncoder().encode(csvText) }];
  const used = new Set([`${base}.csv`]);
  let added = 0;
  for (const d of rows) {
    // eslint-disable-next-line no-await-in-loop
    const rec = await fetchReceipt(d);
    if (!rec) continue;
    let name = receiptName(d, rec.type);
    if (used.has(name)) {
      const dot = name.lastIndexOf('.');
      let i = 2;
      let cand;
      do { cand = `${name.slice(0, dot)} (${i})${name.slice(dot)}`; i += 1; } while (used.has(cand));
      name = cand;
    }
    used.add(name);
    files.push({ name, data: rec.buf });
    added += 1;
  }
  return { blob: makeZip(files), added };
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// Re-download a stored export blob.
export function downloadExportBlob(rec) {
  triggerDownload(rec.blob, rec.filename);
}

// Main entry: generate the chosen format, download it, log an export event on
// sales items, and record it in the Exports tab. `kind` is 'costs' | 'sales'.
export async function exportDocs(rows, { kind = 'costs', format = 'csv', csvFormat = '', exportedBy = 'You' } = {}) {
  const wKind = kind === 'sales' ? 'sales' : 'costs';
  const base = `red-alpha-cybersecurity-st-eng-${isoDate()}`;
  const csvText = wKind === 'sales' ? buildSalesCsv(rows) : buildCostCsv(rows);

  let blob;
  let filename;
  let fmtLabel;
  if (format === 'csv') {
    blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
    filename = `${base}.csv`;
    fmtLabel = 'CSV';
  } else if (format === 'pdf') {
    const { bytes } = await buildReceiptsPdf(rows);
    blob = new Blob([/** @type {any} */ (bytes)], { type: 'application/pdf' });
    filename = `${base}.pdf`;
    fmtLabel = 'PDF';
  } else {
    const res = await buildReceiptsZip(rows, { csvText, base });
    blob = res.blob;
    filename = `${base}.zip`;
    fmtLabel = 'ZIP';
  }

  triggerDownload(blob, filename);

  // Log an "exported" event on sales items so it shows in their History tab.
  if (wKind === 'sales') {
    for (const d of rows) {
      if (d.persisted) recordEvent(d.id, { type: 'export', text: `Item was exported to ${format}`, actor: exportedBy });
    }
  }

  await recordExport({
    kind: wKind,
    name: base,
    filename,
    format: fmtLabel,
    csvFormat: format === 'csv' ? csvFormat || (wKind === 'sales' ? 'CYBills sales default' : 'CYBills default') : '-',
    count: rows.length,
    exportedBy,
    blob,
  });
}
