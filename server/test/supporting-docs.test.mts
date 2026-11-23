// Supporting documents: the receipts or expense reports sent in WITH the invoice
// that recharges them.
//
// Red Alpha emails Dart one invoice and the three expense reports it is made up
// of. All four are read as costs, and published as they stand the same spending
// goes into Dart's ledger twice. Driven over real HTTP against the real routers,
// so what is asserted is what the listing does by itself, what the store ends up
// holding, and what the publish road refuses.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-supporting-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'test-key';
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4799'; // nothing listens: no test here may reach Xero

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-dart', orgId: 'cybm', name: 'Dart Consulting and Training Pte Ltd', tenantId: 't-dart', tenantName: 'Dart Consulting', createdAt: new Date(2).toISOString(), createdBy: '' },
    ],
  })
);
writeFileSync(
  join(DATA_DIR, 'settings.json'),
  JSON.stringify({
    items: [
      { workspaceId: 'cybm', key: 'cybills.business-profile.v1::org-dart', value: { businessName: 'Dart Consulting and Training Pte Ltd', taxNumber: '199912345K' } },
    ],
  })
);

const express = (await import('express')).default;
const { billsRouter } = await import('../src/bills.ts');
const { xeroRouter } = await import('../src/xero.ts');
const { insertBill, getBillById } = await import('../src/store.ts');

