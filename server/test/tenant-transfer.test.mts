// A document billed to one client, filed under another — and the button that
// moves it.
//
// A colleague who works across several client entities uploads into whichever
// one happens to be open, so a Red Alpha invoice lands in CY Business
// Management's Costs book and nothing notices. The document names its own
// entity on its face ("Bill To: RED ALPHA CYBERSECURITY PTE. LTD."), and this
// covers both halves: that the listing says so, and that the transfer moves the
// document without carrying across anything that only meant something in the
// book it left.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-transfer-'));
process.env.BILLS_DATA_DIR = DATA_DIR;

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CY Business Management Pte. Ltd.', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha Cybersecurity', tenantId: 't-red', tenantName: 'Red Alpha Cybersecurity Pte Ltd', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const { billsRouter } = await import('../src/bills.ts');
const { insertBill, listBills, markBillPosted, markBillsClaimed } = await import('../src/store.ts');

const bill = (over: Record<string, unknown>) =>
  insertBill({
    orgId: 'cybm', kind: 'cost', status: 'ready', documentType: 'Invoice', currency: 'SGD',
    supplier: 'Singtel', date: '2026-08-20', total: '120', tax: '9.90',
    category: '489 - Telephone', categoryReason: 'Telco bill', taxRate: 'Standard-Rated Purchases',
    taxRateReason: '9% printed', project: 'HQ', customer: 'Acme', paymentMethod: 'DBS Current',
    description: 'Monthly mobile', ...over,
  } as any);

