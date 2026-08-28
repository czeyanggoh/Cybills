// Generate + download a CSV export for an expense claim (client-side, no
// backend). "summary" rolls up by category; "items" emits one Dext-format row
// per line item.

import { csvDate, claimRef, claimExportName } from '@/lib/exportFormat';
import { EXPORT_COLUMNS } from '@/lib/exportSettings';
import { recordExport } from '@/lib/exportsStore';
import { fetchBills, billToDoc, fetchShareLinks } from '@/lib/bills';

// A claim's line-item snapshots only carry a handful of fields (date, supplier,
// category, description, amounts). The rest of the accounting substance — invoice
// number, due date, payment method, customer, note — lives on the underlying cost
// document. Pull it back in from the live docs so the export isn't full of blanks.
// Best-effort: any item whose document can't be found keeps its snapshot as-is.
export async function enrichClaimForExport(claim) {
  let bills = [];
  try {
    bills = await fetchBills();
  } catch {
    bills = [];
  }
  const byId = new Map(bills.map((b) => [String(b.id), billToDoc(b)]));
  const transactions = (claim.transactions || []).map((t) => {
    const d = byId.get(String(t.itemId));
    if (!d) return t;
    return {
      ...t,
      date: t.date && t.date !== '—' ? t.date : d.date,
      supplier: t.supplier || d.supplier,
      category: t.category || d.category,
      description: t.description || d.description,
      project: t.project || d.project,
      currency: t.currency || d.currency,
      taxRate: t.taxRate || d.taxRate,
      invoiceNumber: t.invoiceNumber || d.invoiceNumber,
      dueDate: t.dueDate || d.dueDate,
      paymentMethod: t.paymentMethod || d.paymentMethod,
      customer: t.customer || d.customer,
      note: t.note || d.note,
      fileName: t.fileName || d.fileName,
    };
  });
  return { ...claim, transactions };
}

// The origin an exported link has to name: the file is opened outside CYBills,
// where a relative path means nothing.
const ORIGIN = typeof window !== 'undefined' ? window.location.origin : '';

// A signed link to the document behind a claim line, or '' when there is none
// to give — the entity has Image sharing off, or the line has no stored file.
// An empty cell is honest; a filename is not, because nobody can open it.
function imageUrlFor(t, links = {}) {
  const shared = links[String(t?.itemId ?? t?.id ?? '')];
  return shared ? `${ORIGIN}${shared}` : '';
}

