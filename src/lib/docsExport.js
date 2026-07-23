import { jsPDF } from 'jspdf';
import { displayItemId } from '@/lib/bills';
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

// --- CSV --------------------------------------------------------------------
const SALES_COLS = ['Item ID', 'Type', 'Date', 'Due Date', 'Invoice Number', 'Customer', 'Category', 'Project', 'Tax', 'Total', 'Currency', 'Tax (SGD)', 'Total (SGD)', 'Note', 'Description', 'Image'];
function buildSalesCsv(rows) {
  const body = rows.map((d) => [
    idOf(d), d.type || 'Sales invoice', fmtDate(d.date), fmtDate(d.dueDate), d.ref || d.invoiceNumber || '',
    d.customer || '', d.category || '', d.project || '', n2(d.tax), n2(d.total), d.currency || 'SGD',
    n2(d.tax), n2(d.total), d.note || '', d.description || '', d.imageUrl || '',
  ]);
  return csvLines([SALES_COLS, ...body]);
}

const COST_COLS = ['Receipt ID', 'Type', 'Date', 'Due Date', 'Invoice Number', 'Supplier', 'Category', 'Customer', 'Project', 'Payment Method', 'Bank Account', 'Tax', 'Total', 'Currency', 'Tax (SGD)', 'Total (SGD)', 'Status', 'Owner', 'Note', 'Description', 'Image'];
function buildCostCsv(rows) {
  const body = rows.map((d) => [
    idOf(d), d.type || 'Receipt', fmtDate(d.date), fmtDate(d.dueDate), d.invoiceNumber || '',
    d.supplier || '', d.category || '', d.customer || '', d.project || '', d.paymentMethod || '', d.bankAccount || '',
    n2(d.tax), n2(d.total), d.currency || 'SGD', n2(d.tax), n2(d.total),
    d.status === 'ready' ? 'processed' : d.status || 'processed', d.user || d.owner || '', d.note || '', d.description || '', d.imageUrl || '',
  ]);
  return csvLines([COST_COLS, ...body]);
}

// --- PDF --------------------------------------------------------------------
const W = 595.28;
const H = 841.89;
const M = 32;
const RIGHT = W - M;
const BOTTOM = H - 56;

function buildDocsPdf(rows, { kind }) {
  const isSales = kind === 'sales';
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const title = (isSales ? 'Sales export' : 'Costs export').toUpperCase();
  const totalTag = '{tp}';
  let page = 0;
  let y = 0;

  const chrome = () => {
    page += 1;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(20);
    doc.text(title, RIGHT, 44, { align: 'right' });
    doc.setDrawColor(170);
    doc.setLineWidth(0.7);
    doc.line(M, 54, RIGHT, 54);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text('Powered by CYBills', M, H - 28);
    doc.text(`Page ${page} / ${totalTag}`, RIGHT, H - 28, { align: 'right' });
    doc.setTextColor(20);
    y = 80;
  };
  const nextPage = () => { doc.addPage(); chrome(); };
  const ensure = (need) => { if (y + need > BOTTOM) nextPage(); };
  const section = (label) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(70);
    doc.text(label, M, y);
    doc.setTextColor(20);
    y += 18;
  };

  chrome();
  doc.setFontSize(9.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(90);
  doc.text(`${rows.length} item${rows.length === 1 ? '' : 's'} · generated ${fmtDate(new Date().toISOString())}`, M, y);
  doc.setTextColor(20);
  y += 26;

  section('ITEMS');
  const partyLabel = isSales ? 'Customer' : 'Supplier';
  const c = { date: M, id: 92, party: 168, category: 320, tax: 470, total: RIGHT };
  const header = () => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(20);
    doc.text('Date', c.date, y);
    doc.text('Item ID', c.id, y);
    doc.text(partyLabel, c.party, y);
    doc.text('Category', c.category, y);
    doc.text('Tax', c.tax, y, { align: 'right' });
    doc.text('Total', c.total, y, { align: 'right' });
    y += 16;
  };
  header();
  doc.setFont('helvetica', 'normal');
  let totTax = 0;
  let totAmt = 0;
  for (const d of rows) {
    ensure(18);
    if (y === 80) header();
    doc.setTextColor(60);
    doc.text(fmtDate(d.date) || '—', c.date, y);
    doc.text(String(idOf(d)), c.id, y);
    const party = isSales ? d.customer : d.supplier;
    doc.text(doc.splitTextToSize(party || '—', c.category - c.party - 6)[0], c.party, y);
    doc.text(doc.splitTextToSize(d.category || '—', c.tax - c.category - 40)[0], c.category, y);
    doc.text(n2(d.tax), c.tax, y, { align: 'right' });
    doc.text(n2(d.total), c.total, y, { align: 'right' });
    totTax += num(d.tax);
    totAmt += num(d.total);
    y += 16;
  }
  doc.setDrawColor(220);
  doc.setLineWidth(0.5);
  doc.line(M, y - 10, RIGHT, y - 10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(20);
  doc.text('Total (SGD)', M, y);
  doc.text(totTax.toFixed(2), c.tax, y, { align: 'right' });
  doc.text(totAmt.toFixed(2), c.total, y, { align: 'right' });

  // ---- Submission history (added page) --------------------------------
  nextPage();
  section('SUBMISSION HISTORY');
  y += 4;
  const when = new Date().toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  rows.forEach((d) => {
    ensure(46);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(20);
    doc.text(`Item ${idOf(d)} — ${(isSales ? d.customer : d.supplier) || '—'}`, M, y);
    y += 14;
    const line = (text, sub) => {
      doc.setFillColor(30, 30, 30);
      doc.circle(M + 3, y - 3, 2, 'F');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(60);
      doc.text(text, M + 14, y);
      doc.setFontSize(8.5);
      doc.setTextColor(150);
      doc.text(sub, RIGHT, y, { align: 'right' });
      doc.setTextColor(20);
      y += 15;
    };
    line(`Uploaded via web by ${d.user || d.owner || 'Astrid Yang'}`, fmtDate(d.date) || '');
    line('Processing completed by CYBills', fmtDate(d.date) || '');
    line(`Exported by Astrid Yang`, when);
    y += 10;
  });

  doc.putTotalPages(totalTag);
  return doc;
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
export async function exportDocs(rows, { kind = 'costs', format = 'csv', csvFormat = '', exportedBy = 'Astrid Yang' } = {}) {
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
    blob = buildDocsPdf(rows, { kind: wKind }).output('blob');
    filename = `${base}.pdf`;
    fmtLabel = 'PDF';
  } else {
    const enc = new TextEncoder();
    const pdfBytes = new Uint8Array(buildDocsPdf(rows, { kind: wKind }).output('arraybuffer'));
    blob = makeZip([
      { name: `${base}.csv`, data: enc.encode(csvText) },
      { name: `${base}.pdf`, data: pdfBytes },
    ]);
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
