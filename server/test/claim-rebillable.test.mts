// A receipt marked Rebillable that reaches Xero as a LINE OF AN EXPENSE CLAIM is
// marked billable to its customer, just as it would be published on its own.
//
// The case that showed it: Jenny Lye's claim carried a Tiong Bahru receipt
// coded to recoverable expenses, Customer MERIDIAN GROUP HOLDINGS, Rebillable
// Yes — and the claim's bill landed in Xero with no line assigned to anybody,
// because only publish-bill ever made the link.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-claim-rebill-'));
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

const MGH = 'MERIDIAN GROUP HOLDINGS PTE LTD';
const doc = (id: string, extra: Record<string, unknown>) => ({
  id, orgId: 'cybm', displayId: id, fileHash: `h-${id}`, fileName: `${id}.jpg`, supplier: 'Supplier', invoiceNumber: id,
  documentType: 'Receipt', currency: 'SGD', total: 100, tax: 0, date: '2026-09-23', category: '1354 - RECOVERABLE EXPENSES - PREPAYMENT',
  createdBy: 'jenny@sun.sg', owner: 'jenny@sun.sg', status: 'expenseclaim', kind: 'cost', createdAt: new Date(0).toISOString(), ...extra,
});
writeFileSync(
  join(DATA_DIR, 'bills.json'),
  JSON.stringify({
    bills: [
      doc('260929211213', { customer: MGH, rebillable: true }),
      doc('260914112218', {}),
      doc('260915000001', { customer: MGH, rebillable: false }), // a customer, but not billed back
    ],
  })
);

const claim = (id: string, itemIds: string[]) => ({
  id, workspaceId: 'cybm', orgId: 'cybm', claimFor: 'Jenny Lye', type: 'Regular',
  name: 'Jenny Lye MGH', claimDate: '2026-09-30', endDate: '2026-09-30', currency: 'SGD',
  transactions: itemIds.map((itemId) => ({
    itemId, date: '2026-09-23', supplier: 'Supplier', category: '1354 - RECOVERABLE EXPENSES - PREPAYMENT', description: 'x', net: '100', tax: '0', total: '100',
  })),
  history: [], approvalStatus: 'approved', approver: '', approverEmail: '', decidedBy: '', decidedAt: '',
  archived: false, deleted: false, createdBy: '', createdAt: new Date(0).toISOString(),
  hrSentAt: '', hrSentAmount: '', hrSentBy: '', hrRevision: 0,
});
writeFileSync(
  join(DATA_DIR, 'claims.json'),
  JSON.stringify({ items: [claim('claim-1', ['260929211213', '260914112218', '260915000001']), claim('claim-2', ['260914112218'])] })
);

// --- stub relay --------------------------------------------------------------
let linked: Array<Record<string, string>> = [];
let contactLookups = 0;
let missingCustomer = false;
const stub = http.createServer((req, res) => {
  const url = new URL(String(req.url), 'http://x');
  const path = decodeURIComponent(url.pathname);
  res.setHeader('content-type', 'application/json');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (path.endsWith('/TrackingCategories')) return res.end(JSON.stringify({ TrackingCategories: [] }));
    if (path.endsWith('/Contacts')) {
      contactLookups += 1;
      return res.end(JSON.stringify({ Contacts: missingCustomer ? [] : [{ ContactID: 'contact-mgh', Name: MGH }] }));
    }
    if (path.endsWith('/LinkedTransactions')) {
      linked.push(JSON.parse(body || '{}'));
      return res.end(JSON.stringify({ LinkedTransactions: [{ LinkedTransactionID: `lt-${linked.length}` }] }));
    }
    if (path.endsWith('/Invoices')) {
      const inv = JSON.parse(body || '{}').Invoices?.[0] ?? {};
      // Xero hands the lines back in the order they were sent, with new ids.
      const stamp = req.method === 'POST' ? 'u' : 'p';
      const LineItems = (inv.LineItems ?? []).map((l: any, i: number) => ({ ...l, LineItemID: `${stamp}-li-${i + 1}` }));
      return res.end(JSON.stringify({ Invoices: [{ InvoiceID: inv.InvoiceID || 'inv-claim', InvoiceNumber: 'BILL-1', Status: 'DRAFT', HasErrors: false, LineItems }] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found', path }));
  });
});
await new Promise<void>((r) => stub.listen(4622, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4622';

const express = (await import('express')).default;
const { xeroRouter } = await import('../src/xero.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/xero', xeroRouter);
const server = app.listen(4623, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const call = async (route: string, claimId: string) => {
  linked = [];
  contactLookups = 0;
  const res = await fetch(`http://127.0.0.1:4623/api/xero/organisations/org-sun/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claimId, status: 'DRAFT' }),
  });
  return { status: res.status, body: await res.json() };
};

// 1) Publish: only the rebillable receipt's line is linked, to its customer.
let r = await call('publish-claim', 'claim-1');
check('the claim publishes', r.status, 200);
check('one link, for the one rebillable receipt', linked.length, 1);
check('…on its own line of the claim bill', linked.map((l) => `${l.SourceTransactionID}/${l.SourceLineItemID}`), ['inv-claim/p-li-1']);
check('…billed to its customer', linked[0]?.ContactID, 'contact-mgh');
check('…reported as done', [r.body.rebilled?.ok, r.body.rebilled?.linked, r.body.rebilled?.asked], [true, 1, 1]);
check('a customer without Rebillable is not linked', linked.some((l) => l.SourceLineItemID === 'p-li-3'), false);

// 2) Update: the lines come back with new ids, so the link is made again.
r = await call('update-claim', 'claim-1');
check('an update links the rebillable line again', linked.map((l) => `${l.SourceTransactionID}/${l.SourceLineItemID}`), ['inv-claim/u-li-1']);

// 3) A claim with nothing rebillable asks Xero nothing about customers.
r = await call('publish-claim', 'claim-2');
check('nothing rebillable: no link', linked.length, 0);
check('…no customer looked up', contactLookups, 0);
check('…nothing to report', r.body.rebilled, null);

// 4) A customer Xero does not hold is reported, never silently skipped.
missingCustomer = true;
r = await call('update-claim', 'claim-1');
check('an unknown customer still lets the bill update', r.status, 200);
check('…reported as not done', [r.body.rebilled?.ok, r.body.rebilled?.linked], [false, 0]);
check('…naming the customer', /MERIDIAN GROUP HOLDINGS/.test(String(r.body.rebilled?.error)), true);

server.close();
stub.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
