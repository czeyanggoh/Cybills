// A claim names one approver, and only that person could decide it. The
// practice runs the book the claim posts into, and its colleagues are a
// Business Admin inside every client entity they can open — so a CYBM
// colleague may decide a client's claim ON BEHALF OF the named approver: when
// Martin is away, or is a client manager who never signs in here. The trail
// says who actually pressed the button and for whom.
//
// What does not change: a client's other employees still cannot, a deactivated
// colleague cannot, and nobody may approve their own claim by any road.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-claim-approve-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';
process.env.GOOGLE_CLIENT_ID = 'x';
process.env.GOOGLE_CLIENT_SECRET = 'x';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha - ST Engineering', tenantId: 't-red', tenantName: 'Red Alpha', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const jwt = (await import('jsonwebtoken')).default;
const { claimsRouter } = await import('../src/claims.ts');
const { ensure, save } = await import('../src/users.ts');

// The seed is the practice's own staff. Two more colleagues (one deactivated),
// and three of Red Alpha's people: the approver, the claimant, and a bystander.
const items = ensure('cybm');
const seedColleague = items.find((u) => u.practice)!;
const colleague = (id: string, name: string, email: string, extra: Record<string, unknown> = {}) =>
  ({ ...seedColleague, id, name, email, practice: true, practiceRole: 'Standard', role: 'Business Admin', allClients: false, clientAccess: ['org-cybm', 'org-red'], deactivated: false, pending: false, ...extra }) as never;
const employee = (id: string, name: string, email: string, role: string) =>
  ({ ...seedColleague, id, name, email, practice: false, practiceRole: 'Standard', role, allClients: false, clientAccess: [], organisationId: 'org-red', deactivated: false, pending: false }) as never;
items.unshift(
  colleague('col_1', 'Kai Tan', 'kai@cy-bm.sg'),
  colleague('col_2', 'Gone Colleague', 'gone@cy-bm.sg', { deactivated: true }),
  employee('emp_martin', 'Martin Lim', 'martin@redalpha.example', 'Business Admin'),
  employee('emp_astrid', 'Astrid Test', 'astrid@redalpha.example', 'Standard'),
  employee('emp_other', 'Other Person', 'other@redalpha.example', 'Standard')
);
save(items);

