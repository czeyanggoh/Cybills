// A document filed in the wrong client's book, and the move that repairs it.
//
// Which entity a document lands in is decided by provenance — who uploaded it
// and where they were standing, which address it was emailed to, which WhatsApp
// group it came through — and nothing had ever read the paper. So a United
// Engineers invoice made out to Dart Consulting, sitting in Red Alpha's book,
// looked exactly like a correct one: it would publish into Red Alpha's ledger,
// coded against Red Alpha's chart, claiming Red Alpha's input tax on a supply
// made to somebody else.
//
// Covers the verdict arriving with the listing, the move itself, what the move
// deliberately does NOT carry across, and the three refusals — each of which is
// a way of accounting for one payment twice.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-entity-'));
process.env.BILLS_DATA_DIR = DATA_DIR;

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha Cybersecurity Pte. Ltd.', tenantId: 't-red', tenantName: 'Red Alpha', createdAt: new Date(1).toISOString(), createdBy: '' },
      { id: 'org-dart', orgId: 'cybm', name: 'Dart Consulting and Training Pte Ltd', tenantId: 't-dart', tenantName: 'Dart Consulting', createdAt: new Date(2).toISOString(), createdBy: '' },
      { id: 'org-ste', orgId: 'cybm', name: 'Red Alpha - ST Engineering', tenantId: '', tenantName: '', kind: 'standalone', parentOrgId: 'org-red', createdAt: new Date(3).toISOString(), createdBy: '' },
    ],
  })
);

// Each entity's own registered details, as Business profile holds them. Written
// before the first read: the settings collection is cached in memory on first
// load, exactly as it is in the running app.
writeFileSync(
  join(DATA_DIR, 'settings.json'),
  JSON.stringify({
    items: [
      { workspaceId: 'cybm', key: 'cybills.business-profile.v1::org-red', value: { businessName: 'Red Alpha Cybersecurity Pte. Ltd.', taxNumber: '201614382R' } },
      { workspaceId: 'cybm', key: 'cybills.business-profile.v1::org-dart', value: { businessName: 'Dart Consulting and Training Pte Ltd', taxNumber: '199912345K' } },
    ],
  })
);

const express = (await import('express')).default;
const { billsRouter } = await import('../src/bills.ts');
const { insertBill, updateBill, getBillByIdAny } = await import('../src/store.ts');
const { generalUserFor, ensure } = await import('../src/users.ts');

ensure('cybm'); // every linked entity gets its general account on load
const generalOf = (org: string) => generalUserFor('cybm', org)!.email;

// Red Alpha is not the primary entity, so its book is its own scope.
const RED = 'org-red';
const DART = 'org-dart';

const bill = (over: Record<string, unknown> = {}) =>
  insertBill({
    orgId: RED, kind: 'cost', status: 'new', documentType: 'Invoice', currency: 'SGD',
    supplier: 'UNITED ENGINEERS LIMITED', invoiceNumber: '2612-00221', total: '37060', tax: '3060',
    date: '2026-09-01', category: '4014 - Rent - Office', taxRate: 'Standard-Rated Purchases',
    description: 'Office rent', billedTo: 'DART CONSULTING AND TRAINING PTE LTD',
    // Uploaded by a colleague working on Red Alpha, so it belongs to Red Alpha's
    // own general account — which is the ordinary case, and the one whose
    // internal address means nothing in anybody else's book.
    owner: generalUserFor('cybm', RED)!.email,
    ...over,
  } as any);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/costs', billsRouter);
