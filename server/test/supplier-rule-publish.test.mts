// A supplier rule that says "publish to Xero after reading", on the road where
// nobody is watching. Driven through autoRead against a stubbed reader and a
// stubbed Xero relay, so what is asserted is the bill that actually goes out —
// and, as much, the bills that do not.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-rule-publish-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_EXTRACT_MODEL = 'gpt-4o-stub';
process.env.LLM_PROVIDER = 'openai';
process.env.ANTHROPIC_API_KEY = '';
process.env.CYWORKSPACE_API_KEY = 'test-key';
process.env.APP_ORIGIN = 'https://cybills.example.com';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'Excellence AS', tenantId: 'tenant-1', tenantName: 'Excellence AS', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

// --- stub reader ---------------------------------------------------------------
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
await new Promise<void>((r) => reader.listen(4691, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4691';

// --- stub relay ----------------------------------------------------------------
const posted: any[] = [];
const relay = http.createServer((req, res) => {
  const path = decodeURIComponent(String(req.url)).split('?')[0];
  res.setHeader('content-type', 'application/json');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (path.endsWith('/Accounts')) {
      return res.end(JSON.stringify({ Accounts: [{ Code: '449', Name: 'Motor Vehicle Expenses', Status: 'ACTIVE', Type: 'EXPENSE', TaxType: 'NONE' }] }));
    }
    if (path.endsWith('/TaxRates')) {
      return res.end(JSON.stringify({ TaxRates: [{ Name: 'No Tax', TaxType: 'NONE', Status: 'ACTIVE', EffectiveRate: 0 }] }));
    }
    if (path.endsWith('/Organisation')) {
      return res.end(JSON.stringify({ Organisations: [{ Name: 'Excellence AS', BaseCurrency: 'SGD' }] }));
    }
    if (path.endsWith('/Invoices') && req.method === 'PUT') {
      const inv = JSON.parse(body || '{}').Invoices?.[0] ?? {};
      posted.push(inv);
      return res.end(JSON.stringify({ Invoices: [{ InvoiceID: `inv-${posted.length}`, InvoiceNumber: inv.InvoiceNumber, Status: inv.Status, HasErrors: false, LineItems: [] }] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found', path }));
  });
});
await new Promise<void>((r) => relay.listen(4692, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4692';

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
  rows.push({ workspaceId: WORKSPACE_ID, key, value: { 'Nordad Commercial Leasing': rule } });
  saveCollection('settings', rows);
};

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const req = { headers: {} } as never;
const FIELDS = {
  supplier: 'Nordad Commercial Leasing', date: '2026-09-01', documentType: 'Invoice', invoiceNumber: 'NCL-1',
  currency: 'SGD', total: 850, tax: 0, category: 'Uncategorised', categoryReason: '', noteFollowed: '',
  description: 'Vehicle lease September', dueDate: '', period: '', cardLast4: '', supplierGstRegNo: '',
  taxLabel: '', billedTo: '', billedToRegNo: '', customer: '', rebillable: false, taxRate: '',
  taxRateReason: '', project: '', projectReason: '', baseCurrency: '', baseTotal: 0, baseTax: 0,
  exchangeRate: 0, attendees: '', distanceKm: 0, taxRatePrinted: 0, motorVehicle: true, lineItems: [],
};

let n = 0;
const arrive = async (fields: Record<string, unknown>) => {
  n += 1;
  answer = { ...FIELDS, ...fields };
  const bill = insertBill({
    orgId: 'cybm', fileHash: `hash-${n}`, fileName: `invoice-${n}.png`, supplier: '', invoiceNumber: '',
    documentType: '', currency: '', total: 0, tax: 0, date: '', category: '', createdBy: 'dean@acme.sg',
    owner: 'dean@acme.sg', status: 'processing', kind: 'cost',
  } as never);
  const before = posted.length;
  await autoRead(req, 'cybm', 'org_one0001', 'openai', bill.id, PNG, 'image/png');
  return { bill: getBillById('cybm', bill.id), sent: posted.slice(before) };
};

const RULE = { category: '449 - Motor Vehicle Expenses', taxRate: 'No Tax' };

// --- 1) A rule that says nothing about publishing: nothing goes out ------------
setRule({ ...RULE });
// Each case is its own invoice — its own number, total and date — so the
// duplicate guard only fires where case 4 means it to.
let got = await arrive({ invoiceNumber: 'NCL-0', total: 700, date: '2026-06-01' });
check('a rule left on "Follow Extraction settings" does not publish an emailed document', got.sent.length, 0);
check('…the document is filed, coded by the rule', [got.bill?.category, got.bill?.xeroInvoiceId ?? ''], ['449 - Motor Vehicle Expenses', '']);

// --- 2) Approved (awaiting payment) ---------------------------------------------
setRule({ ...RULE, autoPublish: 'AUTHORISED' });
got = await arrive({ invoiceNumber: 'NCL-1' });
check('the rule publishes it straight after reading', got.sent.length, 1);
check('…as Approved (awaiting payment)', got.sent[0]?.Status, 'AUTHORISED');
check('…coded by the rule', got.sent[0]?.LineItems?.[0]?.AccountCode, '449');
check('…and the document records the bill', Boolean(got.bill?.xeroInvoiceId), true);

// --- 3) Awaiting approval --------------------------------------------------------
setRule({ ...RULE, autoPublish: 'SUBMITTED' });
got = await arrive({ invoiceNumber: 'NCL-2', total: 910, date: '2026-10-01' });
check('a rule can ask for Awaiting approval instead', got.sent[0]?.Status, 'SUBMITTED');

// --- 4) A duplicate is never posted unattended ------------------------------------
setRule({ ...RULE, autoPublish: 'AUTHORISED' });
got = await arrive({ invoiceNumber: 'NCL-1' });
check('the same invoice again is left in the inbox, not paid twice', got.sent.length, 0);
check('…unpublished', got.bill?.xeroInvoiceId ?? '', '');

// --- 5) An incomplete read is never posted -----------------------------------------
got = await arrive({ invoiceNumber: 'NCL-3', total: 0, date: '2026-11-01' });
check('a document with no total is not published', got.sent.length, 0);

// --- 6) 'never' ---------------------------------------------------------------------
setRule({ ...RULE, autoPublish: 'never' });
got = await arrive({ invoiceNumber: 'NCL-4', total: 920, date: '2026-12-01' });
check('"Never" publishes nothing', got.sent.length, 0);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
await finish(failures, reader, relay);
