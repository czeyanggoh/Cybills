// Generate + download a CSV export for an expense claim (client-side, no
// backend). "summary" rolls up by category; "items" lists every line item.

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

export function generateClaimCsv(claim, { detailLevel = 'summary' } = {}) {
  const rows = [];
  if (detailLevel === 'items') {
    rows.push(['Date', 'Item ID', 'Supplier', 'Category', 'Project', 'Net (SGD)', 'Tax (SGD)', 'Total (SGD)']);
    for (const t of claim.transactions) {
      rows.push([t.date, t.displayId || t.itemId, t.supplier, t.category, t.project || '', t.net, t.tax, t.total]);
    }
    rows.push(['', '', '', '', 'Total', claim.net, claim.tax, claim.total]);
  } else {
    rows.push(['Claim name', 'Claim ID', 'Claim date', 'Category', 'Net (SGD)', 'Tax (SGD)', 'Total (SGD)']);
    for (const c of summarise(claim.transactions)) {
      rows.push([claim.name, claim.id, claim.claimDate, c.category, c.net, c.tax, c.total]);
    }
    rows.push(['', '', '', 'Total', claim.net, claim.tax, claim.total]);
  }
  download(`${claim.id}.csv`, rows.map((r) => r.map(esc).join(',')).join('\n'));
}
