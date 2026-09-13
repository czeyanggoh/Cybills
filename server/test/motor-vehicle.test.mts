// A motor vehicle expense is No Tax, however the document got that way: read
// off the paper by the background reader, moved onto a motor vehicle account
// after it was read, or stored before the rule existed. And never over a code a
// person picked, a published bill, or a document on an expense claim.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-motor-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_EXTRACT_MODEL = 'gpt-4o-stub';
process.env.LLM_PROVIDER = 'openai';
process.env.ANTHROPIC_API_KEY = '';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'EXCELLENCE A.S PTE. LTD.', tenantId: '', tenantName: '', createdAt: new Date(0).toISOString(), createdBy: '' },
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
        id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-4o-stub', output_text: out,
        output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: out, annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
      })
    );
  });
});
await new Promise<void>((r) => stub.listen(4641, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4641';

const { autoRead } = await import('../src/inbound.ts');
const { insertBill, getBillById, updateBill } = await import('../src/store.ts');
const { keepMotorVehicleNoTax, enforceMotorVehicleNoTax } = await import('../src/motorVehicle.ts');
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
const base = (extra: Record<string, unknown> = {}) => {
  n += 1;
  return insertBill({
    orgId: 'cybm', fileHash: `hash-${n}`, fileName: `r-${n}.png`, supplier: 'Singapore Petroleum Company', invoiceNumber: `SPC${n}`,
    documentType: 'Receipt', currency: 'SGD', total: 103.66, tax: 8.56, date: '2026-09-01', category: '', createdBy: 'dean@acme.sg',
    owner: 'dean@acme.sg', status: 'new', kind: 'cost', ...extra,
  } as never);
};

const FIELDS = {
  supplier: 'Singapore Petroleum Company', date: '2026-09-01', documentType: 'Receipt', invoiceNumber: 'SPC1', currency: 'SGD',
  total: 103.66, tax: 8.56, category: 'Uncategorised', categoryReason: '', noteFollowed: '', description: 'Petrol', dueDate: '',
  period: '', cardLast4: '', supplierGstRegNo: 'M2-0009896-0', taxLabel: 'TOTAL GST', taxRatePrinted: 0, motorVehicle: true,
  billedTo: '', billedToRegNo: '', customer: '', rebillable: false, taxRate: '', taxRateReason: '', project: '', projectReason: '',
  baseCurrency: '', baseTotal: 0, baseTax: 0, exchangeRate: 0, lineItems: [],
};

// --- 1) The background read: the paper says it, and a supplier rule does not overrule it
saveCollection('settings', [
  { workspaceId: WORKSPACE_ID, key: 'cybills.supplier.rules.v1::org_one0001', value: { 'Singapore Petroleum Company': { taxRate: 'Standard-Rated Purchases' } } },
]);
answer = { ...FIELDS };
const readBill = base({ status: 'processing', supplier: '', total: 0, tax: 0 });
await autoRead(req, 'cybm', 'org_one0001', 'openai', readBill.id, PNG, 'image/png');
const read = getBillById('cybm', readBill.id)!;
check('a read the reader flags as a motor vehicle expense is No Tax', read.taxRate, 'No Tax');
check('…with the GST left in the cost', [read.tax, read.total], [0, 103.66]);
check('…the flag is stored', read.motorVehicle, true);
check("…and a supplier rule's Standard-Rated code did not claim it", /motor vehicle/i.test(String(read.taxRateReason)), true);

// A taxi receipt, flagged false, is untouched.
answer = { ...FIELDS, supplier: 'ComfortDelGro', motorVehicle: false, supplierGstRegNo: '199300502M' };
const taxiBill = base({ status: 'processing', supplier: '', total: 0, tax: 0 });
await autoRead(req, 'cybm', 'org_one0001', 'openai', taxiBill.id, PNG, 'image/png');
check('a taxi keeps its GST', getBillById('cybm', taxiBill.id)!.tax, 8.56);

// --- 2) Moved onto a motor vehicle account after it was read -----------------
const moved = base({ category: '429 - General Expenses', taxRate: 'Standard-Rated Purchases', ruleFields: ['taxRate'],
  lineItems: [{ description: 'Petrol', net: '95.10', tax: '8.56', total: '103.66' }] });
const patch: Record<string, unknown> = { category: '449 - Motor Vehicle Expenses' };
check('a write moving it onto a motor account is changed', await keepMotorVehicleNoTax(moved, patch), true);
check('…to No Tax with no tax', [patch.taxRate, patch.tax, patch.baseTax], ['No Tax', 0, 0]);
check('…its lines give their tax up into their cost', (patch.lineItems as Array<Record<string, string>>).map((l) => [l.tax, l.total]), [['0.00', '103.66']]);
check('…and the supplier rule stops owning the code', patch.ruleFields, []);

// --- 3) What is left alone ---------------------------------------------------
const picked: Record<string, unknown> = { category: '449 - Motor Vehicle Expenses' };
check('a code a person picked stays (a goods van)',
  await keepMotorVehicleNoTax(base({ category: '429 - General Expenses', taxRate: 'Standard-Rated Purchases', taxRateEdited: true }), picked), false);
const pickNow: Record<string, unknown> = { taxRate: 'Standard-Rated Purchases', taxRateEdited: true };
check('…including the write that picks it',
  await keepMotorVehicleNoTax(base({ category: '449 - Motor Vehicle Expenses', taxRate: 'No Tax', tax: 0 }), pickNow), false);
check('a published bill stays', await keepMotorVehicleNoTax(base({ category: '449 - Motor Vehicle Expenses', taxRate: 'Standard-Rated Purchases', xeroInvoiceId: 'inv-1' }), {}), false);
check('a document on an expense claim stays', await keepMotorVehicleNoTax(base({ category: '449 - Motor Vehicle Expenses', taxRate: 'Standard-Rated Purchases', status: 'expenseclaim' }), {}), false);
const right = base({ category: '449 - Motor Vehicle Expenses', taxRate: 'No Tax', tax: 0, taxRateReason: 'No tax is shown on this document.' });
check('one already right is not rewritten', await keepMotorVehicleNoTax(right, {}), false);

// --- 4) The sweep over what is stored ---------------------------------------
const stale = base({ category: '449 - Motor Vehicle Expenses', taxRate: 'Standard-Rated Purchases' });
const published = base({ category: '449 - Motor Vehicle Expenses', taxRate: 'Standard-Rated Purchases', xeroInvoiceId: 'inv-2' });
const handPicked = base({ category: '449 - Motor Vehicle Expenses', taxRate: 'Standard-Rated Purchases', taxRateEdited: true });
updateBill('cybm', moved.id, {}); // bump the book so the sweep runs
await enforceMotorVehicleNoTax('cybm');
check('the sweep puts a stored petrol receipt right', [getBillById('cybm', stale.id)!.taxRate, getBillById('cybm', stale.id)!.tax], ['No Tax', 0]);
check('…and leaves the published one for Update in Xero', getBillById('cybm', published.id)!.taxRate, 'Standard-Rated Purchases');
check("…and the person's pick", getBillById('cybm', handPicked.id)!.taxRate, 'Standard-Rated Purchases');

await finish(failures, stub);