// Billed to Red Alpha, sitting in CY Business Management's book.
const stray = bill({
  invoiceNumber: 'S-100',
  billedTo: 'RED ALPHA CYBERSECURITY PTE. LTD.',
  lineItems: [{ description: 'Mobile plan', category: '489 - Telephone', project: 'HQ', project2: 'Ops', net: '110.10', tax: '9.90', total: '120.00' }],
});
// Billed to the entity it is already in — the ordinary case, and the one that
// must stay silent.
const athome = bill({ invoiceNumber: 'S-101', billedTo: 'CY Business Management Pte Ltd' });
// A till receipt names no recipient at all, which is most of them.
const anonymous = bill({ invoiceNumber: 'S-102', billedTo: '' });
// Already in the ledger. It is just as misfiled, and just as unmovable.
const published = bill({ invoiceNumber: 'S-103', billedTo: 'Red Alpha Cybersecurity Pte Ltd' });
markBillPosted('cybm', published.id, { xeroInvoiceId: 'inv-1', xeroTenantId: 't-cybm', xeroTenantName: 'CYBM' });
// On somebody's expense claim, which belongs to the entity it was raised in.
const claimed = bill({ invoiceNumber: 'S-104', billedTo: 'Red Alpha Cybersecurity Pte Ltd' });
markBillsClaimed([claimed.id]);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/costs', billsRouter);
const server = app.listen(4641, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const call = async (method: string, path: string, org: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:4641${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': org },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const list = async (org: string) => (await call('GET', '/api/costs/bills', org)).body.bills as any[];
const rowIn = async (org: string, id: string) => (await list(org)).find((b) => b.id === id);

// --- Saying so ---------------------------------------------------------------
let row = await rowIn('org-cybm', stray.id);
check('a Red Alpha invoice in CYBM is named as Red Alpha’s', row.misfiledTo, {
  orgId: 'org-red',
  name: 'Red Alpha Cybersecurity',
  exact: true,
});
check('a document billed to the entity it is in says nothing', (await rowIn('org-cybm', athome.id)).misfiledTo, undefined);
check('a receipt naming no recipient says nothing', (await rowIn('org-cybm', anonymous.id)).misfiledTo, undefined);
// Its figures are in CYBM's ledger under an invoice id this book still points
// at, so a badge here would only offer a button that has to refuse.
check('a published document is never flagged', (await rowIn('org-cybm', published.id)).misfiledTo, undefined);
check('nor is one sitting on a claim', (await rowIn('org-cybm', claimed.id)).misfiledTo, undefined);

// The detail page rebuilds itself from whichever response arrived last, so the
// flag has to ride on the by-id read and on a save, not only on the listing.
check(
  'the by-id read carries it too',
  (await call('GET', `/api/costs/bills/${stray.id}`, 'org-cybm')).body.bill.misfiledTo?.orgId,
  'org-red'
);
check(
  '…and so does the reply to a save',
  (await call('PATCH', `/api/costs/bills/${stray.id}`, 'org-cybm', { note: 'checked' })).body.bill.misfiledTo?.orgId,
  'org-red'
);

// --- Refusing ----------------------------------------------------------------
let r = await call('POST', '/api/costs/bills/transfer', 'org-cybm', { ids: [stray.id], toOrgId: 'org-nope' });
check('an entity that does not exist is refused', [r.status, r.body.error], [404, 'organisation_not_found']);

r = await call('POST', '/api/costs/bills/transfer', 'org-cybm', { ids: [published.id, claimed.id], toOrgId: 'org-red' });
check('a published document and a claimed one do not move', r.body.moved, []);
check('…and each says why', r.body.skipped, [
  { id: published.id, reason: 'published' },
  { id: claimed.id, reason: 'on_a_claim' },
]);
check('the published one is still in CYBM', listBills('cybm').some((b) => b.id === published.id), true);

// --- Moving ------------------------------------------------------------------
r = await call('POST', '/api/costs/bills/transfer', 'org-cybm', { ids: [stray.id], toOrgId: 'org-red' });
check('the stray moves', [r.status, r.body.moved], [200, [stray.id]]);
check('…and the reply names where it went', r.body.organisation, { id: 'org-red', name: 'Red Alpha Cybersecurity' });
check('it has left CYBM’s book', (await list('org-cybm')).some((b) => b.id === stray.id), false);

row = await rowIn('org-red', stray.id);
check('it is in Red Alpha’s book', Boolean(row), true);
// The document itself is untouched: it is the same paper, for the same money.
check('the supplier came across', row.supplier, 'Singtel');
check('…the figures too', [row.total, row.tax], ['120', '9.90']);
check('…and its line items', row.lineItems.length, 1);
check('…including what they are worth', [row.lineItems[0].net, row.lineItems[0].total], ['110.10', '120.00']);
// Everything that named CYBM's own Xero lists is gone: a code from one chart is
// a different account in another, or no account at all.
check('the category is cleared', [row.category, row.categoryReason], ['', '']);
check('the tax code is cleared', [row.taxRate, row.taxRateReason], ['', '']);
check('the project, customer and payment account are cleared', [row.project, row.customer, row.paymentMethod], ['', '', '']);
check('…and so are the lines’ own', [row.lineItems[0].category, row.lineItems[0].project, row.lineItems[0].project2], ['', '', '']);
// Nobody has decided a tax code HERE yet, so the new book's backfill must be
// free to. Left set, the field would stay blank for good.
check('nothing is recorded as a deliberate blank', Boolean(row.taxRateCleared), false);
check('it lands in To review, waiting to be coded', row.status, 'new');
check('and it is no longer in the wrong place', row.misfiledTo, undefined);
// The file stays exactly where it was: a storage key is an opaque handle, and
// identical uploads share one object.
check('the stored file is untouched', row.storageKey, stray.storageKey);

// Moving it again to where it already is changes nothing, and says so rather
// than reporting a move that did not happen.
r = await call('POST', '/api/costs/bills/transfer', 'org-red', { ids: [stray.id], toOrgId: 'org-red' });
check('moving it to where it already is', [r.body.moved, r.body.skipped], [[], [{ id: stray.id, reason: 'already_there' }]]);

// --- A merged document takes its pages with it -------------------------------
const pageOne = bill({ invoiceNumber: 'M-1', status: 'merged', billedTo: '' });
const pageTwo = bill({ invoiceNumber: 'M-2', status: 'merged', billedTo: '' });
const combined = bill({ invoiceNumber: 'M-1', billedTo: 'Red Alpha Cybersecurity Pte Ltd', mergedFrom: [pageOne.id, pageTwo.id] });
r = await call('POST', '/api/costs/bills/transfer', 'org-cybm', { ids: [combined.id], toOrgId: 'org-red' });
check('the merged document moves with its pages', r.body.moved.sort(), [combined.id, pageOne.id, pageTwo.id].sort());
check('…so Unmerge still finds them', listBills('org-red').filter((b) => [pageOne.id, pageTwo.id].includes(b.id)).length, 2);
// A page is not a document of its own: the document that combined it decides
// where it lives, so asking to move one alone is refused.
r = await call('POST', '/api/costs/bills/transfer', 'org-red', { ids: [pageOne.id], toOrgId: 'org-cybm' });
check('a page cannot be moved on its own', r.body.skipped, [{ id: pageOne.id, reason: 'merged_into_another' }]);

server.close();
console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
