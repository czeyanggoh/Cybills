// Auto Expense claims file a document the moment it is eligible, Dext's way:
// "any new items submitted by users with Auto Expense claims are automatically
// added to their open claim". It used to wait for the claims-end date to pass,
// so a receipt uploaded on the 21st sat in the inbox until the 1st and the
// switch looked broken.
//
// And "Include existing inbox items" means what Dext means by it: what was
// ALREADY in the person's inbox when they were switched on. Everything they
// submit afterwards is claimed whichever way it is set.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-autoclaims-'));
process.env.BILLS_DATA_DIR = DATA_DIR;

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CYBM', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha', tenantId: 't-red', tenantName: 'Red Alpha', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

const { ensure, save } = await import('../src/users.ts');
const { insertBill, getBillByIdAny } = await import('../src/store.ts');
const { runAutoClaims, todayIso, endOfMonthFor } = await import('../src/autoClaims.ts');
const { loadCollection, saveCollection } = await import('../src/jsonStore.ts');

const RED = 'org-red';
let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const items = ensure('cybm');
const seed = items.find((u) => u.practice)!;
items.unshift({
  ...seed, id: 'emp_astrid', name: 'Astrid Test', email: 'astrid@red.com', role: 'Standard', practice: false,
  practiceRole: 'Standard', general: false, allClients: false, clientAccess: [], extraAccess: [],
  organisationId: RED, deactivated: false, pending: false, removed: false, managerId: '',
} as never);
save(items);

const today = todayIso();
const bill = (supplier: string, status: string, createdAt?: string) => {
  const b = insertBill({
    orgId: RED, fileHash: supplier, fileName: `${supplier}.pdf`, supplier, invoiceNumber: '',
    documentType: '', currency: 'SGD', total: 60, tax: 0, date: today, category: '493 - Travel',
    createdBy: 'astrid@red.com', owner: 'astrid@red.com', storageKey: '', contentType: 'application/pdf',
    status, kind: 'cost',
  } as never);
  if (createdAt) (b as { createdAt: string }).createdAt = createdAt;
  return b;
};

const claimed = (id: string) =>
  loadCollection<{ transactions: { itemId: string }[]; deleted?: boolean }>('claims').some(
    (c) => !c.deleted && c.transactions.some((t) => String(t.itemId) === id)
  );

// Already in the inbox BEFORE Astrid was switched on.
const old = bill('Old Supplier', 'ready', '2020-01-01T00:00:00.000Z');

saveCollection('autoClaims', [
  {
    workspaceId: 'cybm', orgId: RED, endDate: endOfMonthFor(today), endOfMonth: true, frequency: 'monthly',
    includeInbox: false, userIds: ['emp_astrid'], enrolledAt: { emp_astrid: '2025-01-01T00:00:00.000Z' }, lastRunAt: '',
  },
]);

// Submitted after enrolment, in a period that has NOT ended.
const fresh = bill('ACRA', 'ready');
const reading = bill('Still Reading', 'processing');
const needsWork = bill('Needs Category', 'new');

const run = runAutoClaims('cybm', RED);
check('a claim is filed while the period is still running', run.claims, 1);
check('a new Ready item goes straight onto it', claimed(fresh.id), true);
check('a new item still in the inbox goes too (Dext files every new submission)', claimed(needsWork.id), true);
check('a document still being read waits for its read', claimed(reading.id), false);
check('an item that pre-dates enrolment is left alone without "Include existing inbox items"', claimed(old.id), false);
check('the claimed document leaves the inbox', getBillByIdAny(fresh.id)?.status, 'expenseclaim');
check('the end date has not rolled', run.endDate, endOfMonthFor(today));

// A second run adds to the SAME open claim rather than opening another.
const later = bill('Later', 'ready');
const run2 = runAutoClaims('cybm', RED);
check('a later item joins the open claim', [run2.claims, claimed(later.id)], [0, true]);

// Switching "Include existing inbox items" on brings the older one along.
const s = loadCollection<{ includeInbox: boolean }>('autoClaims');
s[0].includeInbox = true;
saveCollection('autoClaims', s);
runAutoClaims('cybm', RED);
check('existing inbox items come along when asked for', claimed(old.id), true);

await finish(failures);
