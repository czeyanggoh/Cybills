// Taking a document off an expense claim puts it BACK IN COSTS — from the claim
// page (the row's ×, Actions -> Remove) and from the document's own page
// ("Remove from claim") alike.
//
// It used to be set aside in Archive, on the reasoning that coming off a claim
// is a decision the document doesn't belong there. It is — and the document is
// still a cost that has to be published or claimed some other way, so it
// returns to the inbox, Ready where complete.
//
// Three things it must not do. It must not come straight back: Auto Expense claims
// file every inbox document of an enrolled person on the next listing, so a
// document taken off by hand is marked and left alone. And it must not offer a
// cost already in the ledger as unpublished work: a claim whose bill is in Xero
// sets the document aside instead, the line deleting a claim draws. And MOVING
// a document to another claim must leave it on that claim: Move adds it to the
// target and then takes it off the source, through this same route.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-claimreturn-'));
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

const express = (await import('express')).default;
const { ensure, save } = await import('../src/users.ts');
const { claimsRouter, saveClaimXero } = await import('../src/claims.ts');
const { insertBill, getBillByIdAny } = await import('../src/store.ts');
const { runAutoClaims, todayIso, endOfMonthFor } = await import('../src/autoClaims.ts');
const { loadCollection, saveCollection } = await import('../src/jsonStore.ts');

