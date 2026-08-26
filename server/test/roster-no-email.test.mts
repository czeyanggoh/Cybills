// Somebody on the roster who will never sign in.
//
// A bridge entity's people — ST Engineering staff claiming through
// "Red Alpha - ST Engineering" — have no CYBills login and often no work
// address the practice knows. The roster always allowed a blank email; what it
// did NOT do was let such a person own anything, because a document's owner is
// an email and the directory skips anyone without one. They existed and could
// be handed nothing. This covers the identity they get instead, and the claim
// that can no longer be made out to the general account.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-roster-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-secret'; // so a forged sign-in reads back

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha Cybersecurity', tenantId: 't-red', tenantName: 'Red Alpha', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-ste', orgId: 'cybm', name: 'Red Alpha - ST Engineering', tenantId: '', tenantName: '', kind: 'standalone', parentOrgId: 'org-red', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const jwt = (await import('jsonwebtoken')).default;
const { usersRouter, peopleForOrg, emailForPerson, ownerForOrg, isInternalAddress, isGeneralPerson } = await import('../src/users.ts');
const { claimsRouter } = await import('../src/claims.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use('/api/users', usersRouter);
app.use('/api/claims', claimsRouter);
const server = app.listen(4614, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const post = async (path: string, body: unknown, org = 'org-ste') => {
  const res = await fetch(`http://127.0.0.1:4614${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': org },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
};

// --- A person with no email -------------------------------------------------
let r = await post('/api/users', { firstName: 'Wei Ming', lastName: 'Tan', login: 'No', notify: false });
const person = r.body.users[0];
check('the person is created', r.status, 200);
check('…with no email to show', person.email, '');
check('…and no login, because there is no address to sign in with', person.login, 'No');

// The identity is internal: it exists so documents can name them, and points at
// a domain that doesn't resolve, so nothing is ever sent to it.
const people = peopleForOrg('cybm', 'org-ste');
const wm = people.find((p) => p.name === 'Wei Ming Tan');
check('the directory knows them', Boolean(wm), true);
check('…by an internal address', isInternalAddress(wm?.email || ''), true);
check('…which is not the general account', wm?.general, false);
check('…and is offered as an owner (not an outsider)', wm?.external, false);

// Which is the point: a document can now be made out to them, by name.
check('their name resolves to their identity', emailForPerson('cybm', 'org-ste', 'Wei Ming Tan'), wm?.email);
check('naming them makes them the owner', ownerForOrg('cybm', 'org-ste', 'Wei Ming Tan', ''), wm?.email);

// A second login-less person gets an identity of their own.
r = await post('/api/users', { firstName: 'Siti', lastName: 'Rahman', login: 'No', notify: false });
const siti = peopleForOrg('cybm', 'org-ste').find((p) => p.name === 'Siti Rahman');
check('a second person is their own person', Boolean(siti), true);
check('…with their own identity', siti?.email === wm?.email, false);

// A real address is left exactly as given.
r = await post('/api/users', { firstName: 'Real', lastName: 'Person', email: 'real@ste.com.sg', login: 'Yes', notify: false });
check('a real address is kept', r.body.users[0].email, 'real@ste.com.sg');

// --- A claim has to be made out to somebody ---------------------------------
check('the general account is not a person', isGeneralPerson('cybm', 'org-ste', 'General'), true);
check('…but Wei Ming Tan is', isGeneralPerson('cybm', 'org-ste', 'Wei Ming Tan'), false);

const claim = await post('/api/claims', { claimFor: 'General', name: 'August' });
r = await post(`/api/claims/${claim.body.claim.id}/submit`, {});
check('a claim made out to the general account is refused', [r.status, r.body.error], [422, 'claim_for_general']);
check('…and says what to do about it', /Claim for/.test(String(r.body.message)), true);

// --- The day they sign in ---------------------------------------------------
// The admin typed their name and role. Asking for both again on the join form
// is how the same human ends up on the roster twice, with the documents stuck
// on the first row — so they pick themselves instead, and the row is theirs.
const { insertBill, listBills } = await import('../src/store.ts');
const bill = insertBill({
  orgId: 'org-ste', kind: 'cost', status: 'ready', supplier: 'Grab', documentType: 'Receipt',
  currency: 'SGD', date: '2026-08-20', description: 'Site visit', total: '24', tax: '0',
  owner: wm?.email, createdBy: wm?.email,
} as any);

const session = jwt.sign({ email: 'weiming@gmail.com', name: 'wei' }, 'test-secret', { expiresIn: '1h' });
const asWeiMing = async (path: string, body: unknown) => {
  const res = await fetch(`http://127.0.0.1:4614${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `cyb_session=${session}` },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
};

const listRes = await fetch('http://127.0.0.1:4614/api/users/join/people?orgId=org-ste', {
  headers: { Cookie: `cyb_session=${session}` },
});
const offered = (await listRes.json()).people as Array<{ id: string; name: string; role: string }>;
check('the join form offers the people the admin added', offered.map((p) => p.name).includes('Wei Ming Tan'), true);
check('…with the role the admin set', offered.find((p) => p.name === 'Wei Ming Tan')?.role, 'Standard');
check('…and never anybody who has a real address', offered.some((p) => p.name === 'Real Person'), false);

const mine = offered.find((p) => p.name === 'Wei Ming Tan')!;
r = await asWeiMing('/api/users/join', { companyId: 'org-ste', claimId: mine.id, mobile: '82534031' });
check('claiming the row is accepted', [r.status, r.body.status], [200, 'pending']);
check("…keeping the ADMIN's spelling of their name", r.body.user.name, 'Wei Ming Tan');
check('…and the role the admin chose', r.body.user.role, 'Standard');
check('…and it is the same row, not a second one', r.body.user.id, mine.id);
check('…their document comes with them', listBills('org-ste').find((b) => b.id === bill.id)?.owner, 'weiming@gmail.com');
check('…so nothing is left on the old identity', listBills('org-ste').some((b) => b.owner === wm?.email), false);

const after = await (await fetch('http://127.0.0.1:4614/api/users/join/people?orgId=org-ste', {
  headers: { Cookie: `cyb_session=${session}` },
})).json();
check('…and they are no longer waiting to be claimed', after.people.some((p: any) => p.name === 'Wei Ming Tan'), false);

server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
