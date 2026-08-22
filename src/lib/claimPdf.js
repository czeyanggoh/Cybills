import { jsPDF } from 'jspdf';
import { PDFDocument } from 'pdf-lib';
import { pdfDate, claimRef, claimExportName, cleanHistoryText } from '@/lib/exportFormat';
import { approvalHistory } from '@/lib/approvalHistory';
import { costPath } from '@/lib/bills';
import { recordExport } from '@/lib/exportsStore';

// A4 in points, with a comfortable margin.
const W = 595.28;
const H = 841.89;
const M = 32;
const RIGHT = W - M;
const BOTTOM = H - 56;
const LINK = [37, 99, 235];

const n2 = (v) => Number(v || 0).toFixed(2);

// A claim PDF is opened from a mail client or a file, not from inside the app,
// so an item's link has to carry the host — a bare /costs/… path resolves
// against nothing and is why the Item ID looked like a link but did nothing.
const ORIGIN = typeof window !== 'undefined' ? window.location.origin : '';
const itemUrl = (id) => (id ? `${ORIGIN}${costPath(id)}` : '');

// Roll the line items up into per-category net/tax/total.
function summarise(txns) {
  const map = new Map();
  for (const t of txns) {
    const c = map.get(t.category) || { category: t.category, net: 0, tax: 0, total: 0 };
    c.net += Number(t.net || 0);
    c.tax += Number(t.tax || 0);
    c.total += Number(t.total || 0);
    map.set(t.category, c);
  }
  return [...map.values()];
}

