// Deleting an expense claim deletes the receipts that were on it.
//
// The practice's call, and the destructive one — a claim thrown away takes its
// paperwork with it rather than seeding the inbox with work somebody has to
// clear again. So the boundary matters as much as the behaviour: removing ONE
// ITEM from a claim is a different act ("this doesn't belong on this claim")
// and must never destroy anything.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-claimdel-'));
process.env.BILLS_DATA_DIR = DATA_DIR;

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'CYBM', tenantId: 't-1', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const { claimsRouter } = await import('../src/claims.ts');
const { insertBill, listBills, getBillByIdAny, markBillsClaimed, unmarkBillsClaimed } = await import('../src/store.ts');

const app = express();
app.use(express.json());
app.use('/api/claims', claimsRouter);
const server = app.listen(4631, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const bill = (supplier: string, storageKey: string) =>
  insertBill({
    orgId: 'cybm', fileHash: supplier, fileName: `${supplier}.pdf`, supplier, invoiceNumber: '',
    documentType: '', currency: 'SGD', total: 10, tax: 0, date: '2026-08-01', category: '493 - Travel',
    createdBy: 'a@b.c', owner: 'a@b.c', storageKey, contentType: 'application/pdf',
    status: 'new', kind: 'cost',
  });

const api = async (path: string, method: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:4631/api/claims${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': 'org_one0001' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

// Two documents share one stored file — identical uploads are stored once, and
// reclaiming that object because one of them was deleted would blank the other.
const kept = bill('Kept Supplier', 'r2:bills/cybm/shared.pdf');
const alsoShared = bill('Twin Supplier', 'r2:bills/cybm/shared.pdf');
const doomed = bill('Doomed Supplier', 'r2:bills/cybm/doomed.pdf');
const spared = bill('Spared Supplier', 'r2:bills/cybm/spared.pdf');

let r = await api('', 'POST', { name: 'Trip', claimFor: 'Someone' });
const claimId = r.body.claim.id as string;
check('a claim is created', Boolean(claimId), true);

const asItem = (b: { id: string; supplier: string }) => ({
  itemId: b.id, date: '2026-08-01', supplier: b.supplier, category: '493 - Travel',
  net: '10', tax: '0', total: '10',
});
r = await api(`/${claimId}/items`, 'POST', { items: [doomed, spared, alsoShared].map(asItem) });
check('three documents go onto it', r.status, 200);
check('and are marked as claimed', getBillByIdAny(doomed.id)?.status, 'expenseclaim');

// --- Removing one item is not destructive ------------------------------------
r = await api(`/${claimId}/items/remove`, 'POST', { itemIds: [spared.id] });
check('removing an item succeeds', r.status, 200);
const sparedAfter = getBillByIdAny(spared.id);
check('the document survives', Boolean(sparedAfter), true);
// Archive, not the inbox: coming off a claim is a decision it doesn't belong
// there, and putting it back on top of the inbox makes it look like new work.
check('and goes to Archive', sparedAfter?.status, 'archived');

// --- Deleting the claim takes its receipts -----------------------------------
r = await api(`/${claimId}`, 'DELETE');
check('the claim is deleted', r.status, 200);
check('the receipts on it are gone', getBillByIdAny(doomed.id), null);
check('all of them', getBillByIdAny(alsoShared.id), null);
// The one taken off the claim first was never on it when it went.
check('the one removed beforehand is untouched', getBillByIdAny(spared.id)?.status, 'archived');
// And a document that was never on the claim is nobody's business.
check('an unrelated document is untouched', getBillByIdAny(kept.id)?.supplier, 'Kept Supplier');
check('the book holds exactly what is left', listBills('cybm').length, 2);

server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
