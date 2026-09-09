// The RECHARGE hand-off to CYWorkspace: which approved claims are waiting to be
// invoiced on to the client that seconded the people who raised them.
//
// The load-bearing rule is the SCOPE. A bridge entity has no Xero tenant of its
// own — "Red Alpha - ST Engineering" answers `tenantId: ''` — so the payables
// helper, which matches an entity's own link, cannot see it at all. Its claims
// nevertheless reach Red Alpha's ledger, which is exactly where the recharge is
// raised. Ask by PUBLISH TARGET or this route returns an empty list for the one
// entity it exists to serve.
//
// Driven over REAL HTTP against the real server rather than by mounting the
// router, for the reason the payables test gives: the session guard has to let
// a keyed machine caller through, and that guard lives in index.ts.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-recharge-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';
// Sign-in configured, which is what production looks like. Without it the
// server stays open for local development and the allowlist would prove nothing.
process.env.GOOGLE_CLIENT_ID = 'x';
process.env.GOOGLE_CLIENT_SECRET = 'x';
process.env.WHATSAPP_INBOUND_KEY = 'cyws-key';
process.env.APP_ORIGIN = 'https://cybills.example.com';
process.env.PORT = '4652';

// Red Alpha is linked to Xero; the bridge names it as where its claims post. A
// second linked entity on another tenant is here so "wrong tenant" can be shown
// to return nothing rather than merely returning less.
writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha Cybersecurity', tenantId: 't-red', tenantName: 'Red Alpha (SG)', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-ste', orgId: 'cybm', name: 'Red Alpha - ST Engineering', tenantId: '', tenantName: '', kind: 'standalone', parentOrgId: 'org-red', createdAt: new Date(1).toISOString(), createdBy: '' },
      { id: 'org-other', orgId: 'cybm', name: 'Other Co', tenantId: 't-other', tenantName: 'Other Co', createdAt: new Date(2).toISOString(), createdBy: '' },
    ],
  })
);

// The claimant is on the roster, so a claim made out to her NAME resolves back
// to the address a PO assignment is keyed by.
writeFileSync(
  join(DATA_DIR, 'users.json'),
  JSON.stringify({
    items: [
      { id: 'u-1', workspaceId: 'cybm', name: 'Wei Ming Tan', email: 'weiming.tan@stengg.com', login: 'Yes', role: 'Standard', organisationId: 'org-ste', companyId: 'org-ste', companyName: 'Red Alpha - ST Engineering', privileges: {}, clientAccess: [], extraAccess: [], practice: false, general: false, removed: false, pending: false, deactivated: false },
    ],
  })
);

const claim = (id: string, over: Record<string, unknown> = {}) => ({
  id, workspaceId: 'cybm', orgId: 'org-ste', claimFor: 'Wei Ming Tan', type: 'Regular',
  name: 'ST Eng Exp Claim', claimDate: '2026-08-31', endDate: '2026-08-31', currency: 'SGD',
  transactions: [
    { itemId: '260801120000', date: '2026-08-01', supplier: 'Grab', category: 'Transport - Taxi', net: '24', tax: '0', total: '24' },
    { itemId: '260802120000', date: '2026-08-02', supplier: 'Koufu', category: 'Meal Weekday (after 9pm)', net: '12.50', tax: '0', total: '12.50' },
  ],
  history: [], approvalStatus: 'approved', approver: '', approverEmail: '', decidedBy: '',
  decidedAt: '2026-09-01T02:00:00.000Z',
  archived: false, deleted: false, createdBy: 'weiming.tan@stengg.com', createdAt: new Date(Date.UTC(2026, 7, 20, 4, 0, 0)).toISOString(),
  ...over,
});

writeFileSync(
  join(DATA_DIR, 'claims.json'),
  JSON.stringify({
    items: [
      claim('c-approved'),
      // Not yet a cost anybody has agreed to — recharging it would invoice a
      // client for money the practice has not accepted it owes.
      claim('c-open', { id: 'c-open', approvalStatus: '' }),
      claim('c-waiting', { id: 'c-waiting', approvalStatus: 'awaiting_approval' }),
      claim('c-rejected', { id: 'c-rejected', approvalStatus: 'rejected' }),
      // Deleted claims are gone from every road.
      claim('c-deleted', { id: 'c-deleted', deleted: true }),
      // Already published — still listed, because whether its BILL reached Xero
      // is a different question from whether it has been recharged.
      claim('c-published', { id: 'c-published', xeroInvoiceId: 'inv-77', xeroStatus: 'PAID', xeroPaidDate: '2026-09-05' }),
      // Another client's book entirely, on another tenant.
      claim('c-other', { id: 'c-other', orgId: 'org-other', claimFor: 'Someone Else' }),
    ],
  })
);

