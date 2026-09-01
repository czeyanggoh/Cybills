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
// What a real deploy sets, and what the "Go to CYBills" button needs: Xero
// refuses an invoice whose Url has a port or an IP host, and every test here
// reaches the server on 127.0.0.1. Without this the link is dropped (as it
// should be) and there is nothing to assert.
process.env.APP_ORIGIN = 'https://cybills.example.com';

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
// Xero shows this as a "Go to CYBills" button on the bill: whoever is reviewing
// the ledger opens the claim it came from — its items, its approvals and the
// receipts behind them — instead of hunting for it.
// …and the link names the entity, because the app opens whichever one this
// browser last had. Without it a claim in the bridge entity was looked for in
// CYBM and reported missing.
check('…linking back to the claim it came from', /\/expense-claims\/claim-1\?org=org-ste$/.test(String(r.posted.Url)), true);

// What the practice has always booked by hand, and what the bill has to match:
// No Tax, at the full amount. A bridge entity has no GST registration, so there
// is no input tax to claim — and the tax the claim recorded is folded into the
// cost rather than dropped, or the bill would be worth less than the claim.
check('…every line is No Tax', r.posted.LineItems.map((l: any) => l.TaxType), ['NONE', 'NONE', 'NONE']);
check('…with no tax amount on any of them', r.posted.LineItems.map((l: any) => l.TaxAmount), [0, 0, 0]);
check('…the unit price being the whole figure', r.posted.LineItems.map((l: any) => l.UnitAmount), [24, 12, 6]);

// The reference identifies WHICH claim. The name alone repeats every month.
// It rides in InvoiceNumber: that is the field a BILL shows as "Reference" in
// Xero, and the `Reference` field is silently ignored on one.
check('…referenced by name, date and Claim ID', /^August claim 20-Aug-2026 \d+$/.test(String(r.posted.InvoiceNumber)), true);
check('…in the field a bill actually shows', r.posted.Reference ?? null, null);
check('the claim records the parent as where it went', r.body.claim.xeroTenantName, 'Red Alpha (SG)');
// Xero's reply says what it MADE the bill, so the Paid status column can say it
// straight away. Left to the webhook it showed a dash — which means "nothing has
// been heard" — beside a claim that plainly was in Xero, and read as the publish
// having failed.
check('…and what Xero made of it', r.body.claim.xeroStatus, 'DRAFT');

// 3) Publishing the same claim again is still refused.
r = await publish('org-ste', 'claim-1');
check('re-publishing is refused', [r.status, r.body.error], [409, 'already_posted']);

// 4) A claim with no date of its own is dated by its own items, not by the day
//    somebody happened to press the button — that put August's expenses in
//    whatever month the claim was published in.
const dateless = {
  ...claim('claim-3'),
  claimDate: '',
  endDate: '',
};
{
  const items = loadCollection<any>('claims');
  items.push(dateless);
  saveCollection('claims', items);
}
r = await publish('org-ste', 'claim-3');
check('a dateless claim publishes', r.status, 200);
check('…dated by its latest item', r.posted.Date, '2026-08-03');
check('…and due the same day', r.posted.DueDate, '2026-08-03');
check('…its reference carrying that date', /03-Aug-2026/.test(String(r.posted.InvoiceNumber)), true);

// 5) A bridge with nowhere to post says so, rather than half-posting.
r = await publish('org-orphan', 'claim-2');
check('a bridge with no parent is refused', [r.status, r.body.error], [409, 'no_publish_target']);
check('…nothing reached Xero', r.posted, null);

// 6) A claim cannot be published into another entity's ledger.
//
// The worry is ordinary and worth pinning: two entities each hold a claim, the
// browser is standing in one of them, and somebody publishes. The route resolves
// BOTH the Xero it posts into and the book it reads the claim from off the
// organisation named in the URL, and the claim lookup requires that entity to
// own it — so naming the wrong one finds no claim rather than posting somebody
// else's money into the wrong company's ledger.
r = await publish('org-red', 'claim-1'); // claim-1 belongs to the bridge, not to Red Alpha
check("another entity's claim is not found", [r.status, r.body.error], [404, 'claim_not_found']);
check('…and nothing reached Xero', r.posted, null);

server.close();
stub.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
