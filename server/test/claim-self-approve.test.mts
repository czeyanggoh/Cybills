// A claimant with NO direct manager has nobody to submit to, so — if they hold
// the publishing privilege — they approve their own claim, then publish it.
// Everyone else keeps the old rule: nobody decides their own claim.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-claim-self-'));
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
const { ensure, save } = await import('../src/users.ts');

const items = ensure('cybm');
const seed = items.find((u) => u.practice)!;
const employee = (id: string, name: string, email: string, privileges: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ ...seed, id, name, email, practice: false, practiceRole: 'Standard', role: 'Standard', allClients: false, clientAccess: [], organisationId: 'org-red', deactivated: false, pending: false, privileges, ...extra }) as never;
items.unshift(
  employee('boss', 'Boss Person', 'boss@red.example', {}),
  employee('free', 'Free Agent', 'free@red.example', { canPublish: true }),
  employee('nopub', 'No Publish', 'nopub@red.example', { canPublish: false }),
  employee('managed', 'Managed Person', 'managed@red.example', { canPublish: true }, { managerId: 'boss' })
);
save(items);

const claimRow = (id: string, claimFor: string, extra: Record<string, unknown> = {}) => ({
  id, workspaceId: 'cybm', orgId: 'org-red', claimFor, type: 'Regular', name: 'Expense claim',
  claimDate: '2026-10-31', endDate: '2026-10-31', currency: 'SGD',
  transactions: [{ itemId: 'i-1', date: '2026-10-02', supplier: 'Grab', category: 'Transport - Taxi', net: '10', tax: '0', total: '10' }],
  history: [], approvalStatus: '', approver: '', approverEmail: '', decidedBy: '', decidedAt: '',
  archived: false, deleted: false, createdBy: '', createdAt: new Date(0).toISOString(),
  hrSentAt: '', hrSentAmount: '', hrSentBy: '', hrRevision: 0, ...extra,
});
writeFileSync(
  join(DATA_DIR, 'claims.json'),
  JSON.stringify({ items: [claimRow('free-1', 'Free Agent'), claimRow('nopub-1', 'No Publish'), claimRow('managed-1', 'Managed Person')] })
);

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/claims', claimsRouter);
const server = app.listen(4642, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const as = (email: string, name: string) =>
  `cyb_session=${jwt.sign({ sub: email, email, name }, 'test-session-secret', { expiresIn: '1h' })}`;
const post = async (path: string, cookie: string) => {
  const res = await fetch(`http://127.0.0.1:4642/api/claims${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': 'org-red', Cookie: cookie },
    body: '{}',
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

let r = await post('/nopub-1/approve', as('nopub@red.example', 'No Publish'));
check('no manager but no publishing privilege: refused', r.status, 403);

r = await post('/managed-1/approve', as('managed@red.example', 'Managed Person'));
check('has a manager: cannot approve their own claim', r.status, 403);

r = await post('/free-1/approve', as('free@red.example', 'Free Agent'));
check('no manager + may publish: approves their own claim', r.status, 200);
check('the claim is approved', r.body.claim?.approvalStatus, 'approved');
check('decided by themselves', r.body.claim?.decidedBy, 'Free Agent');
check('and the trail says why', /no direct manager/.test(r.body.claim?.history?.[0]?.text ?? ''), true);

server.close();
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
