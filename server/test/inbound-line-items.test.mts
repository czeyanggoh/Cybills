// Line items on the road where nobody is watching.
//
// "Extract line items" is a supplier's opt-in: a document is otherwise a single
// coded total, and the printed rows are pulled on demand from the document
// page. An upload honours that; the server-side read an emailed or WhatsApp'd
// document gets did not — it stored the general read's own summary of the
// table on every document, rows nobody asked for and nothing had checked
// against the document's total. Driven through autoRead against a stubbed
// reader, the way blank-read.test.mts is.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-inbound-lines-'));
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
  let body = '';
  req.on('data', (c) => (body += c));
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
await new Promise<void>((r) => stub.listen(4625, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4625';

const { autoRead } = await import('../src/inbound.ts');
const { insertBill, getBillById } = await import('../src/store.ts');
const { loadCollection, saveCollection } = await import('../src/jsonStore.ts');
const { WORKSPACE_ID } = await import('../src/workspace.ts');

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// The supplier's standing rule, written the way the Suppliers page writes it.
type Setting = { workspaceId: string; key: string; value: unknown };
const setSupplierRules = (rules: Record<string, Record<string, unknown>>) => {
  const key = 'cybills.supplier.rules.v1::org_one0001';
  const rows = loadCollection<Setting>('settings').filter((s) => s.key !== key);
  rows.push({ workspaceId: WORKSPACE_ID, key, value: rules });
  saveCollection('settings', rows);
};

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const req = { headers: {} } as never;

let n = 0;
const arrive = async () => {
  n += 1;
  const bill = insertBill({
    orgId: 'cybm',
    fileHash: `hash-${n}`,
    fileName: `invoice-${n}.png`,
    supplier: '',
    invoiceNumber: '',
    documentType: '',
    currency: '',
    total: 0,
    tax: 0,
    date: '',
    category: '',
    createdBy: 'dean@acme.sg',
    owner: 'dean@acme.sg',
    status: 'processing',
    kind: 'cost',
  } as never);
  await autoRead(req, 'cybm', 'org_one0001', 'openai', bill.id, PNG, 'image/png');
  return getBillById('cybm', bill.id);
};

// An itemised invoice, as the general read returns it: the fields, plus its
// own summary of the table.
const FIELDS = {
  supplier: 'Nuphar Design', date: '2026-08-13', documentType: 'Invoice', invoiceNumber: 'ND-2026-011',
  currency: 'SGD', total: 8244, tax: 0, category: 'Uncategorised', categoryReason: '', noteFollowed: '',
  description: 'Project management fees', dueDate: '', period: '', cardLast4: '', supplierGstRegNo: '',
  taxLabel: '', billedTo: '', billedToRegNo: '', customer: '', rebillable: false, taxRate: '',
  taxRateReason: '', project: '', projectReason: '', baseCurrency: '', baseTotal: 0, baseTax: 0,
  exchangeRate: 0, attendees: '', distanceKm: 0, taxRatePrinted: 0,
  lineItems: [
    { description: 'Extended project management', amount: 8000 },
    { description: 'Transport reimbursement', amount: 244 },
  ],
};

// --- 1) No rule: no rows -----------------------------------------------------
answer = { ...FIELDS };
let bill = await arrive();
check('the document is filed', bill?.status, 'new');
check('…with its total', bill?.total, 8244);
check('…and NO line items — nobody asked for them', bill?.lineItems ?? [], []);

// --- 2) A rule for this supplier that does not opt in: still no rows --------
setSupplierRules({ 'Nuphar Design': { category: '93511/000 - REPAIR & MAINT', extractLineItems: false } });
bill = await arrive();
check('the rule is applied', bill?.category, '93511/000 - REPAIR & MAINT');
check('…and still no line items', bill?.lineItems ?? [], []);

// --- 3) The supplier opted in: the rows are kept ----------------------------
setSupplierRules({ 'Nuphar Design': { category: '93511/000 - REPAIR & MAINT', extractLineItems: true } });
bill = await arrive();
check('opted in, the rows are stored', (bill?.lineItems ?? []).map((li) => li.description), ['Extended project management', 'Transport reimbursement']);
check('…worth what the reader read', (bill?.lineItems ?? []).map((li) => Number(li.total)), [8000, 244]);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
stub.close();
process.exit(failures ? 1 : 0);
