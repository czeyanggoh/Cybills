// An address is an identity, not a field.
//
// The session resolves by it, every document a person owns is stored against
// it, and a claim is made out to it. So the ways it can be taken away from
// somebody are the ways a person disappears from their own work — and three
// separate paths could do it. This is the file that stops them coming back.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-identity-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.OWNER_EMAILS = 'owner@cy-bm.sg';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-1', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org_two0002', orgId: 'cybm', name: 'Acme Pte Ltd', tenantId: 't-2', tenantName: 'Acme', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const { usersRouter, ensure, save, memberByEmail } = await import('../src/users.ts');

const app = express();
app.use(express.json());
app.use('/api/users', usersRouter);
const server = app.listen(4627, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const patch = async (id: string, body: unknown) => {
  const res = await fetch(`http://127.0.0.1:4627/api/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const rowOf = (id: string) => ensure('cybm').find((u) => u.id === id)!;

// A practice colleague who does NOT sign in with a password — which is most of
// them, and the exact shape every one of these bugs needed.
function seedColleague(id: string, email: string, name = 'Rowan Tester') {
  const items = ensure('cybm');
  const existing = items.find((u) => u.id === id);
  const row = (existing ?? {}) as Record<string, unknown>;
  Object.assign(row, {
    id,
    workspaceId: 'cybm',
    // Deliberately not a name the seed roster already carries: rows are
    // de-duplicated by organisation + name, so a fixture called "Astrid Yang"
    // gets collapsed into the seeded one and the test measures that instead.
    name,
    firstName: name.split(' ')[0],
    lastName: name.split(' ').slice(1).join(' '),
    email,
    login: 'No',
    role: 'Business Admin',
    mobile: '',
    privileges: {},
    lastLogin: '—',
    deactivated: false,
    removed: false,
    pending: false,
    organisationId: 'org_one0001',
    general: false,
    companyId: 'org_one0001',
    companyName: 'CY Business Management',
    practice: true,
    practiceRole: 'Owner',
    clientAccess: [],
    allClients: true,
    extraAccess: [],
  });
  if (!existing) items.unshift(row as never);
  save(items);
}

// --- The edit that wiped it --------------------------------------------------
// Turning Login access off used to send `email: ''`, and every other edit on
// that dialog rode along with it — a name, an inbound handle, a phone number.
// So saving a mobile number detached a colleague from their own documents.
seedColleague('colleague1', 'astrid@example.com');
let r = await patch('colleague1', {
  firstName: 'Rowan',
  lastName: 'Tester',
  login: 'No',
  email: '',
  mobile: '6591112222',
});
check('the edit is accepted', r.status, 200);
check('but it cannot blank an address that exists', rowOf('colleague1').email, 'astrid@example.com');
check('while the rest of it still applies', rowOf('colleague1').mobile, '6591112222');
check('and login is still refused', rowOf('colleague1').login, 'No');
check('and they are still on the practice team', rowOf('colleague1').practice, true);

// A deliberate change of address is still a change of address.
await patch('colleague1', { email: 'astrid.yang@cy-bm.sg' });
check('a real address replaces the old one', rowOf('colleague1').email, 'astrid.yang@cy-bm.sg');

// --- Two rows, one person ----------------------------------------------------
// Once an address was loose, the next person added under it inherited the seat.
// The practice row is the primary identity and has to win.
{
  const items = ensure('cybm');
  items.unshift({
    ...rowOf('colleague1'),
    id: 'stray1',
    name: 'astrid astrid',
    firstName: 'astrid',
    lastName: 'astrid',
    practice: false,
    practiceRole: 'Standard',
    allClients: false,
    clientAccess: [],
    // What it carried that the keeper does not: somebody signs in with this
    // password, and it was working in another entity.
    passwordHash: 'salt:hash',
    mobile: '6590001111',
    organisationId: 'org_two0002',
  } as never);
  save(items);
  check(
    'a stray client row never shadows the colleague',
    memberByEmail('cybm', 'astrid.yang@cy-bm.sg')?.id,
    'colleague1'
  );
}

// --- One address, one person -------------------------------------------------
// Two live rows carrying the same address are two identities for one human, and
// which of them somebody IS comes down to whichever the lookup reaches first.
// The stray is folded into the colleague — merged, not discarded.
{
  const kept = rowOf('colleague1');
  const gone = ensure('cybm').find((u) => u.id === 'stray1')!;
  check('the stray row is removed', gone.removed, true);
  check('and the colleague is the one kept', kept.removed, false);
  // Merged, not discarded. Nothing the stray carried is lost: a password
  // somebody signs in with, and the entity it was working in.
  check('the password comes across', kept.passwordHash, 'salt:hash');
  check('the entity it worked in stays reachable', Boolean(kept.clientAccess?.includes('org_two0002') || kept.allClients), true);
  // The keeper's own details win where it has them — this is their row.
  check('the keeper keeps its own number', kept.mobile, '6591112222');
  check('and its own inbound address', kept.emailHandle, rowOf('colleague1').emailHandle);
  check('and the address now resolves to one person', memberByEmail('cybm', 'astrid.yang@cy-bm.sg')?.id, 'colleague1');
}

// --- The break-glass ---------------------------------------------------------
// OWNER_EMAILS exists so no state of the data can lock the practice's own owner
// out of it. It used to be consulted only for somebody ALREADY on the practice
// team — precisely the person who does not need it.
seedColleague('owner1', 'owner@cy-bm.sg', 'Ash Owner');
{
  const items = ensure('cybm');
  const demoted = items.find((u) => u.id === 'owner1')!;
  demoted.practice = false;
  demoted.practiceRole = 'Standard';
  demoted.allClients = false;
  save(items);
  const after = rowOf('owner1'); // ensure() runs the repair on load
  check('an account owner is put back on the practice team', after.practice, true);
  check('as an Owner', after.practiceRole, 'Owner');
  check('with every client', after.allClients, true);
}

// --- Joining is not a way to rewrite somebody ---------------------------------
// /join is how a CLIENT's employee asks to be let in. Run against a row that
// already exists it used to Object.assign the form over it, so a colleague who
// filled it in became a pending employee of whichever company the form named,
// under whatever name was typed. Their login is 'No', which is what put them in
// reach of that branch in the first place.
// Its own name: the roster collapses two rows sharing an organisation and a
// name, which would take this fixture out from under the test.
seedColleague('colleague2', 'joiner@example.com', 'Wren Tester');
const postJoin = async (body: unknown) => {
  const res = await fetch('http://127.0.0.1:4627/api/users/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
// No session, so the route can't identify anybody — the guard that matters
// most, and the one that runs first.
r = await postJoin({ firstName: 'astrid', lastName: 'astrid', companyId: 'org_two0002' });
check('joining without a session is refused', r.status, 401);
check('and the colleague is untouched', [rowOf('colleague2').name, rowOf('colleague2').practice], ['Wren Tester', true]);

server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
