// One person, two entities.
//
// Sign-in is by email, so a second roster row for the same address would be a
// second identity — their documents, their claims and their manager would split
// between the two, and only one of them could ever sign in. So somebody who
// works in more than one entity keeps their row and gains access to the other,
// with the role they hold THERE.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-multi-'));
process.env.BILLS_DATA_DIR = DATA_DIR;

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
const { usersRouter, canAccessOrg, effectiveRoleFor, peopleForOrg, ensure } = await import('../src/users.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/users', usersRouter);
const server = app.listen(4616, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const call = async (method: string, path: string, org: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:4616${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': org },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const rowFor = (email: string) => ensure('cybm').find((u) => u.email.toLowerCase() === email)!;

// Martin belongs to Red Alpha, as a Business Admin there.
let r = await call('POST', '/api/users', 'org-red', { firstName: 'Martin', lastName: 'Lim', email: 'martin@redalphacyber.com', login: 'Yes', role: 'Business Admin', notify: false });
check('Martin exists in Red Alpha', r.body.users[0].name, 'Martin Lim');
const martinId = r.body.users[0].id;

// Adding him to the bridge entity is not a duplicate — it is the same person,
// working in a second entity, as a Standard user there.
r = await call('POST', '/api/users', 'org-ste', { firstName: 'Martin', lastName: 'Lim', email: 'martin@redalphacyber.com', login: 'Yes', role: 'Standard', notify: false });
check('adding him again creates no second row', r.body.users.length, 0);
check('…and is not reported as a duplicate', r.body.duplicates.length, 0);
check('…it links him to this entity', r.body.linked.map((l: any) => l.name), ['Martin Lim']);
check('…with the role he was given here', r.body.linked[0].role, 'Standard');
check('there is still exactly one Martin', ensure('cybm').filter((u) => /martin/i.test(u.email)).length, 1);

// Both entities, each with its own role.
const martin = rowFor('martin@redalphacyber.com');
check('he can open his own entity', canAccessOrg(martin, 'org-red'), true);
check('…and the one he was added to', canAccessOrg(martin, 'org-ste'), true);
check('…but not one he was never given', canAccessOrg(martin, 'org-other'), false);
check('Business Admin at home', effectiveRoleFor(martin, 'org-red'), 'Business Admin');
check('Standard as a visitor', effectiveRoleFor(martin, 'org-ste'), 'Standard');

// He appears in the bridge entity's roster and its directory, so documents can
// be made out to him and a claim can be his.
r = await call('GET', '/api/users', 'org-ste');
const listed = r.body.users.find((u: any) => u.id === martinId);
check('he is on the entity roster', Boolean(listed), true);
check('…showing the role he holds here', listed.role, 'Standard');
check('…and where he actually belongs', listed.homeOrgName, 'Red Alpha Cybersecurity');
check('the directory can name him here', peopleForOrg('cybm', 'org-ste').some((p) => p.name === 'Martin Lim'), true);

// A role changed here applies here — promoting him in somebody else's company
// from this page would be exactly wrong.
r = await call('PATCH', `/api/users/${martinId}`, 'org-ste', { role: 'Business Admin' });
check('his role here can be changed', effectiveRoleFor(rowFor('martin@redalphacyber.com'), 'org-ste'), 'Business Admin');
check('…leaving his own company alone', rowFor('martin@redalphacyber.com').role, 'Business Admin');
r = await call('PATCH', `/api/users/${martinId}`, 'org-ste', { role: 'Standard' });
check('…and back again', effectiveRoleFor(rowFor('martin@redalphacyber.com'), 'org-ste'), 'Standard');
check('…still untouched at home', effectiveRoleFor(rowFor('martin@redalphacyber.com'), 'org-red'), 'Business Admin');

// Somebody already in THIS entity is simply already here.
r = await call('POST', '/api/users', 'org-red', { firstName: 'Martin', lastName: 'Lim', email: 'martin@redalphacyber.com', login: 'Yes', role: 'Standard', notify: false });
check('adding him where he already is stays a duplicate', r.body.duplicates.length, 1);
check('…and links nothing', r.body.linked.length, 0);

server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