// Build the expense-claim PDF document (mirrors Dext's export, plus a final
// "Approval history" page built from the claim's activity log). Returns the
// jsPDF doc so callers can open, download, or (in tests) serialise it.
export function buildClaimDoc(claim) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const title = `${claim.claimFor}'s Expense Claim`.toUpperCase();
  const totalExp = '{tp}';
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
    // footer
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text('Powered by CYBills', M, H - 28);
    doc.text(`Page ${page} / ${totalExp}`, RIGHT, H - 28, { align: 'right' });
    doc.setTextColor(20);
    y = 80;
  };
  const nextPage = () => {
    doc.addPage();
    chrome();
  };
  const ensure = (need) => {
    if (y + need > BOTTOM) nextPage();
  };
  const section = (label) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(70);
    doc.text(label, M, y);
    doc.setTextColor(20);
    y += 18;
  };
  chrome();

  // ---- Claim meta ------------------------------------------------------
  doc.setFontSize(9.5);
  doc.setFont('helvetica', 'bold');
  doc.text(`Claim name: ${claim.name}`, M, y);
  doc.text(`Total: ${n2(claim.total)} ${claim.currency}`, RIGHT, y, { align: 'right' });
  y += 15;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(90);
  doc.text(`Claim ID: #${claimRef(claim)}`, M, y);
  doc.text(`(incl. tax: ${n2(claim.tax)})`, RIGHT, y, { align: 'right' });
  y += 14;
  doc.text(`Claim date: ${pdfDate(claim.claimDate)}`, M, y);
  doc.setTextColor(20);
  y += 30;

  // ---- Summary by category --------------------------------------------
  section('SUMMARY BY CATEGORY');
  const sc = { net: 340, tax: 430, total: 520 };
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('Category', M, y);
  doc.text('Net (SGD)', sc.net, y, { align: 'right' });
  doc.text('Tax (SGD)', sc.tax, y, { align: 'right' });
  doc.text('Total (SGD)', sc.total, y, { align: 'right' });
  y += 16;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(60);
  for (const c of summarise(claim.transactions)) {
    ensure(18);
    doc.text(c.category, M, y);
    doc.text(n2(c.net), sc.net, y, { align: 'right' });
    doc.text(n2(c.tax), sc.tax, y, { align: 'right' });
    doc.text(n2(c.total), sc.total, y, { align: 'right' });
    y += 16;
  }
  doc.setDrawColor(220);
  doc.setLineWidth(0.5);
  doc.line(M, y - 10, RIGHT, y - 10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(20);
  doc.text('Total', M, y);
  doc.text(n2(claim.net), sc.net, y, { align: 'right' });
  doc.text(n2(claim.tax), sc.tax, y, { align: 'right' });
  doc.text(n2(claim.total), sc.total, y, { align: 'right' });
  y += 34;

  // ---- Transactions ----------------------------------------------------
  section('TRANSACTIONS');
  const hasProject = claim.transactions.some((t) => t.project);
  // The amount columns need only their header's width ("Net (SGD)" ≈ 46pt), so
  // they are pulled right to leave the free-text columns as much room as
  // possible — supplier and category are the two that were being cut off.
  const tc = hasProject
    ? { date: M, item: 92, supplier: 168, category: 258, project: 330, net: 420, tax: 492, total: RIGHT }
    : { date: M, item: 92, supplier: 168, category: 272, net: 420, tax: 492, total: RIGHT };
  // How wide each free-text cell may draw before the next column starts. They
  // WRAP within it rather than being clipped: a claim someone signs has to show
  // which supplier and which account, and "The Ice Cream …" is neither.
  const textRight = tc.net - 52; // where the right-aligned amounts' text begins
  const catWidth = (hasProject ? tc.project : textRight) - tc.category - 8;
  const supWidth = tc.category - tc.supplier - 8;
  const projWidth = hasProject ? textRight - tc.project - 8 : 0;

  const txnHeader = () => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(20);
    doc.text('Date', tc.date, y);
    doc.text('Item ID', tc.item, y);
    doc.text('Supplier', tc.supplier, y);
    doc.text('Category', tc.category, y);
    if (hasProject) doc.text('Project', tc.project, y);
    doc.text('Net (SGD)', tc.net, y, { align: 'right' });
    doc.text('Tax (SGD)', tc.tax, y, { align: 'right' });
    doc.text('Total (SGD)', tc.total, y, { align: 'right' });
    y += 16;
  };
  txnHeader();
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  for (const t of claim.transactions) {
    // Wrapped cells decide the row's height, so a two-line supplier can't be
    // written over by the row beneath it.
    const supLines = doc.splitTextToSize(String(t.supplier ?? ''), supWidth);
    const catLines = doc.splitTextToSize(String(t.category ?? ''), catWidth);
    const projLines = hasProject ? doc.splitTextToSize(String(t.project ?? ''), projWidth) : [];
    const rowLines = Math.max(1, supLines.length, catLines.length, projLines.length);
    ensure(rowLines * 11 + 7);
    if (y === 80) txnHeader(); // header was redrawn after a page break
    const top = y;
    doc.setTextColor(60);
    doc.text(pdfDate(t.date), tc.date, top);
    // A real link annotation, not just link-coloured text — the blue Item ID
    // used to be painted on and clicked through to nothing.
    const itemId = String(t.displayId || t.itemId || '');
    doc.setTextColor(LINK[0], LINK[1], LINK[2]);
    const url = itemUrl(t.itemId || t.displayId);
    if (url) doc.textWithLink(itemId, tc.item, top, { url });
    else doc.text(itemId, tc.item, top);
    doc.setTextColor(60);
    const column = (lines, x) => lines.forEach((ln, i) => doc.text(ln, x, top + i * 11));
    column(supLines, tc.supplier);
    column(catLines, tc.category);
    if (hasProject) column(projLines, tc.project);
    doc.text(n2(t.net), tc.net, top, { align: 'right' });
    doc.text(n2(t.tax), tc.tax, top, { align: 'right' });
    doc.text(n2(t.total), tc.total, top, { align: 'right' });
    y = top + rowLines * 11 + 5;
    // Item description on its own wrapped line beneath the row (matches Dext).
    if (t.description) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8);
      doc.setTextColor(120);
      const lines = doc.splitTextToSize(String(t.description), textRight - tc.supplier);
      for (const ln of lines) {
        ensure(11);
        doc.text(ln, tc.supplier, y);
        y += 11;
      }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(60);
      y += 4;
    }
  }
  doc.setDrawColor(220);
  doc.line(M, y - 10, RIGHT, y - 10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(20);
  doc.text('Total', M, y);
  doc.text(n2(claim.net), tc.net, y, { align: 'right' });
  doc.text(n2(claim.tax), tc.tax, y, { align: 'right' });
  doc.text(n2(claim.total), tc.total, y, { align: 'right' });
  y += 40;

  // ---- Approvals (signature block) ------------------------------------
  ensure(120);
  section('APPROVALS');
  y += 14;
  const sigRow = (label) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(20);
    doc.text(label, M, y);
    doc.text('Date', 430, y);
    doc.setDrawColor(160);
    doc.setLineWidth(0.6);
    doc.line(150, y + 2, 400, y + 2);
    doc.line(465, y + 2, RIGHT, y + 2);
    y += 48;
  };
  sigRow('Employee signature');
  sigRow("Approver's signature");

  // ---- Approval history (added page) ----------------------------------
  nextPage();
  section('APPROVAL HISTORY');
  y += 4;
  // The approval trail only — not the whole activity log. Five lines of "Item …
  // was added" tell an approver nothing about the approval and bury the two
  // lines that do. See approvalHistory.js for what counts.
  const events = approvalHistory(claim.history);
  if (!events.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(110);
    doc.text('This claim has not been submitted for approval yet.', M, y);
    doc.setTextColor(20);
    y += 24;
  }
  events.forEach((e, i) => {
    ensure(34);
    // timeline dot + connector
    doc.setFillColor(30, 30, 30);
    doc.circle(M + 3, y - 3, 2.4, 'F');
    if (i < events.length - 1) {
      doc.setDrawColor(210);
      doc.setLineWidth(0.8);
      doc.line(M + 3, y, M + 3, y + 30);
    }
    const text = cleanHistoryText(e.text);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(20);
    doc.text(text, M + 16, y);
    const w = doc.getTextWidth(text);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(110);
    doc.text(` by ${e.by}`, M + 16 + w, y);
    y += 13;
    doc.setFontSize(8.5);
    doc.setTextColor(150);
    doc.text(e.at, M + 16, y);
    doc.setTextColor(20);
    y += 24;
  });

  doc.putTotalPages(totalExp);
  return doc;
}

