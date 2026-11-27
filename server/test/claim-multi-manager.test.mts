// Somebody may have several direct managers. A claim of theirs goes to ONE of
// them, picked by whoever submits it; each of them is a manager (they see the
// claimant's claims), and only the one it was sent to is its named approver.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-claim-managers-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';
process.env.GOOGLE_CLIENT_ID = 'x';
process.env.GOOGLE_CLIENT_SECRET = 'x';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha', tenantId: 't-red', tenantName: 'Red Alpha', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const jwt = (await import('jsonwebtoken')).default;
const { claimsRouter } = await import('../src/claims.ts');
const { usersRouter, ensure, save, directManagersFor, peopleForOrg, visibleOwnersFor } = await import('../src/users.ts');

const items = ensure('cybm');
const seed = items.find((u) => u.practice)!;
const employee = (id: string, name: string, email: string, extra: Record<string, unknown> = {}) =>
  ({ ...seed, id, name, email, practice: false, practiceRole: 'Standard', role: 'Standard', allClients: false, clientAccess: [], extraAccess: [], organisationId: 'org-red', deactivated: false, pending: false, privileges: {}, managerId: '', managerIds: undefined, ...extra }) as never;
items.unshift(
  employee('adm', 'Ada Admin', 'ada@red.example', { role: 'Business Admin' }),
  employee('m1', 'Mia One', 'mia@red.example'),
  employee('m2', 'Max Two', 'max@red.example'),
  employee('m3', 'Mo Three', 'mo@red.example'),
  employee('staff', 'Sam Staff', 'sam@red.example'),
  // Saved before there could be several.
  employee('old', 'Olga Old', 'olga@red.example', { managerId: 'm1' })
);
save(items);

const claimRow = (id: string, claimFor: string) => ({
  id, workspaceId: 'cybm', orgId: 'org-red', claimFor, type: 'Regular', name: 'Expense claim',
  claimDate: '2026-10-31', endDate: '2026-10-31', currency: 'SGD',
  transactions: [{ itemId: `i-${id}`, date: '2026-10-02', supplier: 'Grab', category: 'Transport - Taxi', net: '10', tax: '0', total: '10' }],
  history: [], approvalStatus: '', approver: '', approverEmail: '', decidedBy: '', decidedAt: '',
  archived: false, deleted: false, createdBy: '', createdAt: new Date(0).toISOString(),
  hrSentAt: '', hrSentAmount: '', hrSentBy: '', hrRevision: 0,
});
writeFileSync(join(DATA_DIR, 'claims.json'), JSON.stringify({ items: [claimRow('c-sam', 'Sam Staff'), claimRow('c-olga', 'Olga Old')] }));

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/claims', claimsRouter);
app.use('/api/users', usersRouter);
const server = app.listen(4643, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const as = (email: string, name: string) =>
  `cyb_session=${jwt.sign({ sub: email, email, name }, 'test-session-secret', { expiresIn: '1h' })}`;
const admin = as('ada@red.example', 'Ada Admin');
const sam = as('sam@red.example', 'Sam Staff');
const call = async (method: string, path: string, cookie: string, body: unknown = {}) => {
  const res = await fetch(`http://127.0.0.1:4643${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': 'org-red', Cookie: cookie },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};
const submit = (id: string, body: unknown = {}, cookie = sam) => call('POST', `/api/claims/${id}/submit`, cookie, body);
const row = async (id: string) => (await call('GET', '/api/users', admin)).body.users.find((u: any) => u.id === id);

check('a row with only the old single field still has its manager', directManagersFor('cybm', 'Olga Old', 'org-red').map((m) => m.id), ['m1']);

await call('PATCH', '/api/users/staff', admin, { managerIds: ['m1', 'm2', 'm1', 'staff', ''] });
check('several are saved once each, never themselves', (await row('staff')).managerIds, ['m1', 'm2']);
check('the single field is the first', (await row('staff')).managerId, 'm1');
const shown = peopleForOrg('cybm', 'org-red').find((p) => p.name === 'Sam Staff')!;
check('the directory lists them all', [shown.managerName, shown.managers.map((m) => m.name)], ['Mia One', ['Mia One', 'Max Two']]);
const sees = (email: string, name: string) => {
  const req = { header: () => 'org-red', cookies: { cyb_session: as(email, name).split('=')[1] }, headers: {} } as never;
  return visibleOwnersFor(req, 'org-red', true)?.has('sam@red.example') ?? true;
};
check('each of them sees the claimant’s claims', [sees('mia@red.example', 'Mia One'), sees('max@red.example', 'Max Two'), sees('mo@red.example', 'Mo Three')], [true, true, false]);

let r = await submit('c-sam');
check('with several, naming nobody is refused', [r.status, r.body.error, r.body.approvers?.map((m: any) => m.id)], [400, 'choose_approver', ['m1', 'm2']]);
r = await submit('c-sam', { approverId: 'm3' });
check('somebody who is not their manager is refused', [r.status, r.body.error], [400, 'not_a_manager']);
r = await submit('c-sam', { approverId: 'm2' });
check('the one picked is the approver', [r.status, r.body.claim?.approver, r.body.claim?.approverEmail], [200, 'Max Two', 'max@red.example']);
r = await call('POST', '/api/claims/c-sam/approve', as('mia@red.example', 'Mia One'));
check('the other manager may not decide it', r.status, 403);
r = await submit('c-sam', { approverEmail: 'MIA@red.example' });
check('re-submitting can move it, by address', [r.status, r.body.claim?.approver], [200, 'Mia One']);
r = await call('POST', '/api/claims/c-sam/approve', as('mia@red.example', 'Mia One'));
check('and that one approves it', [r.status, r.body.claim?.approvalStatus], [200, 'approved']);

r = await submit('c-olga', {}, as('olga@red.example', 'Olga Old'));
check('with one manager there is nothing to choose', [r.status, r.body.claim?.approver], [200, 'Mia One']);

await call('POST', '/api/users/m1/active', admin, { active: false });
check('a deactivated manager is not offered beside an active one', directManagersFor('cybm', 'Sam Staff', 'org-red').map((m) => m.id), ['m2']);
await call('DELETE', '/api/users/m2', admin);
check('removing one leaves the others', (await row('staff')).managerIds, ['m1']);
await call('PATCH', '/api/users/staff', admin, { managerId: 'm3' });
check('the single field alone means that one person', (await row('staff')).managerIds, ['m3']);
await call('PATCH', '/api/users/staff', admin, { managerIds: [] });
check('cleared', [(await row('staff')).managerIds, (await row('staff')).managerId], [[], '']);

server.close();
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
process.exit(0);
