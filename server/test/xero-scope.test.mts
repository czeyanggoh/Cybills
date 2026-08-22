// Which entity's book a Xero route reads from. The organisation RECORD is
// workspace-level; the bills and claims it owns are not. These routes name the
// organisation in their path and are called without an X-Org-Id header, so the
// book has to come from the path — otherwise every entity but the primary one
// resolves to the primary book and its own documents are "not found".
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-xeroscope-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'test-key';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha Cybersecurity', tenantId: 't-red', tenantName: 'Red Alpha', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

let postedTo = '';
const stub = http.createServer((req, res) => {
  const url = new URL(String(req.url), 'http://x');
  const path = decodeURIComponent(url.pathname);
  res.setHeader('content-type', 'application/json');
  if (path.endsWith('/Accounts')) return void res.end(JSON.stringify({ Accounts: [{ Code: '429', Name: 'General Expenses', Status: 'ACTIVE', Type: 'EXPENSE' }] }));
  if (path.endsWith('/TrackingCategories')) return void res.end(JSON.stringify({ TrackingCategories: [] }));
  if (path.endsWith('/Invoices')) {
    postedTo = url.searchParams.get('tenant_id') || '';
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => res.end(JSON.stringify({ Invoices: [{ InvoiceID: 'inv-1', InvoiceNumber: 'BILL-1', Status: 'DRAFT', HasErrors: false }] })));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not_found', path }));
});
await new Promise<void>((r) => stub.listen(4606, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4606';

const express = (await import('express')).default;
const { xeroRouter } = await import('../src/xero.ts');
const { insertBill } = await import('../src/store.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/xero', xeroRouter);
const server = app.listen(4607, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const bill = (orgId: string, supplier: string) =>
  insertBill({
    orgId, kind: 'cost', status: 'ready', supplier, invoiceNumber: 'INV-1', documentType: 'Invoice',
    currency: 'SGD', date: '2026-07-31', category: '429 - General Expenses', description: supplier,
    total: '100', tax: '0',
  } as any);

const cybmBill = bill('cybm', 'Singtel');
const redBill = bill('org-red', 'AWS');

const publish = async (orgPath: string, billId: string) => {
  postedTo = '';
  const res = await fetch(`http://127.0.0.1:4607/api/xero/organisations/${orgPath}/publish-bill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ billId, accountCode: '429', taxType: 'NONE', status: 'DRAFT' }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})), postedTo };
};

// The primary entity keeps working (its book is the legacy scope).
let r = await publish('org-cybm', cybmBill.id);
check('primary entity publishes', r.status, 200);
check('and posts into its own Xero tenant', r.postedTo, 't-cybm');

// A non-primary entity can publish its own bill — this used to 404, because the
// book was read from an X-Org-Id header the client never sent.
r = await publish('org-red', redBill.id);
check('a second entity publishes its own bill', r.status, 200);
check('and posts into that entity’s tenant', r.postedTo, 't-red');

// A bill can't be published through another entity's organisation.
r = await publish('org-cybm', redBill.id);
check('another entity’s bill is not found', [r.status, r.body.error], [404, 'bill_not_found']);

// An unknown organisation is still a 404, not a crash.
r = await publish('org-nope', cybmBill.id);
check('unknown organisation', [r.status, r.body.error], [404, 'organisation_not_found']);

server.close();
stub.close();
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