// The claim PDF as a base64 string (no data: prefix) — used to attach it to the
// Xero bill when publishing. Returns '' if rendering fails.
export function buildClaimPdfBase64(claim) {
  try {
    const doc = buildClaimDoc(claim);
    const uri = doc.output('datauristring'); // "data:application/pdf;base64,…"
    return String(uri).split(',')[1] || '';
  } catch {
    return '';
  }
}

// A4 in points, for placing receipt images one-per-page.
const A4 = [W, H];

// Fetch a transaction's original receipt document and append it to `out` (a
// pdf-lib doc). PDFs are copied page-for-page; images are placed one per page,
// scaled to fit. Best-effort: demo docs and missing files are silently skipped.
// Returns true if at least one page was appended.
async function appendReceipt(out, itemId) {
  try {
    const res = await fetch(`/api/costs/bills/${encodeURIComponent(itemId)}/file`);
    if (!res.ok) return false;
    const type = (res.headers.get('Content-Type') || '').toLowerCase();
    const buf = await res.arrayBuffer();
    if (type.includes('pdf')) {
      const src = await PDFDocument.load(buf, { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
      return pages.length > 0;
    }
    if (type.includes('png') || type.includes('jpg') || type.includes('jpeg')) {
      const img = type.includes('png') ? await out.embedPng(buf) : await out.embedJpg(buf);
      const page = out.addPage(A4);
      const s = Math.min((W - 64) / img.width, (H - 64) / img.height, 1);
      const w = img.width * s;
      const h = img.height * s;
      page.drawImage(img, { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Copy the CYBills report (jsPDF) pages into a pdf-lib doc.
async function addReportPages(out, claim) {
  const bytes = buildClaimDoc(claim).output('arraybuffer');
  const report = await PDFDocument.load(bytes);
  const pages = await out.copyPages(report, report.getPageIndices());
  pages.forEach((p) => out.addPage(p));
}

// Assemble the export PDF per Dext's three detail levels:
//   'summary'       — the report (summary + transactions + approval history) only
//   'with_receipts' — the report, then every receipt document appended at the back
//   'receipts'      — the receipt documents only
// Returns a Blob. Falls back to the report alone if no receipts resolve, so the
// file is never empty.
export async function assembleClaimPdf(claim, { detailLevel = 'with_receipts' } = {}) {
  const out = await PDFDocument.create();
  if (detailLevel !== 'receipts') await addReportPages(out, claim);
  if (detailLevel !== 'summary') {
    for (const t of claim.transactions || []) {
      // eslint-disable-next-line no-await-in-loop
      await appendReceipt(out, t.itemId);
    }
  }
  if (out.getPageCount() === 0) await addReportPages(out, claim);
  const bytes = await out.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

// Generate + open the claim PDF. Opens in a new tab; falls back to a download if
// the popup is blocked. `detailLevel` follows Dext (see assembleClaimPdf). Async
// because the receipt documents are fetched. Returns the claim id.
export async function generateClaimPdf(claim, { exportedBy = '', detailLevel = 'with_receipts' } = {}) {
  const blob = await assembleClaimPdf(claim, { detailLevel });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  const name = claimExportName(claim, 'pdf');
  if (!win) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  // Keep the URL alive long enough for the opened tab to load it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  // Record it so it appears under Exports → Expense claims.
  void recordExport({
    kind: 'claims',
    name: claim.name || name,
    filename: name,
    format: 'PDF',
    csvFormat: '-',
    count: Array.isArray(claim.transactions) ? claim.transactions.length : 1,
    exportedBy: exportedBy || claim.claimFor || 'You',
    blob,
  });
  return claim.id;
}
