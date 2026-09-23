// A payment proof is evidence that money was SENT, not a bill for it: typed so,
// a document is paid and states no tax, on every road it arrives by. Driven over
// real HTTP against the real server with a stubbed reader, so what is asserted
// is what the reader is offered and what the store ends up holding.
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-payment-proof-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_EXTRACT_MODEL = 'gpt-4o-stub';
process.env.LLM_PROVIDER = 'openai';
process.env.ANTHROPIC_API_KEY = '';
process.env.PORT = '4672';

// --- stub reader -------------------------------------------------------------
let answer: Record<string, unknown> = {};
let schemas: any[] = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    schemas.push(parsed.text?.format?.schema ?? parsed.text?.format ?? null);
    const out = JSON.stringify(answer);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        model: 'gpt-4o-stub',
        output_text: out,
        output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: out, annotations: [] }] }],
        usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 0 } },
      })
    );
  });
});
await new Promise<void>((r) => stub.listen(4671, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4671';

const { insertBill, getBillById } = await import('../src/store.ts');
const { dataScopeForOrg } = await import('../src/organisations.ts');
await import('../src/index.ts');
await new Promise((r) => setTimeout(r, 200));

const BASE = 'http://127.0.0.1:4672';
const scope = dataScopeForOrg('');

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const REASON = 'Payment proof — a transfer or payment confirmation states no tax. Any GST is on the invoice it pays and is claimed there, not here.';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const baseAnswer = {
  supplier: 'A1 Consultancy Pte Ltd', date: '2026-08-26', documentType: 'Payment proof', distanceKm: 0, invoiceNumber: 'REF20260826ABC',
  currency: 'SGD', total: 109, tax: 0, category: 'Uncategorised', categoryReason: 'A transfer to a consultancy.',
  description: 'Payment to A1 Consultancy, ref 20260826ABC',
  dueDate: '', period: '', cardLast4: '', baseCurrency: '', baseTotal: 0, baseTax: 0, exchangeRate: 0,
  supplierGstRegNo: '', taxLabel: '', billedTo: '', billedToRegNo: '', lineItems: [],
};

const read = async (ans: Record<string, unknown>) => {
  answer = ans;
  const res = await fetch(`${BASE}/api/costs/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64: PNG, mediaType: 'image/png', accounts: [{ code: '429', name: 'General Expenses', description: 'Anything else' }] }),
  });
  return ((await res.json()) as any)?.data ?? null;
};

// --- what the reader is offered ----------------------------------------------
const d = await read(baseAnswer);
const schema = schemas[0];
const props = schema?.properties ?? schema?.schema?.properties ?? {};
check('the reader is offered "Payment proof" as a document type', props.documentType?.enum, ['Receipt', 'Invoice', 'Payment proof', 'Quotation', 'Pro-forma invoice', 'Mileage', 'Other']);
check('and told what one is', String(props.documentType?.description || '').includes('evidence that money was SENT'), true);
check('a transfer confirmation reads as a payment proof', d?.documentType, 'Payment proof');
check('with the payee as the supplier', d?.supplier, 'A1 Consultancy Pte Ltd');

// --- the sweep: the reader asked for the kind alone ---------------------------
answer = { documentType: 'Payment proof', reason: 'A DBS transfer confirmation naming the payee and the amount sent.' };
let cres = await fetch(`${BASE}/api/costs/classify-type`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ imageBase64: PNG, mediaType: 'image/png', fileName: 'IMG_4821.png' }),
});
let cbody = (await cres.json()) as any;
const cschema = schemas[schemas.length - 1];
const cprops = cschema?.properties ?? cschema?.schema?.properties ?? {};
check('classify-type asks for the kind and a reason, nothing else', Object.keys(cprops).sort(), ['documentType', 'reason']);
check('offering the payment proof kind among the others', cprops.documentType?.enum?.includes('Payment proof'), true);
check('and answers with what the reader said', [cbody.ok, cbody.documentType, cbody.reason], [true, 'Payment proof', 'A DBS transfer confirmation naming the payee and the amount sent.']);
answer = { documentType: 'Receipt', reason: 'A till receipt from the merchant.' };
cres = await fetch(`${BASE}/api/costs/classify-type`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ imageBase64: PNG, mediaType: 'image/png' }),
});
cbody = (await cres.json()) as any;
check('a receipt is reported as one — the browser leaves it alone', cbody.documentType, 'Receipt');
cres = await fetch(`${BASE}/api/costs/classify-type`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ imageBase64: PNG, mediaType: 'image/heic' }),
});
check('a kind the reader cannot take is refused up front', cres.status, 400);

// --- the upload road: finalize lands it paid and at No Tax ------------------
const fresh = () =>
  insertBill({
    orgId: scope, kind: 'cost', status: 'processing', supplier: '', invoiceNumber: '', documentType: 'Receipt',
    currency: 'SGD', date: '', category: '', total: 0, tax: 0, fileHash: `h${Math.random()}`, fileName: 'transfer.png',
    categoryReason: '', projectReason: '', taxRate: '', taxRateReason: '', description: '', createdBy: '',
    storageKey: '', contentType: '',
  } as any);
const processing = fresh();
let res = await fetch(`${BASE}/api/costs/bills/${processing.id}/finalize`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  // The browser sends whatever tax the reader made of it; the type overrules.
  body: JSON.stringify({ ...baseAnswer, tax: 9, checkDuplicates: false }),
});
let body = (await res.json()) as any;
check('finalize marks it paid — that is what the paper proves', body.bill?.paid, true);
check('and records no tax, whatever the reader made of it', body.bill?.tax, 0);
check('coded No Tax', body.bill?.taxRate, 'No Tax');
check('with the reason', body.bill?.taxRateReason, REASON);
check('the total is the money transferred', body.bill?.total, 109);

// --- the page: typing a receipt as a payment proof ---------------------------
const patch = async (id: string, fields: Record<string, unknown>) => {
  const r = await fetch(`${BASE}/api/costs/bills/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  return ((await r.json()) as any)?.bill;
};
const receipt = insertBill({
  orgId: scope, kind: 'cost', status: 'new', supplier: 'A1 Consultancy Pte Ltd', invoiceNumber: '', documentType: 'Receipt',
  currency: 'SGD', date: '2026-08-26', category: '429 - General Expenses', total: 109, tax: 9, fileHash: 'h2', fileName: 'r.png',
  categoryReason: '', projectReason: '', taxRate: 'INPUTY24', taxRateReason: 'read', description: '', createdBy: '',
  storageKey: '', contentType: '', paid: false, ruleFields: ['taxRate'],
} as any);
let b = await patch(receipt.id, { documentType: 'Payment proof' });
check('typed as a payment proof, a receipt becomes paid', b?.paid, true);
check('at No Tax', [b?.taxRate, b?.tax], ['No Tax', 0]);
check('a supplier rule that owned the code no longer does', b?.ruleFields ?? [], []);
check('the total never moves', b?.total, 109);

b = await patch(receipt.id, { paid: false });
check('unticking Paid afterwards sticks — the type is not in that write', b?.paid, false);

b = await patch(receipt.id, { supplier: 'A1 Consultancy' });
check('an ordinary edit leaves it alone', [b?.paid, b?.taxRate], [false, 'No Tax']);

// --- a code somebody picked by hand is theirs ----------------------------------
const picked = insertBill({
  orgId: scope, kind: 'cost', status: 'new', supplier: 'A1 Consultancy Pte Ltd', invoiceNumber: '', documentType: 'Receipt',
  currency: 'SGD', date: '2026-08-26', category: '429 - General Expenses', total: 109, tax: 9, fileHash: 'h3', fileName: 'r.png',
  categoryReason: '', projectReason: '', taxRate: 'INPUTY24', taxRateReason: 'read', description: '', createdBy: '',
  storageKey: '', contentType: '',
} as any);
b = await patch(picked.id, { documentType: 'Payment proof', taxRate: 'INPUTY24', taxRateEdited: true, taxRateReason: 'INPUTY24 — chosen by hand.', tax: '9' });
check('a hand-picked code survives the type — only Paid is written', [b?.paid, b?.taxRate, b?.tax], [true, 'INPUTY24', 9]);

// --- a document already in Xero is left as the ledger has it ------------------
const published = insertBill({
  orgId: scope, kind: 'cost', status: 'archived', supplier: 'A1 Consultancy Pte Ltd', invoiceNumber: '', documentType: 'Receipt',
  currency: 'SGD', date: '2026-08-26', category: '429 - General Expenses', total: 109, tax: 9, fileHash: 'h4', fileName: 'r.png',
  categoryReason: '', projectReason: '', taxRate: 'INPUTY24', taxRateReason: 'read', description: '', createdBy: '',
  storageKey: '', contentType: '', xeroInvoiceId: 'inv-1', paid: false,
} as any);
await patch(published.id, { documentType: 'Payment proof' });
const after = getBillById(scope, published.id);
check('a published document keeps its figures — Update in Xero is the road', [after?.paid ?? false, after?.taxRate, after?.tax], [false, 'INPUTY24', 9]);

// --- a payment proof is set aside, and never published ------------------------
check('finalize sets a payment proof aside to Archived', getBillById(scope, processing.id)?.status, 'archived');
check('so does typing one on the page', getBillById(scope, receipt.id)?.status, 'archived');
const { postBillToXero } = await import('../src/xero.ts');
const refusal = await postBillToXero(
  { headers: {} } as any,
  { id: 'org', tenantId: 'tenant' },
  'ws',
  getBillById(scope, receipt.id)!,
  { accountCode: '429', taxType: 'NONE', status: 'AUTHORISED' }
);
check('publishing a payment proof is refused', [refusal.status, refusal.body?.error], [422, 'payment_proof']);

// --- the invoices it pays ---------------------------------------------------------
const base = {
  orgId: scope, kind: 'cost', status: 'ready', supplier: 'Nuphar Design Pte Ltd', invoiceNumber: '', documentType: 'Invoice',
  currency: 'SGD', date: '2026-08-01', category: '429 - General Expenses', total: 0, tax: 0, fileName: 'i.pdf',
  categoryReason: '', projectReason: '', taxRate: '', taxRateReason: '', description: '', createdBy: '', storageKey: '', contentType: '', paid: false,
};
const invoice = (over: Record<string, unknown>) => insertBill({ ...base, fileHash: `inv${Math.random()}`, ...over } as any);
const inv60 = invoice({ invoiceNumber: 'ND-011', total: 60 });
const inv49 = invoice({ invoiceNumber: 'ND-012', total: 49, date: '2026-08-10' });
const other49 = invoice({ supplier: 'Singtel', total: 49 });
const nuphar = insertBill({
  ...base, fileHash: 'proof-nuphar', status: 'archived', supplier: 'NUPHAR DESIGN', documentType: 'Payment proof',
  date: '2026-08-20', total: 109, invoiceNumber: 'FT2608201234', description: 'PayNow to Nuphar Design', paid: true, taxRate: 'No Tax',
} as any);

const list = async () => (await fetch(`${BASE}/api/costs/bills`)).json();
const post = async (path: string, payload: unknown = {}) => {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { status: r.status, body: (await r.json()) as any };
};
const paidOf = (id: string) => Boolean(getBillById(scope, id)?.paid);

await list();
check('the listing marks the two invoices that add up to the proof paid, by itself', [paidOf(inv60.id), paidOf(inv49.id), paidOf(other49.id)], [true, true, false]);
check('the proof records which it pays', [...(getBillById(scope, nuphar.id)?.paysBills ?? [])].sort(), [inv60.id, inv49.id].sort());
check('matched automatically', getBillById(scope, nuphar.id)?.paysBillsAuto, true);
let seen = (await (await fetch(`${BASE}/api/costs/bills/${inv60.id}/proof`)).json()) as any;
check('the invoice names the proof that paid it', [seen.kind, seen.paidBy?.id, seen.paidBy?.auto], ['invoice', nuphar.id, true]);
seen = (await (await fetch(`${BASE}/api/costs/bills/${nuphar.id}/proof`)).json()) as any;
check('the proof lists the invoices it pays', seen.applied.map((x: any) => x.id).sort(), [inv60.id, inv49.id].sort());

let act = await post(`/api/costs/bills/${nuphar.id}/unapply-proof`);
check('undo puts both invoices back to unpaid', [act.status, paidOf(inv60.id), paidOf(inv49.id)], [200, false, false]);
await list();
check('and the next listing does not match it again', getBillById(scope, nuphar.id)?.paysBills ?? [], []);
seen = (await (await fetch(`${BASE}/api/costs/bills/${inv49.id}/proof`)).json()) as any;
check('the invoice is offered the proof instead', [seen.paidBy, seen.offers?.[0]?.proof?.id], [null, nuphar.id]);

act = await post(`/api/costs/bills/${nuphar.id}/apply-proof`, { billIds: [inv60.id] });
check('a set that does not add up is refused', [act.status, act.body?.error, paidOf(inv60.id)], [422, 'amount_mismatch', false]);
act = await post(`/api/costs/bills/${nuphar.id}/apply-proof`, { billIds: [inv60.id, other49.id] });
check('a hand-picked set that adds up is applied', [act.status, paidOf(inv60.id), paidOf(other49.id), paidOf(inv49.id)], [200, true, true, false]);
check('by hand, not automatically', getBillById(scope, inv60.id)?.paidByProof?.auto, false);
act = await post(`/api/costs/bills/${nuphar.id}/apply-proof`, { billIds: [inv60.id, inv49.id] });
check('re-applying a different set releases the invoice it no longer pays', [act.status, paidOf(inv60.id), paidOf(inv49.id), paidOf(other49.id)], [200, true, true, false]);
act = await post(`/api/costs/bills/${inv60.id}/apply-proof`, { billIds: [inv49.id] });
check('an invoice cannot pay invoices', [act.status, act.body?.error], [422, 'not_payment_proof']);

// --- the proofs typed before archiving existed ---------------------------------
check('typing one records that it was set aside', getBillById(scope, receipt.id)?.proofSetAside, true);
const standing = insertBill({
  ...base, fileHash: 'proof-standing', status: 'ready', supplier: 'OCBC Transfer', documentType: 'Payment proof',
  date: '2026-07-02', total: 77.7, invoiceNumber: 'OCBC-TRF-1', paid: true, taxRate: 'No Tax',
} as any);
const standingPublished = insertBill({
  ...base, fileHash: 'proof-standing-published', status: 'ready', supplier: 'DBS Transfer', documentType: 'Payment proof',
  date: '2026-07-03', total: 12.3, paid: true, xeroInvoiceId: 'inv-standing', taxRate: 'No Tax',
} as any);
const standingClaimed = insertBill({
  ...base, fileHash: 'proof-standing-claimed', status: 'expenseclaim', supplier: 'UOB Transfer', documentType: 'Payment proof',
  date: '2026-07-04', total: 45.6, paid: true, taxRate: 'No Tax',
} as any);
await list();
check('a proof left in the inbox from before is archived by the listing', [getBillById(scope, standing.id)?.status, getBillById(scope, standing.id)?.proofSetAside], ['archived', true]);
// A PUBLISHED proof is not this sweep's to set aside — proofSetAside is what
// makes the archiving happen once, and is what it is read by afterwards. Its
// status is archived all the same, by the rule six lines earlier in the same
// listing (archivePublishedWorkingDocs): a document in Xero is never in Ready.
check('one already in Xero is not set aside by this sweep', getBillById(scope, standingPublished.id)?.proofSetAside ?? false, false);
check('and so is one on an expense claim', getBillById(scope, standingClaimed.id)?.status, 'expenseclaim');
const pulledOut = await patch(standing.id, { status: 'new' });
check('somebody can pull it back out', pulledOut?.status, 'new');
await list();
check('and the next listing leaves it there — it is set aside once', getBillById(scope, standing.id)?.status, 'new');

stub.close();
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll payment-proof tests passed.');
process.exit(0);