// The real server, guard and all.
await import('../src/index.ts');
await new Promise((r) => setTimeout(r, 200));

const BASE = 'http://127.0.0.1:4652';

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const get = async (path: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`${BASE}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
};

// --- the key -----------------------------------------------------------------
// Allowlisted past the session guard, and refused without the key. The last
// time a machine route was guarded by mistake it locked out exactly the callers
// it existed for, so this is asserted over the real stack.
const noKey = await get('/api/payments/claims?tenant_id=t-red');
check('no key is refused', noKey.status, 401);
const badKey = await get('/api/payments/claims?tenant_id=t-red', { 'X-API-Key': 'wrong' });
check('a wrong key is refused', badKey.status, 401);

const noTenant = await get('/api/payments/claims', { 'X-API-Key': 'cyws-key' });
check('the tenant must be named', noTenant.body?.error, 'tenant_id_required');

// --- the scope ---------------------------------------------------------------
const red = await get('/api/payments/claims?tenant_id=t-red', { 'X-API-Key': 'cyws-key' });
check('the parent tenant answers 200', red.status, 200);
// THE point of this route: the bridge entity is reached through its parent's
// tenant, which the payables scope rule can never do.
check(
  'the bridge entity is in scope for its parent tenant',
  red.body.organisations.map((o: any) => o.id).sort(),
  ['org-red', 'org-ste']
);
check(
  'only approved, undeleted claims are offered',
  red.body.claims.map((c: any) => c.id).sort(),
  ['c-approved', 'c-published']
);

const row = red.body.claims.find((c: any) => c.id === 'c-approved');
check('the claim is attributed to its entity', row.org_id, 'org-ste');
check('the claimant is named', row.claimant, 'Wei Ming Tan');
// A PO assigns PEOPLE. A claim stores a display NAME, which the roster can
// rename, so the stable identity has to travel with it.
check('the claimant resolves to an address', row.claimant_email, 'weiming.tan@stengg.com');
check('coverage is decided by the period end', row.period_end, '2026-08-31');
check('the total is the sum of its items', row.total, '36.50');
check('the item count travels', row.items, 2);
check('the currency travels', row.currency, 'SGD');
// The same string the ACCPAY bill is named with, so both halves of the loop
// refer to one claim by one name.
check('the reference is the claim reference', row.reference, 'ST Eng Exp Claim 31-Aug-2026 260820120000');
check('the link names the entity to open', row.url, 'https://cybills.example.com/expense-claims/c-approved?org=org-ste');

const published = red.body.claims.find((c: any) => c.id === 'c-published');
check('a published claim carries its bill', published.xero_invoice_id, 'inv-77');
check('and what Xero says of it', [published.xero_status, published.xero_paid_date], ['PAID', '2026-09-05']);
check('an unpublished claim says so with a blank', row.xero_invoice_id, '');

// --- other tenants -----------------------------------------------------------
const other = await get('/api/payments/claims?tenant_id=t-other', { 'X-API-Key': 'cyws-key' });
check('another tenant sees only its own book', other.body.claims.map((c: any) => c.id), ['c-other']);
check('and never the bridge', other.body.organisations.map((o: any) => o.id), ['org-other']);

// A tenant CYBills holds nothing for is not an error: CYWS asks about every
// tenant its user can see, and most are not CYBills clients at all.
const unknown = await get('/api/payments/claims?tenant_id=t-nobody', { 'X-API-Key': 'cyws-key' });
check('an unknown tenant is an empty list, not an error', [unknown.status, unknown.body.claims], [200, []]);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
// Let the loop drain before exiting. Tearing down on top of a live handle
// aborts the process on Windows, which turns a green run into a non-zero exit
// and a failing `npm test` that names nothing.
await new Promise((r) => setTimeout(r, 100));
process.exit(failures ? 1 : 0);
