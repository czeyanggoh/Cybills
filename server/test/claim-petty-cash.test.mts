// A published expense claim marks the claimant's Xero contact "PCP" in Business
// registration number, BEFORE the bill is sent, so Xero reports it to IRAS (GST
// InvoiceNow) as a petty cash purchase. A number already there is left alone, and
// a contact Xero will not take never stops the claim being published.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-claim-pcp-'));
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
writeFileSync(
  join(DATA_DIR, 'bills.json'),
  JSON.stringify({
    bills: [
      {
        id: '260914112218', orgId: 'cybm', displayId: '260914112218', fileHash: 'h-1', fileName: '1.jpg', supplier: 'Supplier', invoiceNumber: '1',
        documentType: 'Receipt', currency: 'SGD', total: 100, tax: 0, date: '2026-09-23', category: '420 - Entertainment', taxRate: 'No Tax',
        createdBy: 'jenny@sun.sg', owner: 'jenny@sun.sg', status: 'expenseclaim', kind: 'cost', createdAt: new Date(0).toISOString(),
      },
    ],
  })
);
writeFileSync(
  join(DATA_DIR, 'claims.json'),
  JSON.stringify({
    items: [
      {
        id: 'claim-1', workspaceId: 'cybm', orgId: 'cybm', claimFor: 'Jenny Lye', type: 'Regular',
        name: 'Jenny Lye', claimDate: '2026-09-30', endDate: '2026-09-30', currency: 'SGD',
        transactions: [{ itemId: '260914112218', date: '2026-09-23', supplier: 'Supplier', category: '420 - Entertainment', description: 'x', net: '100', tax: '0', total: '100' }],
        history: [], approvalStatus: 'approved', approver: '', approverEmail: '', decidedBy: '', decidedAt: '',
        archived: false, deleted: false, createdBy: '', createdAt: new Date(0).toISOString(),
        hrSentAt: '', hrSentAmount: '', hrSentBy: '', hrRevision: 0,
      },
    ],
  })
);

// --- stub relay --------------------------------------------------------------
let held: Record<string, string> | null = null; // the claimant's contact in Xero
let refuse = false;
let calls: string[] = [];
let written: any = null;
const stub = http.createServer((req, res) => {
  const url = new URL(String(req.url), 'http://x');
  const path = decodeURIComponent(url.pathname);
  res.setHeader('content-type', 'application/json');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (path.endsWith('/TrackingCategories')) return res.end(JSON.stringify({ TrackingCategories: [] }));
    if (path.endsWith('/Contacts')) {
      if (req.method === 'GET') return res.end(JSON.stringify({ Contacts: held ? [held] : [] }));
      calls.push(`${req.method} Contacts`);
      written = JSON.parse(body || '{}').Contacts?.[0] ?? null;
      if (refuse) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'xero_api_failed', message: 'Xero said no' }));
      }
      return res.end(JSON.stringify({ Contacts: [{ ContactID: written?.ContactID || 'new-contact' }] }));
    }
    if (path.endsWith('/Invoices')) {
      calls.push(`${req.method} Invoices`);
      const inv = JSON.parse(body || '{}').Invoices?.[0] ?? {};
      return res.end(JSON.stringify({ Invoices: [{ InvoiceID: inv.InvoiceID || 'inv-claim', InvoiceNumber: 'BILL-1', Status: 'DRAFT', HasErrors: false, LineItems: inv.LineItems ?? [] }] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found', path }));
  });
});
await new Promise<void>((r) => stub.listen(4641, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4641';

const express = (await import('express')).default;
const { xeroRouter } = await import('../src/xero.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/xero', xeroRouter);
const server = app.listen(4642, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const call = async (route: string) => {
  calls = [];
  written = null;
  const res = await fetch(`http://127.0.0.1:4642/api/xero/organisations/org-sun/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claimId: 'claim-1', status: 'DRAFT', force: true }),
  });
  return { status: res.status, body: await res.json() };
};

// 1) Nobody of that name in Xero yet: the contact is made, marked.
let r = await call('publish-claim');
check('the claim publishes', r.status, 200);
check('the contact is made before the bill', calls, ['PUT Contacts', 'PUT Invoices']);
check('…named for the claimant and marked PCP', written, { Name: 'Jenny Lye', CompanyNumber: 'PCP' });
check('…reported', r.body.pettyCash, { ok: true, set: true });

// 2) A contact with nothing there is marked, nothing else touched.
held = { ContactID: 'c-1', Name: 'Jenny Lye' };
r = await call('update-claim');
check('an existing contact is marked before the bill is updated', calls, ['POST Contacts', 'POST Invoices']);
check('…only that field', written, { ContactID: 'c-1', CompanyNumber: 'PCP' });

// 3) Already marked: nothing written.
held = { ContactID: 'c-1', Name: 'Jenny Lye', CompanyNumber: 'pcp' };
r = await call('update-claim');
check('already PCP: no contact write', calls, ['POST Invoices']);
check('…reported', r.body.pettyCash, { ok: true, set: false });

// 4) A number somebody put there is never replaced, and that is said.
held = { ContactID: 'c-1', Name: 'Jenny Lye', CompanyNumber: '53123456A' };
r = await call('update-claim');
check('another number: left alone', calls, ['POST Invoices']);
check('…said', [r.body.pettyCash?.ok, /53123456A/.test(String(r.body.pettyCash?.error))], [false, true]);

// 5) Xero refusing the contact does not stop the claim.
held = null;
refuse = true;
r = await call('publish-claim');
check('the claim still publishes', r.status, 200);
check('…and the refusal is said', [r.body.pettyCash?.ok, r.body.pettyCash?.error], [false, 'Xero said no']);

server.close();
stub.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
