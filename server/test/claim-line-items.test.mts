// A receipt on an expense claim posts under its OWN tax code, and a receipt
// with its own line items posts as those lines — the way it would published on
// its own.
//
// The case that showed it: Jenny Lye's September auto claim. The LINKUS receipt
// (275.49, GST 20.84 printed at 9% on a different base) was split on its page
// into 231.56 at 9% and 23.09 outside GST, and coded Standard-Rated Purchases.
// The claim's bill posted it as ONE 254.65 line with no TaxType, so Xero took
// ENTERTAINMENT's default — No Tax — and booked the 20.84 as an "adjustment to
// tax" rather than as input tax. Every entertainment receipt on the claim did
// the same.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-claim-lines-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'test-key';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-sun', orgId: 'cybm', name: 'Sunstream Consulting', tenantId: 't-sun', tenantName: 'Sunstream (SG)', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

const ENT = '8619 - ENTERTAINMENT';
const MGH = 'MERIDIAN GROUP HOLDINGS PTE LTD';
const doc = (id: string, extra: Record<string, unknown>) => ({
  id, orgId: 'cybm', displayId: id, fileHash: `h-${id}`, fileName: `${id}.jpg`, supplier: 'Supplier', invoiceNumber: id,
  documentType: 'Receipt', currency: 'SGD', date: '2026-09-18', category: ENT, taxRate: 'Standard-Rated Purchases',
  createdBy: 'jenny@sun.sg', owner: 'jenny@sun.sg', status: 'expenseclaim', kind: 'cost', createdAt: new Date(0).toISOString(), ...extra,
});
const linkusLines = [
  { description: 'Supply taxed at 9%', category: ENT, net: '231.56', tax: '20.84', total: '252.40', taxRate: '' },
  { description: 'Part of the bill outside GST', category: ENT, net: '23.09', tax: '0', total: '23.09', taxRate: 'No Tax' },
];
writeFileSync(
  join(DATA_DIR, 'bills.json'),
  JSON.stringify({
    bills: [
      doc('260919183938', { supplier: 'LINKUS', total: 275.49, tax: 20.84, lineItems: linkusLines, customer: MGH, rebillable: true }),
      doc('260923110349', { supplier: 'ROYAL CHINA', total: 155.39, tax: 17.82 }),
      doc('260920124457', { supplier: 'Trip.com', total: 1032.6, tax: 0, taxRate: 'No Tax', category: '8616 - TRAVELLING - AIR TICKETS' }),
      // Rows that do NOT add up to the document: posted as one line, never refused.
      doc('260914202712', {
        supplier: 'CHUI HUAY LIM', total: 209.71, tax: 17.32,
        lineItems: [{ description: 'Food', category: ENT, net: '100', tax: '9', total: '109', taxRate: '' }],
      }),
    ],
  })
);

const txn = (itemId: string, supplier: string, category: string, total: string, tax: string) => ({
  itemId, date: '2026-09-18', supplier, category, description: 'meal', net: String(Number(total) - Number(tax)), tax, total,
});
writeFileSync(
  join(DATA_DIR, 'claims.json'),
  JSON.stringify({
    items: [{
      id: 'claim-1', workspaceId: 'cybm', orgId: 'cybm', claimFor: 'Jenny Lye', type: 'Regular',
      name: 'Auto claim', claimDate: '2026-09-30', endDate: '2026-09-30', currency: 'SGD',
      transactions: [
        txn('260919183938', 'LINKUS', ENT, '275.49', '20.84'),
        txn('260923110349', 'ROYAL CHINA', ENT, '155.39', '17.82'),
        txn('260920124457', 'Trip.com', '8616 - TRAVELLING - AIR TICKETS', '1032.60', '0'),
        txn('260914202712', 'CHUI HUAY LIM', ENT, '209.71', '17.32'),
      ],
      history: [], approvalStatus: 'approved', approver: '', approverEmail: '', decidedBy: '', decidedAt: '',
      archived: false, deleted: false, createdBy: '', createdAt: new Date(0).toISOString(),
      hrSentAt: '', hrSentAmount: '', hrSentBy: '', hrRevision: 0,
    }],
  })
);

