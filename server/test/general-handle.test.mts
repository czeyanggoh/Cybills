// The general account has no handle, and typing one into it broke the address.
//
// Its address is the entity's short form standing ALONE — `excelas@cybills.sg`,
// the one to put on a supplier's file, where naming an employee would be wrong
// the day they leave. It is not a handle, and the two resolvers say so from
// both sides: `userByEmailHandle` skips general rows on purpose, and
// `generalUserByEmailSuffix` can never match a dotted local part, because
// `normaliseSuffix` strips the dot that separates person from entity.
//
// The Edit-details card offered an editable handle on that row all the same. A
// handle typed there was stored, and the card then printed
// `finance.excelas@cybills.sg` — an address that resolves to NOBODY, so Gmail's
// forwarding confirmation, and every bill after it, 404s at the door while the
// card goes on saying it works. It cost the address twice over, since
// `ensureEmailHandles` counts every stored handle as taken, so the real person
// who should have had it would have been handed `finance2`.
//
// The route is driven over real HTTP for the reason the payables tests are:
// what is asserted is the answer the browser actually gets.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-general-handle-'));
process.env.BILLS_DATA_DIR = DATA_DIR;

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      {
        id: 'org_excel01',
        orgId: 'cybm',
        name: 'ExcelAS',
        tenantId: 't-excel',
        tenantName: 'ExcelAS',
        emailSuffix: 'excelas',
        createdAt: new Date(0).toISOString(),
        createdBy: '',
      },
    ],
  })
);

// The row as it was left by the dialog that should never have offered the field:
// the entity's general account, carrying a hand-typed handle.
writeFileSync(
  join(DATA_DIR, 'users.json'),
  JSON.stringify({
    items: [
      {
        id: 'gen_excel',
        workspaceId: 'cybm',
        name: 'General ExcelAS',
        firstName: '',
        lastName: '',
        email: 'org_excel01.general@cybills.local',
        login: 'No',
        role: 'Standard',
        mobile: '',
        privileges: {},
        lastLogin: '—',
        deactivated: false,
        removed: false,
        pending: false,
        practice: false,
        practiceRole: '',
        clientAccess: [],
        extraAccess: [],
        allClients: false,
        organisationId: 'org_excel01',
        general: true,
        companyId: 'org_excel01',
        companyName: 'ExcelAS',
        managerId: '',
        project: '',
        emailHandle: 'finance',
      },
    ],
  })
);

const express = (await import('express')).default;
const users = await import('../src/users.ts');
const { ensure, save, full, usersRouter, userByEmailHandle, generalUserByEmailSuffix, addressForUser } = users;

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- The address that never worked -------------------------------------------
// Asserted first and on its own, because this is the whole bug: the card was
// printing this address while the door was shut.
check('a dotted address on a general row reaches nobody', userByEmailHandle('finance.excelas'), null);
check('…and the short form is not a handle either', generalUserByEmailSuffix('cybm', 'finance.excelas'), null);

// --- The repair, on load ------------------------------------------------------
const rows = ensure('cybm');
const general = rows.find((u) => u.id === 'gen_excel')!;
check('the stray handle is cleared', general.emailHandle, '');
check('the general account answers to the entity alone', generalUserByEmailSuffix('cybm', 'excelas')?.id, 'gen_excel');
// Its own stored address is an internal identity — nothing is sent to it — so
// addressForUser has nothing to build, which is the point of clearing the handle.
check('and has no address of a person', addressForUser(general), '');

// --- And the freed address reaches the real person ----------------------------
// The half that would have gone unnoticed: a handle left on the general row is
// counted as taken, so the person this address was meant for gets `finance2` —
// an address nobody can be told over the phone without explaining it.
rows.push(full({ name: 'Finance ExcelAS', firstName: 'Finance', email: 'finance@excelas.com', organisationId: 'org_excel01', login: 'Yes' }, 'cybm'));
save(rows);
const person = ensure('cybm').find((u) => u.email === 'finance@excelas.com')!;
check('a real person takes the freed handle', person.emailHandle, 'finance');
check('…and their address is the one that was printed', addressForUser(person), 'finance.excelas@cybills.sg');
check('…which now reaches them', userByEmailHandle('finance.excelas')?.id, person.id);

// --- The route refuses it, whatever the dialog offers -------------------------
const app = express();
app.use(express.json());
app.use('/api/users', usersRouter);
const server = app.listen(4651, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const setHandle = async (id: string, emailHandle: string) => {
  const res = await fetch(`http://127.0.0.1:4651/api/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailHandle }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const refused = await setHandle('gen_excel', 'finance');
check('the general row refuses a handle', refused.status, 409);
check('…by name', refused.body.error, 'general_has_no_handle');
check('…and nothing was written', ensure('cybm').find((u) => u.id === 'gen_excel')!.emailHandle, '');

// A person is untouched by any of this.
const allowed = await setHandle(person.id, 'accounts');
check('a person still chooses their own', allowed.status, 200);
check('…and it is stored', ensure('cybm').find((u) => u.id === person.id)!.emailHandle, 'accounts');

await finish(failures, server);
