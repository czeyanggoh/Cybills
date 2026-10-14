// A receipt nobody could put a name to, or a date on, does not hold a claim up.
//
// A claim's bill is made out to the CLAIMANT, so the supplier of an item is only
// ever words on its line: one the reader could not name goes on as "Unknown
// supplier" and is approved and posted like any other. And a receipt with no
// readable date takes the day it was SUBMITTED, in the practice's own day —
// the claim is dated by the claim, so the item's date only has to say roughly
// when. Category and Total still hold: without them a line has no account to
// post to and no money to pay back.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-claim-unknown-'));
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
const { insertBill } = await import('../src/store.ts');
const { practiceDayKey } = await import('../src/usage.ts');

const RED = 'org-red';
const items = ensure('cybm');
const seed = items.find((u) => u.practice)!;
const employee = (id: string, name: string, email: string, role: string) =>
  ({ ...seed, id, name, email, practice: false, practiceRole: 'Standard', role, allClients: false, clientAccess: [], extraAccess: [], organisationId: RED, deactivated: false, pending: false, removed: false, managerId: '' }) as never;
items.unshift(
  employee('emp_martin', 'Martin Lim', 'martin@redalpha.example', 'Business Admin'),
  employee('emp_astrid', 'Astrid Test', 'astrid@redalpha.example', 'Standard')
);
save(items);

const bill = (fields: Record<string, unknown>) =>
  insertBill({
    orgId: RED, fileHash: String(Math.random()), fileName: 'r.jpg', supplier: 'Grab', invoiceNumber: '',
    documentType: 'Receipt', currency: 'SGD', total: 10, tax: 0, date: '2026-10-05', category: '493 - Travel',
    createdBy: 'astrid@redalpha.example', owner: 'astrid@redalpha.example', storageKey: '', contentType: 'image/jpeg',
    status: 'expenseclaim', kind: 'cost', ...fields,
  } as never);

const noName = bill({ supplier: '' });
const placeholder = bill({ supplier: 'Unknown supplier' });
const noDate = bill({ date: '' });
const noCategory = bill({ category: '' });

const txn = (b: { id: string }) => ({ itemId: b.id, date: '—', supplier: 'Unknown supplier', category: '493 - Travel', net: '10', tax: '0', total: '10' });
const claimRow = (id: string, docs: { id: string }[]) => ({
  id, workspaceId: 'cybm', orgId: RED, claimFor: 'Astrid Test', type: 'Regular', name: 'Expense claim',
  claimDate: '2026-10-31', endDate: '2026-10-31', currency: 'SGD', transactions: docs.map(txn),
  history: [], approvalStatus: '', approver: '', approverEmail: '',
  decidedBy: '', decidedAt: '', archived: false, deleted: false, createdBy: '', createdAt: new Date(0).toISOString(),
  hrSentAt: '', hrSentAmount: '', hrSentBy: '', hrRevision: 0,
});
writeFileSync(
  join(DATA_DIR, 'claims.json'),
  JSON.stringify({
    items: [
      claimRow('unknowns', [noName, placeholder, noDate]),
      claimRow('uncoded', [noName, noCategory]),
    ],
  })
);

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/claims', claimsRouter);
const server = app.listen(4733, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const MARTIN = `cyb_session=${jwt.sign({ sub: 'martin@redalpha.example', email: 'martin@redalpha.example', name: 'Martin Lim' }, 'test-session-secret', { expiresIn: '1h' })}`;
const post = async (path: string) => {
  const res = await fetch(`http://127.0.0.1:4733/api/claims${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': RED, Cookie: MARTIN },
    body: '{}',
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

let r = await post('/unknowns/approve');
check('a claim with an unnamed and an undated receipt is approved', r.status, 200);
const lines = (r.body.claim?.transactions ?? []) as { itemId: string; supplier: string; date: string }[];
const line = (id: string) => lines.find((t) => t.itemId === id);
check('a blank supplier goes on as "Unknown supplier"', line(noName.id)?.supplier, 'Unknown supplier');
check('…and so does the placeholder the reader wrote', line(placeholder.id)?.supplier, 'Unknown supplier');
check('an undated receipt takes the day it was submitted', line(noDate.id)?.date, practiceDayKey(new Date(noDate.createdAt)));
check('a dated receipt keeps its own date', line(noName.id)?.date, '2026-10-05');

r = await post('/uncoded/approve');
check('an item with no category still holds the claim', r.body.error, 'incomplete_items');
check('…and only the category is asked for', r.body.items?.map((x: { missing: string[] }) => x.missing), [['Category']]);

server.close();
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
