// A document is on ONE expense claim — the regression for two bugs seen on
// GCY AUS's October / November claims (Nov 2026), and the rule a third report
// turned out to be:
//
//  1. Tanda's 28 Oct receipt (item 261029000237) was "In expense claim" on BOTH
//     claims. Membership was only ever de-duplicated within one claim, a line
//     stored under the Item ID people see (rather than the `bill_…` id) was
//     invisible to every id comparison, and Move was two separate requests.
//  2. The Costs list said "In expense claim" off a status flag that could drift
//     from what the claims actually hold.
//  3. Auto Expense claims put October-dated invoices on November's claim when
//     they were read after October had rolled over. That is INTENDED: a late
//     submission does not reopen a closed period's claim. Pinned here.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-membership-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CYBM', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-gcy', orgId: 'cybm', name: 'GCY AUS', tenantId: 't-gcy', tenantName: 'GCY AUS', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const { ensure, save } = await import('../src/users.ts');
const claims = await import('../src/claims.ts');
const { claimsRouter, saveClaimXero, duplicateMemberships, keeperOf, membershipStatusFixes, syncClaimStatuses } = claims;
const { insertBill, getBillByIdAny, itemIdFor, listBills, updateBill } = await import('../src/store.ts');
const { runAutoClaims, todayIso, endOfMonthFor } = await import('../src/autoClaims.ts');
const { loadCollection, saveCollection } = await import('../src/jsonStore.ts');

