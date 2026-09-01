// Deleting an expense claim hands its documents back to the Costs tab.
//
// It used to delete them permanently, files included, on the reasoning that they
// were captured to be claimed and had nothing left to be. That is wrong about
// what they ARE: the spending happened whether or not the claim survived, and the
// ordinary reason a claim is deleted is that it was raised WRONGLY — wrong
// person, wrong period, wrong items — every one of which ends with those receipts
// needing to go on a different claim.
//
// Two boundaries matter as much as the behaviour. Removing ONE ITEM is a
// different act ("this doesn't belong on this claim") and sends the document to
// Archive, not to the top of the inbox. And a claim that reached XERO has its
// money in the ledger already, so ITS documents are archived rather than offered
// as work — putting them back would invite publishing the same spending twice.
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
const { saveClaimXero } = await import('../src/claims.ts');

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

// --- Deleting the claim frees its documents ----------------------------------
r = await api(`/${claimId}`, 'DELETE');
check('the claim is deleted', r.status, 200);
// Back in the Costs tab, and READY rather than New: readiness is derived from
// the document, so a complete one is not presented as work to type in again.
check('the receipts on it come back', getBillByIdAny(doomed.id)?.status, 'ready');
check('all of them', getBillByIdAny(alsoShared.id)?.status, 'ready');
check('and nothing was destroyed', listBills('cybm').length, 4);
check('…their files included', getBillByIdAny(doomed.id)?.storageKey, 'r2:bills/cybm/doomed.pdf');
// The one taken off the claim first was never on it when it went, so it stays
// where removing an item put it.
check('the one removed beforehand is untouched', getBillByIdAny(spared.id)?.status, 'archived');
// And a document that was never on the claim is nobody's business.
// 'ready' because it was complete when it was created and has never moved —
// readiness is derived, so this is where insertBill left it.
check('an unrelated document is untouched', getBillByIdAny(kept.id)?.status, 'ready');

// --- A PUBLISHED claim's documents go to Archive instead ---------------------
// Its money is in the ledger already, as the lines of the claim's own bill.
// Back in the inbox they would look like unpublished work, and publishing them
// pays the same spending a second time.
{
  const posted = bill('Posted Supplier', 'r2:bills/cybm/posted.pdf');
  let p = await api('', 'POST', { name: 'Published trip', claimFor: 'Someone' });
  const postedClaim = p.body.claim.id as string;
  await api(`/${postedClaim}/items`, 'POST', { items: [asItem(posted)] });
  check('the document is on the published claim', getBillByIdAny(posted.id)?.status, 'expenseclaim');
  // The claim's own scope, which for the primary entity is the legacy 'cybm'
  // one rather than the org id the header names (dataScopeForOrg).
  saveClaimXero('cybm', postedClaim, { xeroInvoiceId: 'inv-77', xeroTenantName: 'CYBM', xeroPostedAt: '2026-08-20' });

  p = await api(`/${postedClaim}`, 'DELETE');
  check('a published claim deletes', p.status, 200);
  check('…and its document is set aside, not offered again', getBillByIdAny(posted.id)?.status, 'archived');
  check('…still there', listBills('cybm').length, 5);
}

server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