const RED = 'org-red';
const app = express();
app.use(express.json());
app.use('/api/claims', claimsRouter);
const server = app.listen(4647, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

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
const bill = (supplier: string, category = '493 - Travel') =>
  insertBill({
    orgId: RED, fileHash: supplier, fileName: `${supplier}.pdf`, supplier, invoiceNumber: '',
    documentType: '', currency: 'SGD', total: 60, tax: 0, date: today, category,
    createdBy: 'astrid@red.com', owner: 'astrid@red.com', storageKey: '', contentType: 'application/pdf',
    status: 'new', kind: 'cost',
  } as never);

type StoredClaim = { id: string; deleted?: boolean; transactions: { itemId: string }[]; history: { text: string }[] };
const claimOf = (id: string) =>
  loadCollection<StoredClaim>('claims').find((c) => !c.deleted && c.transactions.some((t) => String(t.itemId) === id));

const api = async (path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:4647/api/claims${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': RED },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

const asItem = (b: { id: string; supplier: string }) => ({
  itemId: b.id, date: today, supplier: b.supplier, category: '493 - Travel', net: '60', tax: '0', total: '60',
});

// --- An auto claim's document, taken off by hand ------------------------------
saveCollection('autoClaims', [
  {
    workspaceId: 'cybm', orgId: RED, endDate: endOfMonthFor(today), endOfMonth: true, frequency: 'monthly',
    includeInbox: false, userIds: ['emp_astrid'], enrolledAt: { emp_astrid: '2025-01-01T00:00:00.000Z' }, lastRunAt: '',
  },
]);

const taxi = bill('Taxi');
const lunch = bill('Lunch');
const halfRead = bill('Half Read', '');
runAutoClaims('cybm', RED);
const auto = claimOf(taxi.id);
check('the auto claim takes the document', Boolean(auto), true);
check('…and it leaves the inbox', getBillByIdAny(taxi.id)?.status, 'expenseclaim');

let r = await api(`/${auto!.id}/items/remove`, { itemIds: [taxi.id] });
check('removing it back to Costs succeeds', r.status, 200);
check('it is off the claim', Boolean(claimOf(taxi.id)), false);
// Ready, not New: readiness is derived, so a complete document is not
// presented as something to type in again.
check('and back in Costs, Ready', getBillByIdAny(taxi.id)?.status, 'ready');
check('the claim says where it went', auto && claimOf(lunch.id)?.history[0]?.text, '1 item(s) removed from the expense claim and returned to Costs');

r = await api(`/${auto!.id}/items/remove`, { itemIds: [halfRead.id] });
check('an incomplete one lands in the inbox as it is', getBillByIdAny(halfRead.id)?.status, 'new');

// The sweep rides on every listing. Without the mark the document would be
// back on the claim before anybody had looked at it.
const again = runAutoClaims('cybm', RED);
check('Auto Expense claims leave it alone', [again.items, Boolean(claimOf(taxi.id))], [0, false]);
check('…while the others stay on the claim', Boolean(claimOf(lunch.id)), true);

// --- It can still go onto a claim by hand ------------------------------------
r = await api('/', { name: 'Trip', claimFor: 'Astrid Test' });
const trip = r.body.claim.id as string;
r = await api(`/${trip}/items`, { items: [asItem(taxi)] });
check('a person can put it on another claim', [r.status, getBillByIdAny(taxi.id)?.status], [200, 'expenseclaim']);
check('…which answers the mark', Boolean(getBillByIdAny(taxi.id)?.autoClaimDeclined), false);

// --- Moving between claims is not a removal -----------------------------------
// The claim page's Move adds the items to the target, then removes them from
// the source. The document is the target's by then, and stays claimed.
r = await api('/', { name: 'Second trip', claimFor: 'Astrid Test' });
const second = r.body.claim.id as string;
await api(`/${second}/items`, { items: [asItem(taxi)] });
r = await api(`/${trip}/items/remove`, { itemIds: [taxi.id] });
check('a moved document comes off the source', r.body.claim.transactions.length, 0);
check('…and stays claimed, on the target', [getBillByIdAny(taxi.id)?.status, claimOf(taxi.id)?.id], ['expenseclaim', second]);
check('…with nothing said about Costs', r.body.claim.history[0].text, '1 item(s) removed from the expense claim');

// --- Only what THIS claim was holding ----------------------------------------
// An id named in the request that sits on another claim keeps its place.
r = await api(`/${trip}/items/remove`, { itemIds: [lunch.id] });
check('a document on another claim is not touched', [getBillByIdAny(lunch.id)?.status, Boolean(claimOf(lunch.id))], ['expenseclaim', true]);

// --- A claim whose bill is in Xero -------------------------------------------
// Its money is in the ledger as a line of that bill until the claim is updated
// there. Back in the inbox it would read as unpublished work.
{
  const posted = bill('Posted Supplier');
  // Out of the auto sweep's reach, so the claim it goes on is the one named.
  r = await api('/', { name: 'Published trip', claimFor: 'Astrid Test' });
  const postedClaim = r.body.claim.id as string;
  const on = claimOf(posted.id);
  if (on) await api(`/${on.id}/items/remove`, { itemIds: [posted.id] });
  await api(`/${postedClaim}/items`, { items: [asItem(posted)] });
  check('the document is on the published claim', getBillByIdAny(posted.id)?.status, 'expenseclaim');
  saveClaimXero(RED, postedClaim, { xeroInvoiceId: 'inv-77', xeroTenantName: 'Red Alpha', xeroPostedAt: '2026-08-20' });

  r = await api(`/${postedClaim}/items/remove`, { itemIds: [posted.id] });
  check('it comes off a published claim', [r.status, Boolean(claimOf(posted.id))], [200, false]);
  check('…and is set aside, not offered as unpublished work', getBillByIdAny(posted.id)?.status, 'archived');
}

// --- An approved claim is locked ---------------------------------------------
{
  const held = bill('Held Supplier');
  r = await api('/', { name: 'Approved trip', claimFor: 'Astrid Test' });
  const heldClaim = r.body.claim.id as string;
  await api(`/${heldClaim}/items`, { items: [asItem(held)] });
  const all = loadCollection<StoredClaim & { approvalStatus: string }>('claims');
  all.find((c) => c.id === heldClaim)!.approvalStatus = 'approved';
  saveCollection('claims', all);
  r = await api(`/${heldClaim}/items/remove`, { itemIds: [held.id] });
  check('an approved claim refuses', [r.status, r.body.error], [409, 'claim_locked']);
  check('…and the document stays on it', getBillByIdAny(held.id)?.status, 'expenseclaim');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
await finish(failures, server);