const server = app.listen(4631, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const call = async (method: string, path: string, org: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:4631${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': org },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const listed = async (id: string, org: string) =>
  (await call('GET', '/api/costs/bills', org)).body.bills.find((b: any) => b.id === id);

// --- 1) The listing says so -------------------------------------------------
//
// On the ROW, because a document nobody opens is exactly the one that gets
// published into the wrong ledger.
const misfiled = bill();
let row = await listed(misfiled.id, RED);
check('the row says it is billed to somebody else', row.entityCheck.status, 'mismatch');
check('…naming who', row.entityCheck.billedTo, 'DART CONSULTING AND TRAINING PTE LTD');
check('…and where CYBills holds their book', row.entityCheck.candidates, [
  { id: 'org-dart', name: 'Dart Consulting and Training Pte Ltd' },
]);

// A document billed to the entity it is filed under says nothing, and neither
// does one naming nobody — which is most receipts.
const ours = bill({ billedTo: 'Red Alpha Cybersecurity Pte Ltd' });
const anonymous = bill({ billedTo: '' });
check('billed to us is fine', (await listed(ours.id, RED)).entityCheck.status, 'ok');
check('a till receipt is not flagged', (await listed(anonymous.id, RED)).entityCheck.status, 'unknown');

// --- 2) "This is right" settles it for good ---------------------------------
//
// An intercompany recharge, a trading name, a group company paying for a
// subsidiary — all look like this and are all correct, so a warning nobody can
// silence is one everybody learns to scroll past.
const legitimate = bill({ billedTo: 'DART CONSULTING AND TRAINING PTE LTD' });
await call('PATCH', `/api/costs/bills/${legitimate.id}`, RED, { entityCheckDismissed: true });
check('a confirmed document stops asking', (await listed(legitimate.id, RED)).entityCheck.status, 'dismissed');

// --- 3) The move ------------------------------------------------------------
let r = await call('POST', `/api/costs/bills/${misfiled.id}/move-entity`, RED, { orgId: DART });
check('it moves', r.status, 200);
check('…into the entity it names', r.body.orgName, 'Dart Consulting and Training Pte Ltd');
check('…and out of the book it was in', await listed(misfiled.id, RED), undefined);
row = await listed(misfiled.id, DART);
check('…into the one it belongs to', Boolean(row), true);
check('…where nothing is wrong with it any more', row.entityCheck.status, 'ok');

// What travels is the document; what does NOT is everything coded against the
// entity it has left. An account code carried across would post this bill to an
// account of the same number meaning something else entirely.
check('the supplier travels', row.supplier, 'UNITED ENGINEERS LIMITED');
check('…and the money', row.total, '37060');
check('…and its number', row.displayId, misfiled.displayId);
check('the category does not', row.category, '');
check('…nor the tax code', row.taxRate, '');
check('it arrives as work to do', row.status, 'new');
check('and it says where it came from', row.movedFrom.orgName, 'Red Alpha Cybersecurity Pte. Ltd.');

// An owner is a person on one entity's roster, not a fact about the paper. Red
// Alpha's general account is an INTERNAL identity naming an organisation this
// book has never heard of — carried across, it turned up in the owner picker as
// a raw `org_….general@cybills.local` above the real people, looking like a
// person somebody had added.
check('the owner becomes the entity it arrived in', row.owner, generalOf(DART));
check('…and not the one it came from', row.owner === generalOf(RED), false);
// Who UPLOADED it is a fact about the past and does not stop being true.
check('the uploader is untouched', row.createdBy, misfiled.createdBy);

// --- 4) The refusals --------------------------------------------------------
//
// Each one is a way of accounting for one payment twice, and each is a state the
// reviewer can undo first — so the message is the instruction.
const published = bill({ xeroInvoiceId: 'inv-1', status: 'archived' });
r = await call('POST', `/api/costs/bills/${published.id}/move-entity`, RED, { orgId: DART });
check('a published bill is refused', r.body.error, 'published');
check('…and stays where it is', getBillByIdAny(published.id)!.orgId, RED);

const claimed = bill({ status: 'expenseclaim' });
r = await call('POST', `/api/costs/bills/${claimed.id}/move-entity`, RED, { orgId: DART });
check('one on an expense claim is refused', r.body.error, 'on_claim');

const merged = bill({ status: 'merged' });
r = await call('POST', `/api/costs/bills/${merged.id}/move-entity`, RED, { orgId: DART });
check('one merged away is refused', r.body.error, 'merged');

r = await call('POST', `/api/costs/bills/${ours.id}/move-entity`, RED, { orgId: RED });
check('moving it to where it already is is refused', r.body.error, 'same_entity');

r = await call('POST', `/api/costs/bills/${ours.id}/move-entity`, RED, { orgId: 'org-nowhere' });
check('an entity that does not exist answers 404', r.status, 404);

// --- 5) A sales invoice is never checked ------------------------------------
//
// It is billed to the customer — that is what a sales invoice IS — so checking
// them would badge the whole Sales book as misfiled.
const sale = bill({ kind: 'sales', billedTo: 'Dart Consulting and Training Pte Ltd' });
check('a sales invoice is left alone', (await listed(sale.id, RED)).entityCheck.status, 'unknown');

// --- 6) A bridge entity is not checked --------------------------------------
//
// It holds other people's paperwork by design: ST Engineering staff claim
// against Red Alpha's ledger, and their receipts name themselves, their
// employer, or nobody. Checking it would flag everything in it.
const onBridge = bill({ orgId: 'org-ste', billedTo: 'ST Engineering Land Systems Ltd' });
check('the bridge entity flags nothing', (await listed(onBridge.id, 'org-ste')).entityCheck.status, 'unknown');

// --- 7) The documents moved before any of that ------------------------------
//
// They are sitting in their new book still owned by the old one's general
// account, so the listing repairs them the way it repairs owners and stale
// claim names — narrowly: an INTERNAL address this entity cannot place, never a
// real external one, which is somebody we simply don't know here.
const stranded = bill({ orgId: DART, owner: generalOf(RED), billedTo: '' });
const outsider = bill({ orgId: DART, owner: 'someone@another-company.com', billedTo: '' });
await call('GET', '/api/costs/bills', DART);
check('a foreign general account is repaired', getBillByIdAny(stranded.id)!.owner, generalOf(DART));
check('a real address is left alone', getBillByIdAny(outsider.id)!.owner, 'someone@another-company.com');

// --- 8) The background reads can store it at all -----------------------------
//
// An emailed or WhatsApp'd document is read where nobody is watching, and that
// road writes the addressee through the same patch that carries
// `supplierGstRegNo` — which is silently dropped, because it is not a field a
// person may edit. A field stored beside it would vanish exactly as quietly.
updateBill(RED, anonymous.id, {
  billedTo: 'DART CONSULTING AND TRAINING PTE LTD',
  billedToRegNo: '199912345K',
} as any);
check('a background read can store the addressee', getBillByIdAny(anonymous.id)!.billedTo, 'DART CONSULTING AND TRAINING PTE LTD');
check('…and the buyer’s own number with it', getBillByIdAny(anonymous.id)!.billedToRegNo, '199912345K');

// --- 9) A re-read may take the addressee off again --------------------------
//
// The write path has to accept a blank, or a name misread once could never be
// corrected and the warning it raised would stand for ever.
await call('PATCH', `/api/costs/bills/${ours.id}`, RED, { billedTo: '' });
check('a blank bill-to can be written', updateBill(RED, ours.id, {})!.billedTo, '');

server.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
