// Expense claims in foreign currency. Two separate faults, both covered here:
//
//  1. A USD receipt on an SGD claim was counted as SGD — 25 dollars of US
//     software added to the claim as 25 Singapore dollars. It is now converted:
//     at the receipt's own SGD restatement where it printed one, else at the
//     day's rate for the receipt's date, and the line says which.
//  2. A claim in a currency the receiving Xero does not hold (no multi-currency)
//     was refused outright. It now posts in the base currency at the day's rate.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-claim-fx-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'test-key';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-1', orgId: 'cybm', name: 'Nucleo Consulting', tenantId: 't-1', tenantName: 'Nucleo', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

// --- stub: the Xero relay and the day's-rate service ------------------------
let posted: any = null;
const fxAsked: string[] = [];
const stub = http.createServer((req, res) => {
  const url = new URL(String(req.url), 'http://x');
  const path = decodeURIComponent(url.pathname);
  res.setHeader('content-type', 'application/json');
  if (path.startsWith('/fx/')) {
    fxAsked.push(String(req.url));
    const to = url.searchParams.get('to') || '';
    const from = url.searchParams.get('from') || '';
    const rates: Record<string, number> = { 'USD>SGD': 1.3, 'MYR>SGD': 0.3 };
    const rate = rates[`${from}>${to}`];
    if (!rate) { res.statusCode = 404; res.end('{}'); return; }
    res.end(JSON.stringify({ amount: 1, base: from, rates: { [to]: rate } }));
    return;
  }
  if (path.endsWith('/Organisation')) { res.end(JSON.stringify({ Organisations: [{ BaseCurrency: 'SGD' }] })); return; }
  if (path.endsWith('/Currencies')) { res.end(JSON.stringify({ Currencies: [{ Code: 'SGD' }] })); return; }
  if (path.endsWith('/TrackingCategories')) { res.end(JSON.stringify({ TrackingCategories: [] })); return; }
  if (path.endsWith('/Invoices')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      posted = JSON.parse(body || '{}').Invoices?.[0] ?? null;
      res.end(JSON.stringify({ Invoices: [{ InvoiceID: 'inv-1', InvoiceNumber: 'B-1', Status: 'DRAFT', HasErrors: false }] }));
    });
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not_found', path }));
});
await new Promise<void>((r) => stub.listen(4632, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4632';
process.env.FX_RATES_URL = 'http://127.0.0.1:4632/fx';

const express = (await import('express')).default;
const { claimsRouter } = await import('../src/claims.ts');
const { xeroRouter } = await import('../src/xero.ts');
const { insertBill } = await import('../src/store.ts');
const { saveCollection } = await import('../src/jsonStore.ts');

const bill = (f: Record<string, unknown>) =>
  insertBill({
    orgId: 'cybm', kind: 'cost', status: 'expenseclaim', invoiceNumber: '', documentType: 'Receipt',
    category: '61000 - Software expense', description: '', tax: '0', ...f,
  } as any);
const usd = bill({ supplier: 'HighLevel LLC', currency: 'USD', total: '25', date: '2026-09-14' });
const restated = bill({ supplier: 'Microsoft', currency: 'USD', total: '17.17', tax: '1.42', baseCurrency: 'SGD', baseTotal: 22.2, baseTax: 1.84, date: '2026-09-10' });
const nzd = bill({ supplier: 'Air NZ', currency: 'NZD', total: '100', date: '2026-09-12' });
const sgd = bill({ supplier: 'Grab', currency: 'SGD', total: '12', date: '2026-09-11' });

const txn = (b: any) => ({ itemId: b.id, date: b.date, supplier: b.supplier, category: b.category, net: String(b.total), tax: '0', total: String(b.total) });
const claim = (id: string, f: Record<string, unknown>) => ({
  id, workspaceId: 'cybm', orgId: 'cybm', claimFor: 'Sandra Yeow', type: 'Regular', name: 'Sept claim',
  claimDate: '2026-09-30', endDate: '2026-09-30', currency: 'SGD', transactions: [],
  history: [], approvalStatus: '', approver: '', approverEmail: '', decidedBy: '', decidedAt: '',
  archived: false, deleted: false, createdBy: '', createdAt: new Date(0).toISOString(),
  hrSentAt: '', hrSentAmount: '', hrSentBy: '', hrRevision: 0, ...f,
});
saveCollection('claims', [
  claim('c-open', { transactions: [txn(usd), txn(restated), txn(sgd)] }),
  claim('c-norate', { transactions: [txn(nzd)] }),
  // Frozen at approval with the NZD item and no rate: publishing must refuse.
  claim('c-approved-norate', {
    approvalStatus: 'approved',
    transactions: [{ ...txn(nzd), origCurrency: 'NZD', origTotal: '100.00', fxMissing: true }],
  }),
  // A claim raised IN US dollars, for a SGD-only Xero.
  claim('c-usd', {
    approvalStatus: 'approved', currency: 'USD',
    transactions: [{ itemId: 'x1', date: '2026-09-14', supplier: 'HighLevel LLC', category: '61000 - Software expense', net: '25', tax: '0', total: '25' }],
  }),
]);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/claims', claimsRouter);
app.use('/api/xero', xeroRouter);
const server = app.listen(4633, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// 1) The list converts a foreign receipt the claim's currency does not match.
const list = await (await fetch('http://127.0.0.1:4633/api/claims')).json();
const open = list.claims.find((c: any) => c.id === 'c-open');
const line = (b: any) => open.transactions.find((t: any) => t.itemId === b.id);
check('USD receipt: counted at the day rate, not as SGD', line(usd).total, '32.50');
check('…and says so', [line(usd).origCurrency, line(usd).origTotal, line(usd).fxRate, line(usd).fxSource], ['USD', '25.00', '1.3', 'day']);
check('…asked for the receipt\'s own date', fxAsked.some((u) => u.startsWith('/fx/2026-09-14?from=USD&to=SGD')), true);
check('restated receipt: its own SGD figure, no lookup', [line(restated).total, line(restated).fxSource], ['22.20', 'document']);
check('SGD receipt: untouched', [line(sgd).total, line(sgd).origCurrency], ['12.00', undefined]);
const noRate = list.claims.find((c: any) => c.id === 'c-norate').transactions[0];
check('no rate to be had: kept as printed, and flagged', [noRate.total, noRate.fxMissing], ['100.00', true]);

// 2) Publishing a claim that still carries an unconverted item is refused.
const publish = async (claimId: string) => {
  posted = null;
  const res = await fetch('http://127.0.0.1:4633/api/xero/organisations/org-1/publish-claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claimId, status: 'DRAFT' }),
  });
  return { status: res.status, body: await res.json(), posted };
};
let r = await publish('c-approved-norate');
check('an unconverted item refuses the publish', [r.status, r.body.error, r.posted], [422, 'no_exchange_rate', null]);

// 3) A USD claim into a SGD-only Xero posts in SGD at the day's rate.
r = await publish('c-usd');
check('USD claim, no multi-currency: published', r.status, 200);
check('…in SGD', r.posted?.CurrencyCode, 'SGD');
check('…at the day rate', r.posted?.LineItems?.[0]?.UnitAmount, 32.5);
check('…and the bill says so', /\(USD claim @ 1\.3 SGD\/USD\)/.test(String(r.posted?.LineItems?.[0]?.Description)), true);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
// Closed and drained rather than process.exit(): exiting with the HTTP
// connections still open trips a libuv assertion on Windows.
process.exitCode = failures ? 1 : 0;
server.closeAllConnections();
stub.closeAllConnections();
await new Promise((r) => server.close(r));
await new Promise((r) => stub.close(r));