const ORG = 'org-gcy';
const app = express();
app.use(express.json());
app.use('/api/claims', (req, _res, next) => { req.headers['x-org-id'] = ORG; next(); }, claimsRouter);
const server = app.listen(4651, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const people = ensure('cybm');
const seed = people.find((u) => u.practice)!;
people.unshift({
  ...seed, id: 'emp_gcy', name: 'GCY AUS', email: 'gcy@example.com', role: 'Standard', practice: false,
  practiceRole: 'Standard', general: false, allClients: false, clientAccess: [], extraAccess: [],
  organisationId: ORG, deactivated: false, pending: false, removed: false, managerId: '',
} as never);
save(people);

const today = todayIso();
const bill = (supplier: string, date = today, status = 'ready') =>
  insertBill({
    orgId: ORG, fileHash: `${supplier}-${date}`, fileName: `${supplier}.pdf`, supplier, invoiceNumber: '',
    documentType: '', currency: 'SGD', total: 193.6, tax: 0, date, category: '493 - Travel',
    createdBy: 'gcy@example.com', owner: 'gcy@example.com', storageKey: '', contentType: 'application/pdf',
    status, kind: 'cost',
  } as never);
const asItem = (b: { id: string; supplier: string; date: string }, itemId = b.id) =>
  ({ itemId, date: b.date, supplier: b.supplier, category: '493 - Travel', net: '193.60', tax: '0.00', total: '193.60' });

type StoredClaim = { id: string; name: string; deleted?: boolean; autoPeriodEnd?: string; transactions: { itemId: string }[]; history: { text: string }[] };
const stored = () => loadCollection<StoredClaim>('claims');
const claimsHolding = (id: string) => stored().filter((c) => !c.deleted && c.transactions.some((t) => String(t.itemId) === id)).map((c) => c.name);

const api = async (path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:4651/api/claims${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
};

// --- 1. Added by its Item ID, it is stored by its bill id -----------------------
const tanda = bill('EPI Capital Pty Ltd (Tanda)', '2026-10-28');
let r = await api('/', { name: 'GCY AUS Oct', claimFor: 'GCY AUS' });
const oct = r.body.claim.id as string;
r = await api('/', { name: 'GCY AUS Nov', claimFor: 'GCY AUS' });
const nov = r.body.claim.id as string;

r = await api(`/${oct}/items`, { items: [asItem(tanda, itemIdFor(tanda.id))] });
check('an item added by the number people see is stored by its bill id', r.body.claim.transactions.map((t: any) => t.itemId), [tanda.id]);
check('…and the document is marked as claimed', getBillByIdAny(tanda.id)?.status, 'expenseclaim');

// --- 2. Adding it to another claim MOVES it -------------------------------------
r = await api(`/${nov}/items`, { items: [asItem(tanda)] });
check('adding it to the November claim moves it', claimsHolding(tanda.id), ['GCY AUS Nov']);
check('…and says where it came from', r.body.moved_from.map((m: any) => [m.claimId, m.itemIds]), [[oct, [tanda.id]]]);
check('…and the October claim says why it is gone', stored().find((c) => c.id === oct)!.history[0].text, '1 item(s) moved to "GCY AUS Nov"');

// The case that went wrong: two other items moved Nov -> Oct, then Tanda.
const deputy = bill('Deputec Pty Ltd (Deputy)', '2026-10-31');
const other = bill('Another supplier', '2026-10-15');
await api(`/${nov}/items`, { items: [asItem(deputy), asItem(other)] });
r = await api(`/${oct}/items`, { items: [asItem(deputy), asItem(other)] });
check('moving two items leaves the third where it was', claimsHolding(tanda.id), ['GCY AUS Nov']);
check('…and the two are on October only', [claimsHolding(deputy.id), claimsHolding(other.id)], [['GCY AUS Oct'], ['GCY AUS Oct']]);
r = await api(`/${oct}/items`, { items: [asItem(tanda)] });
check('moving Tanda back empties November', stored().find((c) => c.id === nov)!.transactions.length, 0);
check('…and October holds all three', r.body.claim.transactions.length, 3);
check('no document is on two claims', duplicateMemberships(stored() as never), []);
check('…and every one is still claimed', [tanda, deputy, other].map((b) => getBillByIdAny(b.id)?.status), ['expenseclaim', 'expenseclaim', 'expenseclaim']);

// --- 3. A document on a claim in Xero is not taken off it ------------------------
saveClaimXero(ORG, oct, { xeroInvoiceId: 'inv-oct' });
r = await api(`/${nov}/items`, { items: [asItem(tanda)] });
check('a claim already in Xero keeps its documents', [r.status, r.body.error], [409, 'item_on_locked_claim']);
check('…and nothing moved', claimsHolding(tanda.id), ['GCY AUS Oct']);

// --- 4. The save itself refuses a document on two claims -------------------------
// Whatever path made it, a write that leaves one is refused, not stored.
const cache = stored();
cache.find((c) => c.id === nov)!.transactions.push({ ...asItem(tanda) } as never);
r = await api(`/${nov}/items/update`, { itemIds: [], patch: {} });
check('a write leaving a document on two claims is refused', [r.status, r.body.error], [409, 'item_on_two_claims']);
cache.find((c) => c.id === nov)!.transactions = [];

// The repair's choice of where a stranded duplicate stays.
check('a duplicate stays on the claim in Xero', keeperOf([
  { id: 'a', createdAt: '2026-10-01', approvalStatus: '', xeroInvoiceId: '' },
  { id: 'b', createdAt: '2026-11-01', approvalStatus: '', xeroInvoiceId: 'x' },
] as never), 'b');
check('…else on the claim it was put on first', keeperOf([
  { id: 'b', createdAt: '2026-11-01', approvalStatus: '' },
  { id: 'a', createdAt: '2026-10-01', approvalStatus: '' },
] as never), 'a');
check('duplicates are found per entity', duplicateMemberships([
  { id: 'a', orgId: 'x', deleted: false, transactions: [{ itemId: 'bill_1' }] },
  { id: 'b', orgId: 'x', deleted: false, transactions: [{ itemId: 'bill_1' }] },
  { id: 'c', orgId: 'y', deleted: false, transactions: [{ itemId: 'bill_1' }] },
  { id: 'd', orgId: 'x', deleted: true, transactions: [{ itemId: 'bill_1' }] },
] as never), [{ orgId: 'x', itemId: 'bill_1', claimIds: ['a', 'b'] }]);

// --- 5. The Costs list's status follows the claims --------------------------------
check('status drift: on a claim but not marked, and marked but on none', membershipStatusFixes([
  { id: 'on', status: 'archived' },
  { id: 'off', status: 'expenseclaim' },
  { id: 'fine', status: 'expenseclaim' },
  { id: 'published', status: 'archived', xeroInvoiceId: 'x' },
], new Set(['on', 'fine', 'published'])), { toClaimed: ['on'], toCosts: ['off'] });
updateBill(ORG, deputy.id, { status: 'archived' }); // a client PATCH archives a claimed document
const stray = bill('Stranded', '2026-10-02', 'ready');
updateBill(ORG, stray.id, { status: 'expenseclaim' }); // "In expense claim" on no claim at all
const fixed = syncClaimStatuses(ORG, listBills(ORG));
check('the sync puts both right', fixed, { toClaimed: 1, toArchive: 1 });
check('…the claimed one reads In expense claim again', getBillByIdAny(deputy.id)?.status, 'expenseclaim');
check('…the stranded one is set aside in Archive', getBillByIdAny(stray.id)?.status, 'archived');

// --- 6. Auto Expense claims: a LATE receipt goes on the running period's claim ----
// Intended (Cze, 16 Nov 2026): somebody submitting after a period has closed is
// not let back into that period's claim. The receipt files onto the claim for
// the period now running, and still onto one claim only.
const thisEnd = endOfMonthFor(today);
const [ty, tm] = thisEnd.split('-').map(Number);
const lastEnd = endOfMonthFor(`${tm === 1 ? ty - 1 : ty}-${String(tm === 1 ? 12 : tm - 1).padStart(2, '0')}-01`);
saveCollection('autoClaims', [
  {
    workspaceId: 'cybm', orgId: ORG, endDate: thisEnd, endOfMonth: true, frequency: 'monthly',
    includeInbox: true, userIds: ['emp_gcy'], enrolledAt: { emp_gcy: '2025-01-01T00:00:00.000Z' }, lastRunAt: '',
  },
]);
// Read after last month rolled over, dated inside it — the Tanda / Deputy case.
const late = bill('EPI Capital Pty Ltd', `${lastEnd.slice(0, 8)}27`);
const current = bill('Current month', `${thisEnd.slice(0, 8)}01`);
runAutoClaims('cybm', ORG);
const onClaim = (id: string) => stored().find((c) => !c.deleted && c.transactions.some((t) => String(t.itemId) === id));
check('a late receipt goes on the RUNNING period\'s claim, not its own closed month\'s', onClaim(late.id)?.autoPeriodEnd, thisEnd);
check('…with this month\'s receipt', onClaim(current.id)?.autoPeriodEnd, thisEnd);
check('…each on one claim only', duplicateMemberships(stored() as never), []);

await finish(failures, server);
