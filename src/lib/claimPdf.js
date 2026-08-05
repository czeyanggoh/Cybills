import { jsPDF } from 'jspdf';
import { pdfDate, claimRef, claimExportName } from '@/lib/exportFormat';

// A4 in points, with a comfortable margin.
const W = 595.28;
const H = 841.89;
const M = 32;
const RIGHT = W - M;
const BOTTOM = H - 56;
const LINK = [37, 99, 235];

const n2 = (v) => Number(v || 0).toFixed(2);

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
  // Trim text to fit a column width, adding an ellipsis, so cells never bleed
  // into the next column (the transactions table is tight in portrait A4).
  const clip = (text, width) => {
    let s = String(text ?? '');
    if (doc.getTextWidth(s) <= width) return s;
    while (s.length > 1 && doc.getTextWidth(`${s}…`) > width) s = s.slice(0, -1);
    return `${s}…`;
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
  const tc = hasProject
    ? { date: M, item: 98, supplier: 162, category: 236, project: 338, net: 432, tax: 498, total: RIGHT }
    : { date: M, item: 98, supplier: 172, category: 252, net: 432, tax: 498, total: RIGHT };
  // How wide each free-text cell may draw before the next column starts.
  const catWidth = (hasProject ? tc.project : tc.net - 44) - tc.category - 6;
  const supWidth = tc.category - tc.supplier - 6;
  const projWidth = hasProject ? tc.net - 44 - tc.project - 6 : 0;

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
    ensure(18);
    if (y === 80) txnHeader(); // header was redrawn after a page break
    doc.setTextColor(60);
    doc.text(pdfDate(t.date), tc.date, y);
    doc.setTextColor(LINK[0], LINK[1], LINK[2]);
    doc.text(String(t.displayId || t.itemId), tc.item, y);
    doc.setTextColor(60);
    doc.text(clip(t.supplier, supWidth), tc.supplier, y);
    doc.text(clip(t.category, catWidth), tc.category, y);
    if (hasProject) doc.text(clip(t.project || '', projWidth), tc.project, y);
    doc.text(n2(t.net), tc.net, y, { align: 'right' });
    doc.text(n2(t.tax), tc.tax, y, { align: 'right' });
    doc.text(n2(t.total), tc.total, y, { align: 'right' });
    y += 16;
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

  doc.putTotalPages(totalExp);
  return doc;
}

// Generate + open the claim PDF. Opens in a new tab; falls back to a download
// if the popup is blocked. Returns the claim id.
export function generateClaimPdf(claim) {
  const doc = buildClaimDoc(claim);
  const url = doc.output('bloburl');
  const win = window.open(url, '_blank');
  if (!win) doc.save(claimExportName(claim, 'pdf'));
  return claim.id;
}