// --- stub relay --------------------------------------------------------------
let posted: any = null;
let linked: Array<Record<string, string>> = [];
const stub = http.createServer((req, res) => {
  const path = decodeURIComponent(new URL(String(req.url), 'http://x').pathname);
  res.setHeader('content-type', 'application/json');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (path.endsWith('/TrackingCategories')) return res.end(JSON.stringify({ TrackingCategories: [] }));
    if (path.endsWith('/TaxRates')) {
      return res.end(JSON.stringify({ TaxRates: [
        { Name: 'Standard-Rated Purchases', TaxType: 'INPUTY24', Status: 'ACTIVE', EffectiveRate: 9 },
        { Name: 'No Tax', TaxType: 'NONE', Status: 'ACTIVE', EffectiveRate: 0 },
      ] }));
    }
    if (path.endsWith('/Accounts')) {
      return res.end(JSON.stringify({ Accounts: [
        { Code: '8619', Name: 'ENTERTAINMENT', Status: 'ACTIVE', TaxType: 'NONE' },
        { Code: '8616', Name: 'TRAVELLING - AIR TICKETS', Status: 'ACTIVE', TaxType: 'NONE' },
      ] }));
    }
    if (path.endsWith('/Contacts')) return res.end(JSON.stringify({ Contacts: [{ ContactID: 'contact-mgh', Name: MGH }] }));
    if (path.endsWith('/LinkedTransactions')) {
      linked.push(JSON.parse(body || '{}'));
      return res.end(JSON.stringify({ LinkedTransactions: [{ LinkedTransactionID: `lt-${linked.length}` }] }));
    }
    if (path.endsWith('/Invoices')) {
      const inv = JSON.parse(body || '{}').Invoices?.[0] ?? {};
      posted = inv;
      const LineItems = (inv.LineItems ?? []).map((l: any, i: number) => ({ ...l, LineItemID: `li-${i + 1}` }));
      return res.end(JSON.stringify({ Invoices: [{ InvoiceID: 'inv-claim', InvoiceNumber: 'BILL-1', Status: 'DRAFT', HasErrors: false, LineItems }] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found', path }));
  });
});
await new Promise<void>((r) => stub.listen(4743, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4743';

const express = (await import('express')).default;
const { xeroRouter } = await import('../src/xero.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/xero', xeroRouter);
const server = app.listen(4744, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const res = await fetch('http://127.0.0.1:4744/api/xero/organisations/org-sun/publish-claim', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ claimId: 'claim-1', status: 'DRAFT' }),
});
const body = await res.json();
check('the claim publishes', res.status, 200);

const lines: any[] = posted?.LineItems ?? [];
const shape = (l: any) => [l.UnitAmount, l.TaxAmount, l.TaxType ?? '', l.AccountCode];
check('LINKUS posts as its own two lines, then one line per other receipt', lines.length, 5);
check('…the 9% row under Standard-Rated, carrying the GST', shape(lines[0]), [231.56, 20.84, 'INPUTY24', '8619']);
check('…the row outside GST under No Tax', shape(lines[1]), [23.09, 0, 'NONE', '8619']);
check('…each line names the receipt, then the row', [
  /LINKUS #260919183938/.test(lines[0]?.Description) && /Supply taxed at 9%/.test(lines[0]?.Description),
  /LINKUS #260919183938/.test(lines[1]?.Description) && /outside GST/.test(lines[1]?.Description),
], [true, true]);
check('a receipt with no line items keeps its own tax code, not the account default', shape(lines[2]), [137.57, 17.82, 'INPUTY24', '8619']);
check('a No Tax receipt says so', shape(lines[3]), [1032.6, 0, 'NONE', '8616']);
check('rows that do not reconcile post as one line', shape(lines[4]), [192.39, 17.32, 'INPUTY24', '8619']);
const sum = (k: string) => Math.round(lines.reduce((a, l) => a + Number(l[k]) * 100, 0));
check('the bill is worth exactly what the claim is', (sum('UnitAmount') + sum('TaxAmount')) / 100, 275.49 + 155.39 + 1032.6 + 209.71);
check('a rebillable receipt posted as two lines is billed back on both', linked.map((l) => l.SourceLineItemID), ['li-1', 'li-2']);
check('…and reported', [body.rebilled?.ok, body.rebilled?.linked], [true, 2]);

server.close();
stub.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
