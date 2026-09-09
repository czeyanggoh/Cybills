// A claim covers a month, and for a STANDARD user it covers the month it was
// raised in.
//
// The end date was a free date picker on every road, so somebody claiming on
// the 27th could close their claim on any date at all — and a claim whose
// period no reporting month covers is one nobody can reconcile against a month.
// It is now filled in and locked for a Standard user, and still chosen by an
// admin, because a claim that genuinely closes on another date is a real thing
// and somebody has to be able to say so.
//
// Driven over real HTTP: the rule reads the caller's role out of their session,
// which a test mounting the handler by hand would never have.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-claim-end-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';
// Fixed so "which month" is the practice's answer rather than the machine's.
process.env.PRACTICE_TIMEZONE = 'Asia/Singapore';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha Cybersecurity Pte. Ltd.', tenantId: 't-red', tenantName: 'Red Alpha', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const jwt = (await import('jsonwebtoken')).default;
const { claimsRouter } = await import('../src/claims.ts');
const { ensure, save } = await import('../src/users.ts');
const { practiceDayKey } = await import('../src/usage.ts');
const { endOfMonthFor } = await import('../../src/lib/claimDate.js');

const RED = 'org-red';

const items = ensure('cybm');
const seed = items.find((u) => u.practice)!;
const employee = (id: string, name: string, email: string, role: string) =>
  ({
    ...seed, id, name, email, role, practice: false, practiceRole: 'Standard', general: false,
    allClients: false, clientAccess: [], extraAccess: [], organisationId: RED,
    deactivated: false, pending: false, removed: false, managerId: '',
    // Raising a claim at all is its own privilege ("Create expense claims").
    // Granted here so this test is about the DATE and nothing else.
    privileges: { createClaims: true },
  }) as never;
items.unshift(
  employee('emp_astrid', 'Astrid Test', 'astrid@redalphacyber.com', 'Standard'),
  employee('emp_boss', 'Bee Admin', 'boss@redalphacyber.com', 'Business Admin'),
  employee('emp_useradmin', 'Uma Admin', 'uma@redalphacyber.com', 'User Admin')
);
save(items);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use('/api/claims', claimsRouter);
const server = app.listen(4658, '127.0.0.1');
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
  const res = await fetch(`http://127.0.0.1:4658/api/claims${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': RED, Cookie: cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

const ASTRID = as('astrid@redalphacyber.com', 'Astrid Test');
const BOSS = as('boss@redalphacyber.com', 'Bee Admin');
const UMA = as('uma@redalphacyber.com', 'Uma Admin');

// The month we are actually in, in the practice's clock — the same question the
// server asks, so this test does not go stale on the 1st.
const THIS_MONTH_END = endOfMonthFor(practiceDayKey(new Date()));

// --- A Standard user gets the month end, whatever they ask for ---------------
let r = await post('/', ASTRID, { claimFor: 'Astrid Test', name: 'Sep claim', endDate: '2026-01-15' });
check('a Standard user can still raise a claim', r.status, 200);
check('and it closes at the end of this month', r.body.claim?.endDate, THIS_MONTH_END);
check('the date they asked for is ignored', r.body.claim?.endDate === '2026-01-15', false);
check('claimDate follows it, as it always has', r.body.claim?.claimDate, THIS_MONTH_END);
const astridClaim = r.body.claim.id;

// Sending nothing at all is the ordinary case once the field is read-only.
r = await post('/', ASTRID, { claimFor: 'Astrid Test', name: 'No date sent' });
check('and it is filled in when nothing is sent', r.body.claim?.endDate, THIS_MONTH_END);

// --- And cannot move it ------------------------------------------------------
r = await post(`/${astridClaim}/update`, ASTRID, { endDate: '2026-01-15' });
check('they cannot move it', r.status, 403);
check('and are told why', r.body.error, 'end_date_fixed');

r = await post(`/${astridClaim}/update`, ASTRID, { name: 'Renamed' });
check('renaming the claim still works', r.status, 200);
check('and the name took', r.body.claim?.name, 'Renamed');

// A resend of the date it already carries is not a change. The detail page
// sends canonical ISO, and a stored date typed in another shape must not read
// as somebody moving it.
r = await post(`/${astridClaim}/update`, ASTRID, { endDate: THIS_MONTH_END });
check('resending the same date is not a change', r.status, 200);
check('and the date is where it was', r.body.claim?.endDate, THIS_MONTH_END);

// --- An admin still chooses --------------------------------------------------
r = await post('/', BOSS, { claimFor: 'Bee Admin', name: 'Admin claim', endDate: '2026-01-15' });
check('an admin keeps the date they picked', r.body.claim?.endDate, '2026-01-15');
const bossClaim = r.body.claim.id;

r = await post(`/${bossClaim}/update`, BOSS, { endDate: '2026-02-20' });
check('and can move it afterwards', r.status, 200);
check('to the date they chose', r.body.claim?.endDate, '2026-02-20');

// The fix for a claim locked to the wrong month is an admin, so they have to be
// able to reach a Standard user's claim.
r = await post(`/${astridClaim}/update`, BOSS, { endDate: '2026-03-31' });
check("an admin can move a Standard user's claim", r.status, 200);
check('to the date they chose', r.body.claim?.endDate, '2026-03-31');

// A User Admin manages everybody's documents by role, so the coarse question
// here is whether somebody is a Standard user, not whether they run settings.
r = await post('/', UMA, { claimFor: 'Uma Admin', name: 'User Admin claim', endDate: '2026-01-15' });
check('a User Admin is not a Standard user', r.body.claim?.endDate, '2026-01-15');

server.close();
console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exit(failures ? 1 : 0);