// Escape a field for a given delimiter (',' default, ';' for comma-decimal CSV).
function escFor(delimiter) {
  const re = new RegExp(`["${delimiter}\\n]`);
  return (v) => {
    const s = String(v ?? '');
    return re.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
}

// Format a number string with the chosen decimal separator.
function num(v, sep) {
  const s = Number(v || 0).toFixed(2);
  return sep === 'Comma (,)' ? s.replace('.', ',') : s;
}

// Format an ISO date (YYYY-MM-DD) per the chosen Custom CSV date format.
function fmtDate(iso, dateFormat = '') {
  if (!iso || iso === '—') return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return csvDate(iso);
  const [, y, mo, d] = m;
  if (dateFormat.startsWith('YYYY-MM-DD')) return `${y}-${mo}-${d}`;
  if (dateFormat.startsWith('DD/MM/YYYY')) return `${d}/${mo}/${y}`;
  if (dateFormat.startsWith('MM/DD/YYYY')) return `${mo}/${d}/${y}`;
  return csvDate(iso); // DD-Mon-YYYY (default)
}

// Value of each selectable Custom CSV column for one claim line item. `f` is the
// export settings (decimalSeparator, dateFormat). Blank for fields a claim has
// no data for (kept so the column still appears if the user selected it).
const CUSTOM_COL = {
  'Receipt ID': (c, t) => t.displayId || t.itemId,
  'Invoice number': (c, t) => t.invoiceNumber || '',
  Type: () => 'Expense claim',
  Status: () => 'processed',
  Owner: (c, t) => t.addedBy || c.claimFor || '',
  Date: (c, t, cur, f) => fmtDate(t.date, f.dateFormat),
  'Due date': (c, t, cur, f) => fmtDate(t.dueDate, f.dateFormat),
  Supplier: (c, t) => t.supplier || '',
  Customer: (c, t) => t.customer || '',
  Description: (c, t) => t.description || '',
  Category: (c, t) => t.category || '',
  'Product/Service': () => '',
  'Project 1': (c, t) => t.project || '',
  'Payment method': (c, t) => t.paymentMethod || '',
  Currency: (c, t) => t.currency || c.currency || 'SGD',
  'Tax rate': (c, t) => t.taxRate || '',
  'Quantity (line items)': () => '',
  'Unit price (net)': (c, t, cur, f) => num(t.net, f.decimalSeparator),
  'Unit price (total)': (c, t, cur, f) => num(t.total, f.decimalSeparator),
  'Net amount': (c, t, cur, f) => num(t.net, f.decimalSeparator),
  'Tax amount': (c, t, cur, f) => num(t.tax, f.decimalSeparator),
  'Total amount': (c, t, cur, f) => num(t.total, f.decimalSeparator),
  'Net with currency': (c, t, cur, f) => `${cur} ${num(t.net, f.decimalSeparator)}`,
  'Tax with currency': (c, t, cur, f) => `${cur} ${num(t.tax, f.decimalSeparator)}`,
  'Total with currency': (c, t, cur, f) => `${cur} ${num(t.total, f.decimalSeparator)}`,
  'Base net amount': (c, t, cur, f) => num(t.net, f.decimalSeparator),
  'Base total amount': (c, t, cur, f) => num(t.total, f.decimalSeparator),
  Note: (c, t) => t.note || '',
  // A LINK to the document, not the name of a file nobody has. The column is
  // read in Excel by an accountant with no CYBills sign-in, so it carries a
  // signed, expiring link (shareLinks.ts) — the same one the Costs export uses.
  // Absent when the entity has Image sharing off, in which case the filename is
  // no more use than nothing.
  Image: (c, t, _cur, _f, links) => imageUrlFor(t, links),
  'Project 2': () => '',
};

function download(name, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Dext's per-receipt column schema (accountants import against these headers).
const DEXT_COLUMNS = [
  'Receipt ID', 'Type', 'Date', 'Due Date', 'Invoice Number', 'Supplier',
  'Category', 'Customer', 'Project', 'Payment Method', 'Bank Account', 'Tax',
  'Total', 'Currency', 'Tax (SGD)', 'Total (SGD)', 'Status', 'Owner', 'Note',
  'Description', 'Image',
];

function dextRow(claim, t, links) {
  const cur = claim.currency || 'SGD';
  return [
    t.displayId || t.itemId, // Receipt ID
    'Expense claim', // Type
    csvDate(t.date), // Date
    csvDate(t.dueDate), // Due Date
    t.invoiceNumber || '', // Invoice Number
    t.supplier, // Supplier
    t.category, // Category
    t.customer || '', // Customer
    t.project || '', // Project
    t.paymentMethod || '', // Payment Method
    '', // Bank Account
    t.tax, // Tax
    t.total, // Total
    t.currency || cur, // Currency
    t.tax, // Tax (SGD)
    t.total, // Total (SGD)
    'processed', // Status
    t.addedBy || claim.claimFor || '', // Owner
    t.note || '', // Note
    t.description || '', // Description
    imageUrlFor(t, links), // Image
  ];
}

// One row for the whole claim, in Dext's column format (Type "Expense claim").
// Mirrors Dext's expense-claim export: the claim as a single payable row.
function claimRow(claim) {
  const cur = claim.currency || 'SGD';
  // The claim's own date if set, else the most recent line-item date, so the
  // summary row is never dateless.
  const itemDates = (claim.transactions || []).map((t) => t.date).filter((d) => d && d !== '—');
  const date = claim.endDate || claim.claimDate || itemDates[itemDates.length - 1] || '';
  return [
    claimRef(claim), // Receipt ID (the claim's id)
    'Expense claim', // Type
    csvDate(date), // Date
    '', // Due Date
    '', // Invoice Number
    claim.claimFor || '', // Supplier (the claimant)
    '', // Category
    '', // Customer
    '', // Project
    '', // Payment Method
    '', // Bank Account
    claim.tax, // Tax
    claim.total, // Total
    cur, // Currency
    claim.tax, // Tax (SGD)
    claim.total, // Total (SGD)
    'processed', // Status
    claim.claimFor || '', // Owner
    '', // Note
    '', // Description
    '', // Image
  ];
}

// format: 'cybills' (fixed accounting schema) | 'custom' (the Business-settings
// column selection). `settings` are the Exports settings (columns, decimal
// separator, date format) — required for the 'custom' format.
// Build the CSV text (and its filename) for a claim without touching the DOM,
// so it can be downloaded OR emailed as an attachment. Pure.
export function buildClaimCsv(claim, { detailLevel = 'summary', format = 'cybills', settings = null, links = {} } = {}) {
  const f = settings || {};
  // Comma decimals need a non-comma field delimiter, so switch to ';'.
  const delimiter = f.decimalSeparator === 'Comma (,)' ? ';' : ',';
  const esc = escFor(delimiter);
  const rows = [];

  if (format === 'custom' && Array.isArray(f.columns) && f.columns.length) {
    // Emit exactly the selected columns, in the canonical order, one row/item.
    const cols = EXPORT_COLUMNS.filter((c) => f.columns.includes(c));
    const cur = claim.currency || 'SGD';
    rows.push(cols);
    for (const t of claim.transactions) {
      rows.push(cols.map((c) => (CUSTOM_COL[c] ? CUSTOM_COL[c](claim, t, cur, f, links) : '')));
    }
  } else if (detailLevel === 'items') {
    // Per-receipt rows in Dext's column format.
    rows.push(DEXT_COLUMNS);
    for (const t of claim.transactions) rows.push(dextRow(claim, t, links));
  } else {
    // Claim summary: one row for the whole claim. When the claim has a single
    // item there's nothing to roll up, so emit that item's full row (all its
    // document fields) rather than the sparse claim-level row.
    rows.push(DEXT_COLUMNS);
    const txns = claim.transactions || [];
    rows.push(txns.length === 1 ? dextRow(claim, txns[0], links) : claimRow(claim));
  }
  const name = claimExportName(claim, 'csv');
  const text = rows.map((r) => r.map(esc).join(delimiter)).join('\n');
  return { name, text };
}

export async function generateClaimCsv(claim, { detailLevel = 'summary', format = 'cybills', settings = null, exportedBy = '' } = {}) {
  // Pull each item's live document fields in before building the rows.
  const enriched = await enrichClaimForExport(claim);
  // One signed link per document, minted here rather than written into the file
  // as a bare URL: the person opening the spreadsheet has no session in CYBills,
  // and the entity may have Image sharing switched off, in which case the column
  // stays empty and every link already handed out stops working.
  const links = await fetchShareLinks((enriched.transactions || []).map((t) => t.itemId));
  const { name, text } = buildClaimCsv(enriched, { detailLevel, format, settings, links });
  download(name, text);
  // Record it so it appears under Exports → Expense claims.
  void recordExport({
    kind: 'claims',
    name: claim.name || name,
    filename: name,
    format: 'CSV',
    csvFormat: format === 'custom' ? 'Custom CSV' : 'CYBills default',
    count: Array.isArray(claim.transactions) ? claim.transactions.length : 1,
    // The claimant is a reasonable second guess at who exported it; "You" is
    // not a guess at all, so nothing is written rather than a word that names
    // whoever happens to be reading.
    exportedBy: exportedBy || claim.claimFor || '',
    blob: new Blob([text], { type: 'text/csv;charset=utf-8;' }),
  });
}

// --- The LIST, exported ------------------------------------------------------
// One row per claim, the columns the Expense claims table shows. A different
// question from exporting ONE claim (which lists its receipts): this answers
// "what claims are there, whose are they, where did each get to" — which is what
// somebody reconciling a month, or chasing approvals, actually needs.
//
// Takes whatever the caller passes, so it exports exactly what is on screen:
// the ticked rows when anything is ticked, otherwise the filtered list. Nothing
// here re-filters, because the toolbar has already said what is wanted.
const LIST_COLUMNS = [
  'Claim ID',
  'Claim name',
  'Claim for',
  'Type',
  'Approval status',
  'Approver',
  'Approved on',
  'Reimbursement',
  'Reimbursed on',
  'End date',
  'Currency',
  'Tax',
  'Total',
  'Items',
];

const LIST_STATUS = { approved: 'Approved', rejected: 'Rejected', awaiting: 'Waiting for approval' };

export function buildClaimsListCsv(claims, { settings = null } = {}) {
  const f = settings || {};
  const sep = f.decimalSeparator === 'Comma (,)' ? ';' : ',';
  const esc = escFor(sep);
  const rows = (Array.isArray(claims) ? claims : []).map((c) => [
    claimRef(c),
    c.name || '',
    c.claimFor || '',
    c.type || '',
    LIST_STATUS[c.approvalStatus] || 'Not submitted',
    // Before a decision, the person it waits on; after, whoever made it.
    c.decidedBy || c.approver || '',
    // Only for an approved claim: `decidedAt` is stamped by a rejection too,
    // and a date under "Approved on" beside a rejected claim reads as the
    // opposite of what happened.
    c.approvalStatus === 'approved' && c.decidedAt ? fmtDate(c.decidedAt, f.dateFormat) : '',
    c.xeroStatus || '',
    c.xeroPaidDate ? fmtDate(c.xeroPaidDate, f.dateFormat) : '',
    c.endDate ? fmtDate(c.endDate, f.dateFormat) : '',
    c.currency || 'SGD',
    num(c.tax, f.decimalSeparator),
    num(c.total, f.decimalSeparator),
    Array.isArray(c.transactions) ? c.transactions.length : 0,
  ]);
  const text = [LIST_COLUMNS, ...rows].map((r) => r.map(esc).join(sep)).join('\r\n');
  const stamp = new Date().toISOString().slice(0, 10);
  return { name: `expense-claims-${stamp}.csv`, text };
}

export async function exportClaimsList(claims, { settings = null, exportedBy = '' } = {}) {
  const { name, text } = buildClaimsListCsv(claims, { settings });
  download(name, text);
  void recordExport({
    kind: 'claims',
    name: `Expense claims (${claims.length})`,
    filename: name,
    format: 'CSV',
    csvFormat: 'CYBills default',
    count: claims.length,
    exportedBy,
    blob: new Blob([text], { type: 'text/csv;charset=utf-8;' }),
  });
}
