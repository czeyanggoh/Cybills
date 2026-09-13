// A supplier rule that moves the invoice date to the end of the previous month,
// on the road where nobody is watching. Driven through autoRead against a
// stubbed reader, so what is asserted is the date the stored document ends up
// with — and that the due date is left as printed.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-rule-date-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_EXTRACT_MODEL = 'gpt-4o-stub';
process.env.LLM_PROVIDER = 'openai';
process.env.ANTHROPIC_API_KEY = '';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'Excellence AS', tenantId: '', tenantName: '', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

let answer: Record<string, unknown> = {};
const reader = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const out = JSON.stringify(answer);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-4o-stub', output_text: out,
      output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: out, annotations: [] }] }],
      usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
    }));
  });
});
await new Promise<void>((r) => reader.listen(4695, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4695';

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

type Setting = { workspaceId: string; key: string; value: unknown };
const setRule = (rule: Record<string, unknown>) => {
  const key = 'cybills.supplier.rules.v1::org_one0001';
  const rows = loadCollection<Setting>('settings').filter((s) => s.key !== key);
  rows.push({ workspaceId: WORKSPACE_ID, key, value: { 'EIVA HR SOLUTIONS': rule } });
  saveCollection('settings', rows);
};

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const req = { headers: {} } as never;
const FIELDS = {
  supplier: 'EIVA HR SOLUTIONS', date: '2026-09-02', documentType: 'Invoice', invoiceNumber: '1653',
  currency: 'SGD', total: 5131.5, tax: 0, category: 'Uncategorised', categoryReason: '', noteFollowed: '',
  description: 'Monthly RP services July 21 - Aug 20 2026', dueDate: '2026-09-02', period: '', cardLast4: '',
  supplierGstRegNo: '', taxLabel: '', billedTo: '', billedToRegNo: '', customer: '', rebillable: false, taxRate: '',
  taxRateReason: '', project: '', projectReason: '', baseCurrency: '', baseTotal: 0, baseTax: 0,
  exchangeRate: 0, attendees: '', distanceKm: 0, taxRatePrinted: 0, lineItems: [],
};

let n = 0;
const arrive = async (fields: Record<string, unknown> = {}) => {
  n += 1;
  answer = { ...FIELDS, invoiceNumber: `1653-${n}`, ...fields };
  const bill = insertBill({
    orgId: 'cybm', fileHash: `hash-${n}`, fileName: `invoice-${n}.png`, supplier: '', invoiceNumber: '',
    documentType: '', currency: '', total: 0, tax: 0, date: '', category: '', createdBy: 'dean@acme.sg',
    owner: 'dean@acme.sg', status: 'processing', kind: 'cost',
  } as never);
  await autoRead(req, 'cybm', 'org_one0001', 'openai', bill.id, PNG, 'image/png');
  return getBillById('cybm', bill.id);
};

// --- 1) No rule about the date: as printed -----------------------------------------
setRule({ category: '413 - Freelancers' });
let bill = await arrive();
check('without the date rule, the printed date stands', bill?.date, '2026-09-02');

// --- 2) End of the previous month ----------------------------------------------------
setRule({ category: '413 - Freelancers', invoiceDate: 'endOfPreviousMonth' });
bill = await arrive();
check('the rule records an invoice of 2 September as 31 August', bill?.date, '2026-08-31');
check('…and leaves the printed due date alone', bill?.dueDate, '2026-09-02');
check('…with the rest of the rule applied as before', bill?.category, '413 - Freelancers');

// --- 3) Across a year end ---------------------------------------------------------------
bill = await arrive({ date: '2027-01-04', dueDate: '2027-01-04' });
check('January goes back to 31 December of the year before', bill?.date, '2026-12-31');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
await finish(failures, reader);
