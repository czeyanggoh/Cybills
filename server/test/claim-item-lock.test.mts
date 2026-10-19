// A document on an APPROVED expense claim is locked for the people who raised
// it, and correctable by a Business Admin, whose correction is carried onto the
// claim so what posts is what was corrected (Cze, 19 Oct 2026).
//
// The case behind it: Jenny Lye's Tiong Bahru receipt was changed to No Tax
// after her claim was approved, and the claim kept the approved 16.56 of tax —
// which would have posted under the new No Tax code.
//
// Driven over real HTTP: the rule reads the caller's role out of their session.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-claim-lock-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';

const RED = 'org_red';
writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: RED, orgId: 'cybm', name: 'Red Alpha Cybersecurity Pte. Ltd.', tenantId: 't-red', tenantName: 'Red Alpha', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

const doc = (id: string, extra: Record<string, unknown> = {}) => ({
  id, orgId: RED, displayId: id, fileHash: `h-${id}`, fileName: `${id}.jpg`, supplier: 'TIONG BAHRU', invoiceNumber: id,
  documentType: 'Receipt', currency: 'SGD', total: 200.59, tax: 16.56, date: '2026-09-23', category: '8619 - ENTERTAINMENT',
  taxRate: 'Standard-Rated Purchases', createdBy: 'astrid@redalphacyber.com', owner: 'astrid@redalphacyber.com',
  status: 'expenseclaim', kind: 'cost', createdAt: new Date(0).toISOString(), ...extra,
});
writeFileSync(join(DATA_DIR, 'bills.json'), JSON.stringify({ bills: [doc('260929211213'), doc('260929211214')] }));

const txn = (itemId: string) => ({
  itemId, date: '2026-09-23', supplier: 'TIONG BAHRU', category: '8619 - ENTERTAINMENT', description: 'lunch', net: '184.03', tax: '16.56', total: '200.59',
});
const claim = (id: string, approvalStatus: string, itemId: string) => ({
  id, workspaceId: 'cybm', orgId: RED, claimFor: 'Astrid Test', type: 'Regular', name: `Claim ${id}`,
  claimDate: '2026-09-30', endDate: '2026-09-30', currency: 'SGD', transactions: [txn(itemId)],
  history: [], approvalStatus, approver: '', approverEmail: '', decidedBy: '', decidedAt: '',
  archived: false, deleted: false, createdBy: 'astrid@redalphacyber.com', createdAt: new Date(0).toISOString(),
  hrSentAt: '', hrSentAmount: '', hrSentBy: '', hrRevision: 0,
});
writeFileSync(
  join(DATA_DIR, 'claims.json'),
  JSON.stringify({ items: [claim('approved', 'approved', '260929211213'), claim('draft', 'draft', '260929211214')] })
);

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const jwt = (await import('jsonwebtoken')).default;
const { billsRouter } = await import('../src/bills.ts');
const { getClaimForXero } = await import('../src/claims.ts');
const { ensure, save } = await import('../src/users.ts');

const items = ensure('cybm');
const seed = items.find((u) => u.practice)!;
const employee = (id: string, name: string, email: string, role: string) =>
  ({
    ...seed, id, name, email, role, practice: false, practiceRole: 'Standard', general: false,
    allClients: false, clientAccess: [], extraAccess: [], organisationId: RED,
    deactivated: false, pending: false, removed: false, managerId: '', privileges: { accessAll: true },
  }) as never;
items.unshift(
  employee('emp_astrid', 'Astrid Test', 'astrid@redalphacyber.com', 'Standard'),
  employee('emp_boss', 'Bee Admin', 'boss@redalphacyber.com', 'Business Admin')
);
save(items);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use('/api/costs', billsRouter);
const server = app.listen(4745, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const as = (email: string, name: string) =>
  `cyb_session=${jwt.sign({ sub: email, email, name }, 'test-session-secret', { expiresIn: '1h' })}`;
const call = async (method: string, path: string, cookie: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:4745/api/costs${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': RED, Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};
const ASTRID = as('astrid@redalphacyber.com', 'Astrid Test');
const BOSS = as('boss@redalphacyber.com', 'Bee Admin');

// --- The claimant, a Standard user, cannot touch an approved claim's item -----
let r = await call('PATCH', '/bills/260929211213', ASTRID, { taxRate: 'No Tax', tax: '0' });
check('a Standard user cannot amend an item on an approved claim', [r.status, r.body.error], [409, 'claim_locked']);
check('…and is told a Business Admin can correct it', /Business Admin/.test(String(r.body.message)), true);
r = await call('DELETE', '/bills/260929211213', ASTRID);
check('…nor delete it', [r.status, r.body.error], [409, 'claim_locked']);
r = await call('POST', '/bills/260929211213/file', ASTRID, { fileBase64: 'aGVsbG8=', mediaType: 'image/png' });
check('…nor replace its file', [r.status, r.body.error], [409, 'claim_locked']);
check('the claim keeps the approved figures', getClaimForXero(RED, 'approved')?.transactions[0].tax, '16.56');

// A claim that is not approved yet is still the claimant's to work on.
r = await call('PATCH', '/bills/260929211214', ASTRID, { note: 'lunch with the team' });
check('an item on a DRAFT claim is still editable by its claimant', r.status, 200);

// --- A Business Admin corrects it, and the claim takes the correction --------
r = await call('PATCH', '/bills/260929211213', BOSS, { taxRate: 'No Tax', tax: '0' });
check('a Business Admin may correct it', r.status, 200);
check('…the claim is said to have taken it', [r.body.claimCorrection?.claimId, r.body.claimCorrection?.after], ['approved', { total: '200.59', tax: '0.00' }]);
const after = getClaimForXero(RED, 'approved')!;
check('…the approved line now carries the corrected figures', [after.transactions[0].tax, after.transactions[0].net, after.transactions[0].total], ['0.00', '200.59', '200.59']);
check('…still approved', after.approvalStatus, 'approved');
check('…and the claim history says who corrected what', /corrected after approval — total 200\.59 → 200\.59, tax 16\.56 → 0\.00/.test(after.history[0]?.text) && after.history[0]?.by === 'Bee Admin', true);

// A save that changes nothing the claim carries writes no history.
const before = after.history.length;
r = await call('PATCH', '/bills/260929211213', BOSS, { note: 'checked' });
check('a correction that moves nothing on the line writes nothing to the claim', [r.body.claimCorrection, getClaimForXero(RED, 'approved')!.history.length], [null, before]);

await finish(failures, server);
