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
import { finish } from './support.mts';

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
      // Somebody with no claim yet — the case the PO register exists to serve,
      // since a person cannot be assigned to a PO by way of a claim they have
      // not been able to raise.
      { id: 'u-2', workspaceId: 'cybm', name: 'Never Claimed', email: 'never.claimed@stengg.com', login: 'Yes', role: 'Standard', organisationId: 'org-ste', companyId: 'org-ste', companyName: 'Red Alpha - ST Engineering', privileges: {}, clientAccess: [], extraAccess: [], practice: false, general: false, removed: false, pending: false, deactivated: false },
      // Not a person: the row that owns the paperwork nobody claimed.
      { id: 'u-gen', workspaceId: 'cybm', name: 'General', email: 'org_ste.general@cybills.local', login: 'No', role: 'Standard', organisationId: 'org-ste', companyId: 'org-ste', companyName: 'Red Alpha - ST Engineering', privileges: {}, clientAccess: [], extraAccess: [], practice: false, general: true, removed: false, pending: false, deactivated: false },
      // Off the roster entirely.
      { id: 'u-gone', workspaceId: 'cybm', name: 'Long Gone', email: 'long.gone@stengg.com', login: 'No', role: 'Standard', organisationId: 'org-ste', companyId: 'org-ste', companyName: 'Red Alpha - ST Engineering', privileges: {}, clientAccess: [], extraAccess: [], practice: false, general: false, removed: true, pending: false, deactivated: false },
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
      // Red Alpha's OWN staff claim, in the entity that is linked to the tenant
      // in its own right. It reaches the same ledger, so the route lists it —
      // but it is the company's own cost, not somebody else's to be invoiced
      // for, and only `bridge` tells the two apart.
      // `cybm`, not `org-red`: the PRIMARY entity's book is the legacy
      // workspace scope (dataScopeForOrg), which is what its claims are stored
      // against.
      claim('c-own', { id: 'c-own', orgId: 'cybm', claimFor: 'Wei Ming Tan' }),
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
  ['c-approved', 'c-own', 'c-published']
);

// --- whose cost is it -------------------------------------------------------
// Both kinds reach this one ledger and they are NOT the same thing. A bridge
// entity's claims are somebody else's people, to be invoiced on; the tenant's
// own entity's claims are its own staff's cost. Recharging one of those would
// bill a client for a person who never worked for them, so the row has to say
// which it is rather than leaving it to be guessed from an entity name.
check(
  'a bridge entity is marked as one',
  red.body.claims.filter((c: any) => c.bridge).map((c: any) => c.id).sort(),
  ['c-approved', 'c-published']
);
check(
  "and the tenant's OWN entity is not",
  red.body.claims.filter((c: any) => !c.bridge).map((c: any) => c.id),
  ['c-own']
);
check(
  'the organisations say so too, so a caller can narrow before it reads a claim',
  red.body.organisations.map((o: any) => [o.id, o.bridge]).sort(),
  [['org-red', false], ['org-ste', true]]
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

// --- the claim's own PDF, for somebody with no login --------------------------
// The practice sends a client's manager a recharge report whose Claim No links
// to the claim PDF. That person has no CYBills login and never will, so the
// link has to carry its own proof — and the report has to be given one to print.
check('the row carries a signed link to the claim PDF', /\/api\/claims\/c-approved\/pdf\?s=\d+\./.test(row.pdf_url), true);
check('...on the same host as the app', row.pdf_url.startsWith('https://cybills.example.com/'), true);

{
  const url = new URL(row.pdf_url);
  const path = `${url.pathname}${url.search}`;
  const res = await fetch(`${BASE}${path}`);
  check('the signed link opens with no session at all', res.status, 200);
  check('and answers a PDF', res.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await res.arrayBuffer());
  // Rendered, not empty: the module has to have loaded and drawn something.
  check('a real one', [bytes.subarray(0, 5).toString(), bytes.length > 1000], ['%PDF-', true]);

  // The token names ONE claim, so replaying it against another opens nothing —
  // a single leaked link must not open the whole book.
  //
  // 401 rather than 404, and that is the session guard answering BEFORE the
  // route: an unverified token is not a claim-shaped question at all. It leaks
  // less than a 404 would, because a real claim and one that does not exist
  // answer identically — the four below are indistinguishable from outside.
  const swapped = await fetch(`${BASE}/api/claims/c-published/pdf${url.search}`);
  check('a token for one claim does not open another', swapped.status, 401);
  check('nor does a missing token', (await fetch(`${BASE}/api/claims/c-approved/pdf`)).status, 401);
  check('nor a forged one', (await fetch(`${BASE}/api/claims/c-approved/pdf?s=99999999999.nope`)).status, 401);
  check('and an unknown claim answers exactly the same', (await fetch(`${BASE}/api/claims/nope/pdf${url.search}`)).status, 401);
}

// --- the roster --------------------------------------------------------------
// A PO names the PEOPLE it covers, and deriving that from the claims already
// raised would be circular: nobody could go on a PO until they had a claim, and
// no claim could be recharged until somebody was on a PO. So the roster is its
// own question, answerable before there is a single claim.
const noKeyPeople = await get('/api/payments/people?tenant_id=t-red');
check('the roster needs the key too', noKeyPeople.status, 401);

const people = await get('/api/payments/people?tenant_id=t-red', { 'X-API-Key': 'cyws-key' });
check('the roster answers 200', people.status, 200);
check(
  'somebody who has never claimed is still assignable',
  people.body.people.map((p: any) => p.email).sort(),
  ['never.claimed@stengg.com', 'weiming.tan@stengg.com']
);
check('the general account is not a person', people.body.people.some((p: any) => /general/i.test(p.email)), false);
check('nor is somebody off the roster', people.body.people.some((p: any) => /long\.gone/.test(p.email)), false);
check('each says which entity, and whether it is a bridge', people.body.people.map((p: any) => [p.org_id, p.bridge])[0], ['org-ste', true]);
check('another tenant gets its own roster', (await get('/api/payments/people?tenant_id=t-nobody', { 'X-API-Key': 'cyws-key' })).body.people, []);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
await finish(failures);
