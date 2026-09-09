// "Publishing permissions" in Edit privileges, which was stored and never read.
//
// The dialog offers a Standard user two radio buttons — "Can't publish to
// accounting software" and "Can publish items and expense claims" — and the
// answer was written onto the roster row and consulted by nobody: every publish
// button worked, and so did every route behind them. A permission dialog that
// lies about what somebody can do is worse than not offering the choice.
//
// Guarded on the four session routes that write to a live ledger: publishing a
// bill or a claim, and UPDATING either, since an update restates money that is
// already there. Deliberately NOT inside postBillToXero, which the cyworkspace
// payables hand-off shares — that road proves itself with the inbound key and
// has no roster row at all, so a check down there would refuse a payment run.
//
// What is asserted is the GUARD, not the publish: a caller who gets past it
// falls through to the route's own complaint about a missing billId, which is
// all this needs to know.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-publish-priv-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha Cybersecurity Pte. Ltd.', tenantId: 't-red', tenantName: 'Red Alpha', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

// A relay that answers nothing useful. Nothing here should reach it: a refused
// caller stops at the guard, and an allowed one stops at the missing billId.
const stub = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ Invoices: [] }));
});
await new Promise<void>((r) => stub.listen(4659, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4659';
process.env.CYWORKSPACE_API_KEY = 'test-key';

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const jwt = (await import('jsonwebtoken')).default;
const { xeroRouter } = await import('../src/xero.ts');
const { ensure, save, canPublishToXero } = await import('../src/users.ts');

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
  employee('emp_no', 'Nora NoPublish', 'nora@redalphacyber.com', 'Standard', { canPublish: false }),
  employee('emp_yes', 'Percy Publisher', 'percy@redalphacyber.com', 'Standard', { canPublish: true }),
  // Never asked. The toggles are not even offered for an admin, so a stale
  // `false` left over from before somebody was promoted must not lock them out
  // of the ledger they run.
  employee('emp_boss', 'Bee Admin', 'boss@redalphacyber.com', 'Business Admin', { canPublish: false }),
  employee('emp_uma', 'Uma Admin', 'uma@redalphacyber.com', 'User Admin', { canPublish: false })
);
save(items);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use('/api/xero', xeroRouter);
const server = app.listen(4660, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const as = (email: string, name: string) =>
  `cyb_session=${jwt.sign({ sub: email, email, name }, 'test-session-secret', { expiresIn: '1h' })}`;
const post = async (route: string, cookie: string) => {
  const res = await fetch(`http://127.0.0.1:4660/api/xero/organisations/${RED}/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': RED, Cookie: cookie },
    body: JSON.stringify({}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

const ROUTES = ['publish-bill', 'update-bill', 'publish-claim', 'update-claim'];
const NORA = as('nora@redalphacyber.com', 'Nora NoPublish');

// --- Refused, on every road into the ledger ----------------------------------
for (const route of ROUTES) {
  const r = await post(route, NORA);
  check(`${route} is refused`, r.status, 403);
  check(`${route} says why`, r.body.error, 'publish_not_allowed');
}

// --- And allowed for everyone who may ----------------------------------------
// Past the guard, so the route gets as far as complaining about the body.
for (const [who, cookie] of [
  ['a Standard user who may publish', as('percy@redalphacyber.com', 'Percy Publisher')],
  ['a Business Admin', as('boss@redalphacyber.com', 'Bee Admin')],
  ['a User Admin', as('uma@redalphacyber.com', 'Uma Admin')],
] as const) {
  const r = await post('publish-bill', cookie);
  check(`${who} gets past the guard`, r.body.error === 'publish_not_allowed', false);
  check(`${who} reaches the route itself`, r.status, 400);
}

// The predicate on its own, which is where the "only a Standard user is asked"
// rule lives — the reason a stale false on an admin row is harmless.
const rowFor = (email: string) => ensure('cybm').find((u) => u.email === email)!;
check('a Standard user is asked', canPublishToXero(rowFor('nora@redalphacyber.com'), RED), false);
check('and answered when they may', canPublishToXero(rowFor('percy@redalphacyber.com'), RED), true);
check('an admin is never asked', canPublishToXero(rowFor('boss@redalphacyber.com'), RED), true);
check('nor a User Admin', canPublishToXero(rowFor('uma@redalphacyber.com'), RED), true);
// The sessionless mock/dev context stays open, as everywhere else in the app.
check('and nobody at all is not refused', canPublishToXero(null, RED), true);

console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
await finish(failures, server, stub);
