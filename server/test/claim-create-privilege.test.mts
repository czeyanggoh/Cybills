// "Create expense claims" in Edit privileges — the last of the three toggles
// that was written onto the roster row and read by nobody.
//
// It gates BOTH halves of the act: opening a claim and putting items on it. A
// claim is assembled from its items, so refusing only one half would leave
// somebody holding an empty claim they could not fill, or filling one they
// could never have made. Removing and recategorising are deliberately NOT
// gated: taking a receipt back off a claim is undoing, and somebody who should
// not have added it must still be able to take it off.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-claim-priv-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      // Red Alpha is deliberately NOT the primary entity. The primary one is
      // scoped to the legacy workspace id, so a bill inserted under 'org-red'
      // would be foreign to a claim raised in it, and the route would refuse
      // the item for a reason that has nothing to do with privileges.
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha Cybersecurity Pte. Ltd.', tenantId: 't-red', tenantName: 'Red Alpha', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const jwt = (await import('jsonwebtoken')).default;
const { claimsRouter } = await import('../src/claims.ts');
const { insertBill } = await import('../src/store.ts');
const { ensure, save, canCreateClaims } = await import('../src/users.ts');

const RED = 'org-red';
const items = ensure('cybm');
const seed = items.find((u) => u.practice)!;
const employee = (id: string, name: string, email: string, role: string, privileges = {}) =>
  ({
    ...seed, id, name, email, role, practice: false, practiceRole: 'Standard', general: false,
    allClients: false, clientAccess: [], extraAccess: [], organisationId: RED,
    deactivated: false, pending: false, removed: false, managerId: '', privileges,
  }) as never;
items.unshift(
  employee('emp_no', 'Nora NoClaims', 'nora@redalphacyber.com', 'Standard', { createClaims: false }),
  employee('emp_yes', 'Clara Claimant', 'clara@redalphacyber.com', 'Standard', { createClaims: true }),
  // Never asked: the toggles are not offered for an admin, so a stale false
  // left from before somebody was promoted must not stop them.
  employee('emp_boss', 'Bee Admin', 'boss@redalphacyber.com', 'Business Admin', { createClaims: false }),
  employee('emp_uma', 'Uma Admin', 'uma@redalphacyber.com', 'User Admin', { createClaims: false })
);
save(items);

const receipt = (createdBy: string) =>
  insertBill({
    orgId: RED, kind: 'cost', status: 'ready', documentType: 'Receipt', currency: 'SGD',
    supplier: 'Grab', total: '31.99', tax: '0', date: '2026-09-01', createdBy, owner: createdBy,
    category: '4014 - Travel',
  } as any).id;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use('/api/claims', claimsRouter);
const server = app.listen(4661, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const as = (email: string, name: string) =>
  `cyb_session=${jwt.sign({ sub: email, email, name }, 'test-session-secret', { expiresIn: '1h' })}`;
const post = async (path: string, cookie: string, body: unknown = {}) => {
  const res = await fetch(`http://127.0.0.1:4661/api/claims${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': RED, Cookie: cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

const NORA = as('nora@redalphacyber.com', 'Nora NoClaims');
const CLARA = as('clara@redalphacyber.com', 'Clara Claimant');

// --- Refused, on both halves of the act --------------------------------------
let r = await post('/', NORA, { claimFor: 'Nora NoClaims', name: 'Sep', endDate: '2026-09-30' });
check('a Standard user without the privilege cannot raise a claim', r.status, 403);
check('and is told which toggle', r.body.error, 'claims_not_allowed');

// A claim somebody else made, which she must not be able to build either.
r = await post('/', CLARA, { claimFor: 'Clara Claimant', name: 'Sep', endDate: '2026-09-30' });
check('a Standard user with the privilege can', r.status, 200);
const claimId = r.body.claim.id;

r = await post(`/${claimId}/items`, NORA, { items: [{ itemId: receipt('nora@redalphacyber.com'), total: '31.99' }] });
check('nor add items to one somebody else made', r.status, 403);
check('for the same reason', r.body.error, 'claims_not_allowed');

// --- And allowed for everyone who may ----------------------------------------
r = await post(`/${claimId}/items`, CLARA, { items: [{ itemId: receipt('clara@redalphacyber.com'), total: '31.99' }] });
check('the claimant can build their own claim', r.status, 200);
check('and the item is on it', r.body.claim?.transactions?.length, 1);

// Undoing is not creating: taking a receipt back off is left open, so a claim
// somebody should not have been given cannot be made unfixable.
const itemId = r.body.claim.transactions[0].itemId;
r = await post(`/${claimId}/items/remove`, NORA, { itemIds: [itemId] });
check('removing an item is not gated', r.status === 403, false);

for (const [who, cookie] of [
  ['a Business Admin', as('boss@redalphacyber.com', 'Bee Admin')],
  ['a User Admin', as('uma@redalphacyber.com', 'Uma Admin')],
] as const) {
  const made = await post('/', cookie, { claimFor: 'Bee Admin', name: 'Admin claim', endDate: '2026-09-30' });
  check(`${who} raises a claim by role`, made.status, 200);
}

// The predicate on its own, which is where "only a Standard user is asked" lives.
const rowFor = (email: string) => ensure('cybm').find((u) => u.email === email)!;
check('a Standard user is asked', canCreateClaims(rowFor('nora@redalphacyber.com'), RED), false);
check('and answered when they may', canCreateClaims(rowFor('clara@redalphacyber.com'), RED), true);
check('an admin is never asked', canCreateClaims(rowFor('boss@redalphacyber.com'), RED), true);
check('nor a User Admin', canCreateClaims(rowFor('uma@redalphacyber.com'), RED), true);
check('and the sessionless context stays open', canCreateClaims(null, RED), true);

server.close();
console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exit(failures ? 1 : 0);