const DART = 'org-dart';
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/costs', billsRouter);
app.use('/api/xero', xeroRouter);
const server = app.listen(4798, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:4798${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': DART },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const list = async () => (await call('GET', '/api/costs/bills')).body.bills as any[];
const stored = (id: string) => getBillById(DART, id)!;

let mailNo = 0;
const mailed = () => {
  mailNo += 1;
  return { from: 'finance@dart.com.sg', to: 'dart@cybills.sg', subject: `Red Alpha recharge ${mailNo}`, date: `2026-11-${10 + mailNo}T02:00:00.000Z`, text: 'Invoice and supporting attached.' };
};
const bill = (over: Record<string, unknown>) =>
  insertBill({
    orgId: DART, kind: 'cost', status: 'new', documentType: 'Receipt', currency: 'SGD', supplier: 'Somebody', invoiceNumber: '',
    total: 0, tax: 0, date: '2026-10-31', category: '4302 - General Expense', taxRate: 'No Tax', description: '', fileHash: `h${Math.random()}`,
    fileName: 'doc.pdf', storageKey: '', contentType: '', createdBy: 'finance@dart.com.sg', categoryReason: '', projectReason: '', taxRateReason: '',
    ...over,
  } as any);
// One mail: Red Alpha's invoice to Dart, with a management fee on top, and the
// three expense reports it recharges.
const arrival = (over: { main?: Record<string, unknown>; third?: Record<string, unknown> } = {}) => {
  const email = mailed();
  const main = bill({
    email, documentType: 'Invoice', supplier: 'Red Alpha Cybersecurity Pte. Ltd.', invoiceNumber: `INV-${mailNo}`, total: 11590.36,
    billedTo: 'DART CONSULTING AND TRAINING PTE LTD',
    readLines: [
      { description: 'Roy Shumel expenses', total: 80.78, net: 0 },
      { description: 'Sefi Kirshberg expenses', total: 746.6, net: 0 },
      { description: 'Yoav Korman expenses', total: 9687.35, net: 0 },
      { description: 'Management fee', total: 1075.63, net: 0 },
    ],
    ...over.main,
  });
  const roy = bill({ email, supplier: 'ROY SHUMEL', total: 80.78, date: '2026-01-07' });
  const sefi = bill({ email, supplier: 'sefi kirshberg', total: 746.6, date: '2025-12-26' });
  const yoav = bill({ email, supplier: 'Yoav Korman', total: 9687.35, date: '2025-11-26', ...over.third });
  return { main, roy, sefi, yoav };
};

// --- 1) The listing links a firm group by itself -------------------------------
let a = arrival();
check('all four land complete, so each starts out Ready', [a.main, a.roy, a.sefi, a.yoav].map((b) => b.status), ['ready', 'ready', 'ready', 'ready']);
let rows = await list();
const row = (id: string) => rows.find((b) => b.id === id);
check('the three are set aside', [a.roy, a.sefi, a.yoav].map((b) => row(b.id).status), ['archived', 'archived', 'archived']);
check('each names the invoice that carries its money', row(a.roy.id).supportingFor?.billId, a.main.id);
check('…and the line it is', row(a.sefi.id).supportingFor?.line, 'Sefi Kirshberg expenses');
check('…linked automatically, remembering where it was', [row(a.roy.id).supportingFor?.auto, row(a.roy.id).supportingFor?.before], [true, { status: 'ready' }]);
check('the invoice stays in the inbox, naming the three', [row(a.main.id).status, [...row(a.main.id).supportingDocs].sort()], ['ready', [a.roy.id, a.sefi.id, a.yoav.id].sort()]);
check('the invoice is billed to this entity, which is what made it the invoice', row(a.main.id).entityCheck.status, 'ok');

// --- 2) A supporting document is never published on its own ----------------------
let r = await call('POST', `/api/xero/organisations/${DART}/publish-bill`, { billId: a.roy.id, accountCode: '4302', taxType: 'NONE', status: 'AUTHORISED' });
check('publishing one is refused', [r.status, r.body.error], [409, 'supporting_document']);

// --- 3) Seen from either side ---------------------------------------------------
r = await call('GET', `/api/costs/bills/${a.roy.id}/supporting`);
check('the supporting document names its invoice', [r.body.kind, r.body.main?.id, r.body.link?.auto], ['support', a.main.id, true]);
r = await call('GET', `/api/costs/bills/${a.main.id}/supporting`);
check('the invoice lists what is behind it', [r.body.kind, r.body.supports.map((s: any) => s.id).sort(), r.body.suggestions], ['main', [a.roy.id, a.sefi.id, a.yoav.id].sort(), []]);

// --- 4) Undo, and it is not linked again behind somebody's back ------------------
r = await call('POST', `/api/costs/bills/${a.roy.id}/supporting/remove`, {});
check('undone from the supporting document', [r.status, r.body.released.map((x: any) => x.id)], [200, [a.roy.id]]);
check('it is back where it was', [stored(a.roy.id).status, stored(a.roy.id).supportingFor], ['ready', undefined]);
check('the invoice no longer names it', [...(stored(a.main.id).supportingDocs ?? [])].sort(), [a.sefi.id, a.yoav.id].sort());
rows = await list();
check('the next listing does not link it again', [row(a.roy.id).status, row(a.roy.id).supportingFor ?? null], ['ready', null]);
r = await call('GET', `/api/costs/bills/${a.main.id}/supporting`);
check('nor is it offered again', r.body.suggestions, []);

// --- 5) A weaker group is only offered -------------------------------------------
// The third document's figure is on no line of the invoice, so the mail is not
// wholly accounted for: nothing is linked, and the two that tie are suggested.
a = arrival({ third: { total: 9000 } });
rows = await list();
check('nothing is set aside by itself', [a.roy, a.sefi, a.yoav].map((b) => row(b.id).status), ['ready', 'ready', 'ready']);
r = await call('GET', `/api/costs/bills/${a.main.id}/supporting`);
check('the two that tie are offered on the invoice', r.body.suggestions.map((s: any) => s.id).sort(), [a.roy.id, a.sefi.id].sort());
r = await call('POST', `/api/costs/bills/${a.main.id}/supporting/decline`, { billIds: [a.roy.id, a.sefi.id] });
check('Keep separate is recorded', [r.status, r.body.declined], [200, 2]);
r = await call('GET', `/api/costs/bills/${a.main.id}/supporting`);
check('and the suggestion is gone', r.body.suggestions, []);

// --- 6) By hand: an invoice showing one lump sum has no line to tie to -----------
a = arrival({ main: { readLines: [] } });
rows = await list();
check('with no lines, nothing is linked or offered', [a.roy, a.sefi, a.yoav].map((b) => row(b.id).status), ['ready', 'ready', 'ready']);
r = await call('POST', `/api/costs/bills/${a.main.id}/supporting`, { billIds: [a.roy.id, a.sefi.id, a.yoav.id] });
check('a person names them', [r.status, r.body.supports.length], [200, 3]);
check('each is set aside, marked as linked by hand', [stored(a.yoav.id).status, stored(a.yoav.id).supportingFor?.auto, stored(a.yoav.id).supportingFor?.reasons], ['archived', false, ['manual']]);
r = await call('POST', `/api/costs/bills/${a.roy.id}/supporting`, { billIds: [a.main.id] });
check('a supporting document cannot have supporting documents of its own', [r.status, r.body.error], [409, 'is_supporting']);
const claimed = bill({ supplier: 'On a claim', total: 12, status: 'expenseclaim' });
r = await call('POST', `/api/costs/bills/${a.main.id}/supporting`, { billIds: [claimed.id] });
check('a document on an expense claim is refused, by name', [r.status, r.body.error, String(r.body.message).includes('is on an expense claim')], [409, 'cannot_support', true]);

// --- 7) Pulled back out by hand is an Undo ---------------------------------------
r = await call('PATCH', `/api/costs/bills/${a.sefi.id}`, { status: 'new' });
rows = await list();
check('Unarchive on a supporting document releases it', [row(a.sefi.id).supportingFor ?? null, [...row(a.main.id).supportingDocs].sort()], [null, [a.roy.id, a.yoav.id].sort()]);

// --- 8) Deleting the invoice hands its backup back ----------------------------------
r = await call('DELETE', `/api/costs/bills/${a.main.id}`);
check('the invoice is deleted', r.status, 200);
check('and its supporting documents are costs of their own again', [stored(a.roy.id).status, stored(a.roy.id).supportingFor, stored(a.yoav.id).status], ['ready', undefined, 'ready']);

// --- 9) The read's rows are kept as evidence, never as line items ------------------
const fresh = bill({ status: 'processing', supplier: '', total: 0, category: '' });
r = await call('POST', `/api/costs/bills/${fresh.id}/finalize`, {
  supplier: 'Red Alpha Cybersecurity Pte. Ltd.', documentType: 'Invoice', date: '2026-10-31', total: 100, tax: 0, category: '4302 - General Expense',
  lineItems: [{ description: 'Taxi', amount: 60, net: 60 }, { description: 'Fee', amount: 40 }],
});
check('an upload keeps what the read saw of the table', stored(fresh.id).readLines, [{ description: 'Taxi', total: 60, net: 60 }, { description: 'Fee', total: 40, net: 0 }]);
check('and stores no line items from it', stored(fresh.id).lineItems ?? [], []);

server.close();
if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nAll supporting-docs server checks passed');
process.exit(0);