const claimRow = (id: string, claimFor: string) => ({
  id, workspaceId: 'cybm', orgId: 'org-red', claimFor, type: 'Regular', name: 'Expense claim',
  claimDate: '2026-09-30', endDate: '2026-09-30', currency: 'SGD',
  transactions: [{ itemId: 'i-1', date: '2026-08-24', supplier: 'Adrian Fong ESTP 02', category: 'Transport - Taxi', net: '104.71', tax: '0', total: '104.71' }],
  history: [], approvalStatus: 'awaiting_approval', approver: 'Martin Lim', approverEmail: 'martin@redalpha.example',
  decidedBy: '', decidedAt: '', archived: false, deleted: false, createdBy: '', createdAt: new Date(0).toISOString(),
  hrSentAt: '', hrSentAmount: '', hrSentBy: '', hrRevision: 0,
});
writeFileSync(
  join(DATA_DIR, 'claims.json'),
  JSON.stringify({
    items: [
      claimRow('astrid-1', 'Astrid Test'),
      claimRow('astrid-2', 'Astrid Test'),
      claimRow('astrid-3', 'Astrid Test'),
      // A colleague's own claim in the same entity, routed to Martin.
      claimRow('kai-own', 'Kai Tan'),
      // Approved already, and one of those published: its bill is in Xero.
      { ...claimRow('astrid-approved', 'Astrid Test'), approvalStatus: 'approved', decidedBy: 'Martin Lim', decidedAt: new Date(2).toISOString() },
      { ...claimRow('astrid-published', 'Astrid Test'), approvalStatus: 'approved', decidedBy: 'Martin Lim', decidedAt: new Date(2).toISOString(), xeroInvoiceId: 'inv-1' },
    ],
  })
);

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/claims', claimsRouter);
const server = app.listen(4641, '127.0.0.1');
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
  const res = await fetch(`http://127.0.0.1:4641/api/claims${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': 'org-red', Cookie: cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

// --- Who may not ---------------------------------------------------------------
let r = await post('/astrid-1/approve', as('other@redalpha.example', 'Other Person'));
check("a client's other employee still cannot approve", r.status, 403);
check('and is told who can', r.body.error, 'not_approver');

r = await post('/astrid-1/approve', as('astrid@redalpha.example', 'Astrid Test'));
check('the claimant cannot approve their own claim', r.status, 403);

r = await post('/astrid-1/approve', as('gone@cy-bm.sg', 'Gone Colleague'));
check('a deactivated colleague cannot', r.status, 403);

r = await post('/kai-own/approve', as('kai@cy-bm.sg', 'Kai Tan'));
check('a colleague cannot approve their OWN claim by the practice road', r.status, 403);

// --- The practice, on the approver's behalf ------------------------------------
r = await post('/astrid-1/approve', as('kai@cy-bm.sg', 'Kai Tan'));
check('a practice colleague may approve', r.status, 200);
check('the claim is approved', r.body.claim?.approvalStatus, 'approved');
check('decided by the person who pressed the button', r.body.claim?.decidedBy, 'Kai Tan');
check('on behalf of the named approver', r.body.claim?.decidedFor, 'Martin Lim');
check('and the trail says so', r.body.claim?.history?.[0]?.text, 'This claim was approved by Kai Tan on behalf of Martin Lim');

r = await post('/astrid-2/reject', as('kai@cy-bm.sg', 'Kai Tan'), { reason: 'Wrong month' });
check('and may reject', r.status, 200);
check('rejected on behalf of the approver', r.body.claim?.decidedFor, 'Martin Lim');
check('with the reason in the trail', r.body.claim?.history?.[0]?.text, 'This claim was rejected by Kai Tan on behalf of Martin Lim: Wrong month');

// --- The named approver, as before ---------------------------------------------
r = await post('/astrid-3/approve', as('martin@redalpha.example', 'Martin Lim'));
check('the named approver still approves', r.status, 200);
check('with nobody standing in', r.body.claim?.decidedFor, '');
check('and the plain trail', r.body.claim?.history?.[0]?.text, 'This claim was approved by Martin Lim');

// --- Unapprove: back to awaiting approval -------------------------------------
r = await post('/astrid-approved/reopen', as('other@redalpha.example', 'Other Person'));
check('a bystander cannot unapprove', r.status, 403);

r = await post('/astrid-approved/reopen', as('astrid@redalpha.example', 'Astrid Test'));
check('nor the claimant', r.status, 403);

r = await post('/astrid-published/reopen', as('martin@redalpha.example', 'Martin Lim'));
check('a published claim is refused even to the approver', r.status, 409);
check('and says why', r.body.error, 'claim_published');

r = await post('/kai-own/reopen', as('martin@redalpha.example', 'Martin Lim'));
check('a claim that is not approved has nothing to reopen', r.status, 409);
check('and says so', r.body.error, 'not_approved');

r = await post('/astrid-approved/reopen', as('kai@cy-bm.sg', 'Kai Tan'), { reason: 'Taxi was 14.71, not 104.71' });
check('a practice colleague may unapprove', r.status, 200);
check('back to awaiting approval', r.body.claim?.approvalStatus, 'awaiting_approval');
check('with the same approver', r.body.claim?.approver, 'Martin Lim');
check('and no decision standing', [r.body.claim?.decidedBy, r.body.claim?.decidedFor, r.body.claim?.decidedAt], ['', '', '']);
check('the trail says who and why', r.body.claim?.history?.[0]?.text, 'This claim was reopened for review by Kai Tan on behalf of Martin Lim: Taxi was 14.71, not 104.71');

r = await post('/astrid-approved/approve', as('martin@redalpha.example', 'Martin Lim'));
check('and it can be approved again', r.body.claim?.approvalStatus, 'approved');

server.close();
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
