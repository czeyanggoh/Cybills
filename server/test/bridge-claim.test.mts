// A bridge entity publishing a claim into its PARENT's Xero.
//
// "Red Alpha - ST Engineering" is not a real company: no Xero of its own, and
// its categories are the plain names off ST Eng's claim form rather than a
// chart of accounts. So publishing has to answer two questions this test pins
// down — whose ledger receives the bill, and what account code a name like
// "Transport - Taxi" becomes. Getting the second one wrong is the dangerous
// half: the old parser read that label as the account code "Transport".
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-bridge-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'test-key';

// Red Alpha is linked to Xero and is the primary entity; the bridge has no
// tenant of its own and names Red Alpha as where its claims post.
writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha Cybersecurity', tenantId: 't-red', tenantName: 'Red Alpha (SG)', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-ste', orgId: 'cybm', name: 'Red Alpha - ST Engineering', tenantId: '', tenantName: '', kind: 'standalone', parentOrgId: 'org-red', createdAt: new Date(1).toISOString(), createdBy: '' },
      // A bridge whose parent was never set (or has since been unlinked).
      { id: 'org-orphan', orgId: 'cybm', name: 'Nowhere Bridge', tenantId: '', tenantName: '', kind: 'standalone', parentOrgId: '', createdAt: new Date(2).toISOString(), createdBy: '' },
    ],
  })
);

const claim = (id: string, orgId = 'org-ste') => ({
  id, workspaceId: 'cybm', orgId, claimFor: 'Wei Ming Tan', type: 'Regular',
  name: 'August claim', claimDate: '2026-08-20', endDate: '2026-08-31', currency: 'SGD',
  transactions: [
    { itemId: '260801120000', date: '2026-08-01', supplier: 'Grab', category: 'Transport - Taxi', description: 'Site visit', net: '24', tax: '0', total: '24' },
    { itemId: '260802120000', date: '2026-08-02', supplier: 'Koufu', category: 'Meal Weekday (after 9pm)', description: 'Late shift', net: '12', tax: '0', total: '12' },
    { itemId: '260803120000', date: '2026-08-03', supplier: 'HDB', category: 'Parking', description: 'Carpark', net: '6', tax: '0', total: '6' },
  ],
  history: [], approvalStatus: 'approved', approver: '', approverEmail: '', decidedBy: '', decidedAt: '',
  archived: false, deleted: false, createdBy: '', createdAt: new Date(0).toISOString(),
  hrSentAt: '', hrSentAmount: '', hrSentBy: '', hrRevision: 0,
});
writeFileSync(join(DATA_DIR, 'claims.json'), JSON.stringify({ items: [claim('claim-1'), claim('claim-2', 'org-orphan')] }));

// Two categories mapped to Red Alpha accounts; "Parking" deliberately left out.
writeFileSync(
  join(DATA_DIR, 'settings.json'),
  JSON.stringify({
    items: [
      {
        workspaceId: 'cybm',
        key: 'cybills.category-accounts.v1::org-ste',
        value: { 'Transport - Taxi': '493', 'Meal Weekday (after 9pm)': '420' },
      },
    ],
  })
);

// --- stub relay --------------------------------------------------------------
let posted: any = null;
let postedTenant = '';
const stub = http.createServer((req, res) => {
  const url = new URL(String(req.url), 'http://x');
  const path = decodeURIComponent(url.pathname);
  res.setHeader('content-type', 'application/json');
  if (path.endsWith('/TrackingCategories')) {
    res.end(JSON.stringify({ TrackingCategories: [] }));
    return;
  }
  if (path.endsWith('/Invoices')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      posted = JSON.parse(body || '{}').Invoices?.[0] ?? null;
      postedTenant = url.searchParams.get('tenant_id') || '';
      res.end(JSON.stringify({ Invoices: [{ InvoiceID: 'inv-9', InvoiceNumber: 'BILL-9', Status: 'DRAFT', HasErrors: false }] }));
    });
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not_found', path }));
});
await new Promise<void>((r) => stub.listen(4612, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4612';

const express = (await import('express')).default;
const { xeroRouter } = await import('../src/xero.ts');
const { readSetting } = await import('../src/settings.ts');
const { loadCollection, saveCollection } = await import('../src/jsonStore.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/xero', xeroRouter);
const server = app.listen(4613, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const publish = async (orgId: string, claimId: string) => {
  posted = null;
  postedTenant = '';
  const res = await fetch(`http://127.0.0.1:4613/api/xero/organisations/${orgId}/publish-claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claimId, status: 'DRAFT' }),
  });
  return { status: res.status, body: await res.json(), posted, postedTenant };
};

// 1) One category unmapped -> nothing is posted, and it says which.
let r = await publish('org-ste', 'claim-1');
check('an unmapped category refuses the claim', r.status, 422);
check('…nothing reached Xero', r.posted, null);
check('…and it names the category to map', r.body.categories, ['Parking']);
check('…pointing at the parent entity by name', /Red Alpha - ST Engineering|Red Alpha Cybersecurity/.test(String(r.body.message)), true);

// A plain name must never be read as an account code. "Transport" would be
// accepted by Xero as a code that doesn't exist there.
check('…and the refusal is about mapping, not "coded categories"', /Lists → Categories/.test(String(r.body.message)), true);

// 2) Map the last one -> the claim posts, into RED ALPHA's tenant.
const items = loadCollection<{ workspaceId: string; key: string; value: any }>('settings');
const rec = items.find((s) => s.key === 'cybills.category-accounts.v1::org-ste')!;
rec.value = { ...rec.value, Parking: '449' };
saveCollection('settings', items);
check('the mapping is stored for the bridge entity', Object.keys(readSetting<Record<string, string>>('cybm', 'cybills.category-accounts.v1', 'org-ste') || {}).length, 3);

r = await publish('org-ste', 'claim-1');
check('a fully mapped claim publishes', r.status, 200);
check('…into the PARENT\'s Xero tenant', r.postedTenant, 't-red');
check('…as three lines', r.posted.LineItems.length, 3);
check('…each on the account its category maps to', r.posted.LineItems.map((l: any) => l.AccountCode), ['493', '420', '449']);
check('…for the money the claim is worth', r.posted.LineItems.reduce((t: number, l: any) => t + l.UnitAmount + l.TaxAmount, 0), 42);
check('…payable to the claimant', r.posted.Contact.Name, 'Wei Ming Tan');
check('the claim records the parent as where it went', r.body.claim.xeroTenantName, 'Red Alpha (SG)');

// 3) Publishing the same claim again is still refused.
r = await publish('org-ste', 'claim-1');
check('re-publishing is refused', [r.status, r.body.error], [409, 'already_posted']);

// 4) A bridge with nowhere to post says so, rather than half-posting.
r = await publish('org-orphan', 'claim-2');
check('a bridge with no parent is refused', [r.status, r.body.error], [409, 'no_publish_target']);
check('…nothing reached Xero', r.posted, null);

server.close();
stub.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
