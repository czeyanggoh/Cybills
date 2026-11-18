// A read supplier name is filed under the supplier the entity already has
// (supplierName.ts + src/lib/supplierCanonical.js), so "Xero (NZ) Ltd" does
// not become a supplier, a rule miss and a Xero contact of its own beside
// "Xero (NZ) Limited". Driven through the background read an emailed or
// WhatsApp'd document gets, with a stubbed reader, so what is asserted is what
// gets stored.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-supname-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_EXTRACT_MODEL = 'gpt-4o-stub';
process.env.LLM_PROVIDER = 'openai';
process.env.ANTHROPIC_API_KEY = '';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'CY Business Management', tenantId: '', tenantName: '', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

let answer: Record<string, unknown> = {};
const stub = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
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
        usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
      })
    );
  });
});
await new Promise<void>((r) => stub.listen(4637, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4637';

const { autoRead } = await import('../src/inbound.ts');
const { insertBill, getBillById, updateBill } = await import('../src/store.ts');
const { saveCollection } = await import('../src/jsonStore.ts');
const { WORKSPACE_ID } = await import('../src/workspace.ts');

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const req = { headers: {} } as never;

let n = 0;
const arrive = async () => {
  n += 1;
  const bill = insertBill({
    orgId: 'cybm', fileHash: `hash-${n}`, fileName: `r-${n}.png`, supplier: '', invoiceNumber: '', documentType: '',
    currency: '', total: 0, tax: 0, date: '', category: '', createdBy: 'dean@acme.sg', owner: 'dean@acme.sg',
    status: 'processing', kind: 'cost',
  } as never);
  await autoRead(req, 'cybm', 'org_one0001', 'openai', bill.id, PNG, 'image/png');
  return getBillById('cybm', bill.id)!;
};

const FIELDS = {
  supplier: '', date: '2026-08-11', documentType: 'Receipt', invoiceNumber: '', currency: 'SGD', total: 74.67, tax: 6.17,
  category: 'Uncategorised', categoryReason: '', noteFollowed: '', description: '', dueDate: '',
  period: '', cardLast4: '', supplierGstRegNo: '', taxLabel: 'GST %', billedTo: '', billedToRegNo: '',
  customer: '', rebillable: false, taxRate: '', taxRateReason: '', project: '', projectReason: '',
  baseCurrency: '', baseTotal: 0, baseTax: 0, exchangeRate: 0, lineItems: [],
};




// --- 1) A new spelling of a supplier already in the book --------------------
answer = { ...FIELDS, supplier: 'Xero (NZ) Limited', invoiceNumber: 'INV-1' };
const first = await arrive();
check('the first read keeps its name', first.supplier, 'Xero (NZ) Limited');
answer = { ...FIELDS, supplier: 'Xero (NZ) Ltd', invoiceNumber: 'INV-2' };
const second = await arrive();
check('"Ltd" is filed under the "Limited" the book already has', second.supplier, 'Xero (NZ) Limited');

// --- 2) A different supplier is left alone --------------------------------------
answer = { ...FIELDS, supplier: 'Xero Inc', invoiceNumber: 'INV-3' };
check('a different name is not touched', (await arrive()).supplier, 'Xero Inc');

// --- 3) A spelling MERGED AWAY on the Suppliers page --------------------------
saveCollection('settings', [
  {
    workspaceId: WORKSPACE_ID,
    key: 'cybills.supplier-list.v1::org_one0001',
    value: { removed: ['Xero Inc'], merged: { 'xero inc': 'Xero (NZ) Limited' } },
  },
]);
answer = { ...FIELDS, supplier: 'XERO INC.', invoiceNumber: 'INV-4' };
check('a merged-away spelling goes to the name it was merged into', (await arrive()).supplier, 'Xero (NZ) Limited');

// --- 4) A supplier rule's name wins a tie -------------------------------------
saveCollection('settings', [
  { workspaceId: WORKSPACE_ID, key: 'cybills.supplier.rules.v1::org_one0001', value: { 'Grab Pte Ltd': { category: '' } } },
]);
answer = { ...FIELDS, supplier: 'Grab', invoiceNumber: 'G-1' };
await arrive();
answer = { ...FIELDS, supplier: 'GRAB LIMITED', invoiceNumber: 'G-2' };
check("between a book name and a rule name, the rule's is taken", (await arrive()).supplier, 'Grab Pte Ltd');

await finish(failures, stub);
