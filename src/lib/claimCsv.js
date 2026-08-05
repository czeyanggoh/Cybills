// Generate + download a CSV export for an expense claim (client-side, no
// backend). "summary" rolls up by category; "items" emits one Dext-format row
// per line item.

import { csvDate, claimRef, claimExportName } from '@/lib/exportFormat';

function esc(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function summarise(txns) {
  const map = new Map();
  for (const t of txns) {
    const c = map.get(t.category) || { category: t.category, net: 0, tax: 0, total: 0 };
    c.net += Number(t.net || 0);
    c.tax += Number(t.tax || 0);
    c.total += Number(t.total || 0);
    map.set(t.category, c);
  }
  return [...map.values()].map((c) => ({
    ...c,
    net: c.net.toFixed(2),
    tax: c.tax.toFixed(2),
    total: c.total.toFixed(2),
  }));
}

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

function dextRow(claim, t) {
  const cur = claim.currency || 'SGD';
  return [
    t.displayId || t.itemId, // Receipt ID
    'Expense claim', // Type
    csvDate(t.date), // Date
    '', // Due Date
    '', // Invoice Number
    t.supplier, // Supplier
    t.category, // Category
    '', // Customer
    t.project || '', // Project
    '', // Payment Method
    '', // Bank Account
    t.tax, // Tax
    t.total, // Total
    cur, // Currency
    t.tax, // Tax (SGD)
    t.total, // Total (SGD)
    'processed', // Status
    t.addedBy || claim.claimFor || '', // Owner
    '', // Note
    t.description || '', // Description
    '', // Image
  ];
}

export function generateClaimCsv(claim, { detailLevel = 'summary' } = {}) {
  const rows = [];
  if (detailLevel === 'items') {
    rows.push(DEXT_COLUMNS);
    for (const t of claim.transactions) rows.push(dextRow(claim, t));
  } else {
    rows.push(['Claim name', 'Claim ID', 'Claim date', 'Category', 'Net (SGD)', 'Tax (SGD)', 'Total (SGD)']);
    for (const c of summarise(claim.transactions)) {
      rows.push([claim.name, claimRef(claim), csvDate(claim.claimDate), c.category, c.net, c.tax, c.total]);
    }
    rows.push(['', '', '', 'Total', claim.net, claim.tax, claim.total]);
  }
  download(claimExportName(claim, 'csv'), rows.map((r) => r.map(esc).join(',')).join('\n'));
}
