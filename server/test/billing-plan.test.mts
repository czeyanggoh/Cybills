// A supplier's billing plan on the road where nobody is watching: an emailed
// invoice is split as its quotation said, an unattended publish posts those
// lines, and one that disagrees with the plan waits for a person. Driven through
// autoRead against a stubbed reader and Xero relay; the draft read is driven
// over real HTTP.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-billing-plan-'));
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
await new Promise<void>((r) => reader.listen(4693, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4693';

// --- stub relay ----------------------------------------------------------------
const posted: any[] = [];
const asked: string[] = [];
const relay = http.createServer((req, res) => {
  const path = decodeURIComponent(String(req.url)).split('?')[0];
  res.setHeader('content-type', 'application/json');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (path.endsWith('/Accounts')) {
      return res.end(JSON.stringify({ Accounts: [
        { Code: '710', Name: 'Software Development', Status: 'ACTIVE', Type: 'EXPENSE', TaxType: 'NONE' },
        { Code: '485', Name: 'Subscriptions', Status: 'ACTIVE', Type: 'EXPENSE', TaxType: 'NONE' },
      ] }));
    }
    if (path.endsWith('/TaxRates')) {
      return res.end(JSON.stringify({ TaxRates: [{ Name: 'No Tax', TaxType: 'NONE', Status: 'ACTIVE', EffectiveRate: 0 }] }));
    }
    if (path.endsWith('/Organisation')) {
      return res.end(JSON.stringify({ Organisations: [{ Name: 'Excellence AS', BaseCurrency: 'SGD' }] }));
    }
    // Asked before every unattended publish: does Xero already hold this money
    // (Paperwork match)? Nothing here does.
    if ((path.endsWith('/BankTransactions') || path.endsWith('/Invoices')) && req.method === 'GET') {
      asked.push(path.split('/').pop());
      return res.end(JSON.stringify(path.endsWith('/Invoices') ? { Invoices: [] } : { BankTransactions: [] }));
    }
    if (path.endsWith('/TrackingCategories')) return res.end(JSON.stringify({ TrackingCategories: [] }));
    if (path.endsWith('/Invoices') && req.method === 'PUT') {
      const inv = JSON.parse(body || '{}').Invoices?.[0] ?? {};
      posted.push(inv);
      return res.end(JSON.stringify({ Invoices: [{ InvoiceID: `inv-${posted.length}`, InvoiceNumber: inv.InvoiceNumber, Status: inv.Status, HasErrors: false, LineItems: [] }] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found', path }));
  });
});
await new Promise<void>((r) => relay.listen(4694, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4694';

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

const DEV = '710 - Software Development';
const SUB = '485 - Subscriptions';

type Setting = { workspaceId: string; key: string; value: unknown };
const put = (key: string, value: unknown) => {
  const full = `${key}::org_one0001`;
  const rows = loadCollection<Setting>('settings').filter((s) => s.key !== full);
  rows.push({ workspaceId: WORKSPACE_ID, key: full, value });
  saveCollection('settings', rows);
};
put('cybills.billing-plans.v1', {
  plans: [{
    id: 'p1', supplier: 'The Bridgers Pte Ltd', reference: 'TB_QU_YAKSON_0001', currency: 'SGD',
    stages: [{
      id: 'sub', name: 'Subscription', from: '2026-09-01', to: '',
      lines: [
        { description: 'Development cost instalment', amount: 900, category: DEV },
        { description: 'Subscription', amount: 1500, category: SUB },
      ],
    }],
  }],
});
put('cybills.supplier.rules.v1', { 'The Bridgers Pte Ltd': { category: SUB, autoPublish: 'AUTHORISED' } });

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const req = { headers: {} } as never;
const FIELDS = {
  supplier: 'The Bridgers Pte Ltd', date: '2026-09-16', documentType: 'Invoice', invoiceNumber: 'INV-0013',
  currency: 'SGD', total: 2400, tax: 0, category: 'Uncategorised', categoryReason: '', noteFollowed: '',
  description: 'Subscription Cost (wef Sep 2026)', dueDate: '', period: '', cardLast4: '', supplierGstRegNo: '',
  taxLabel: '', billedTo: '', billedToRegNo: '', customer: '', rebillable: false, taxRate: '',
  taxRateReason: '', project: '', projectReason: '', baseCurrency: '', baseTotal: 0, baseTax: 0,
  exchangeRate: 0, attendees: '', distanceKm: 0, taxRatePrinted: 0, motorVehicle: false, lineItems: [],
};

let n = 0;
const arrive = async (fields: Record<string, unknown>, envelope: never | null = null) => {
  n += 1;
  answer = { ...FIELDS, ...fields };
  const bill = insertBill({
    orgId: 'cybm', fileHash: `hash-${n}`, fileName: `invoice-${n}.png`, supplier: '', invoiceNumber: '',
    documentType: '', currency: '', total: 0, tax: 0, date: '', category: '', createdBy: 'dean@acme.sg',
    owner: 'dean@acme.sg', status: 'processing', kind: 'cost',
  } as never);
  const before = posted.length;
  await autoRead(req, 'cybm', 'org_one0001', 'openai', bill.id, PNG, 'image/png', envelope);
  return { bill: getBillById('cybm', bill.id)!, sent: posted.slice(before) };
};
const rows = (b: { lineItems?: Array<{ category?: string; total?: string }> }) =>
  (b.lineItems ?? []).map((r) => [r.category, r.total]);

// --- 1) The invoice the plan describes --------------------------------------------
let got = await arrive({});
check('split as the quotation said', rows(got.bill), [[DEV, '900.00'], [SUB, '1500.00']]);
check('…and says why', got.bill.categoryReason, 'Billing plan TB_QU_YAKSON_0001: Subscription, 2 lines as agreed.');
check('published as those lines', got.sent[0]?.LineItems?.map((l: any) => [l.AccountCode, l.UnitAmount]), [['710', 900], ['485', 1500]]);

// --- 2) An amount the plan does not explain -----------------------------------------
got = await arrive({ invoiceNumber: 'INV-0014', date: '2026-10-16', total: 3600 });
check('left as one total, coded by the rule', [rows(got.bill), got.bill.category], [[], SUB]);
check('…and not published, whatever the rule says', [got.sent.length, got.bill.xeroInvoiceId ?? ''], [0, '']);

// --- 3) A covering note that decided something ----------------------------------------
got = await arrive(
  { invoiceNumber: 'INV-0015', date: '2026-11-16', noteFollowed: 'coded as the sender asked' },
  { from: 'dean@acme.sg', subject: 'Fwd: invoice', text: 'please code this to Subscriptions' } as never
);
check('the note’s document is not split', rows(got.bill), []);
check('…and waits for a person', got.sent.length, 0);

// --- 4) Drafting a plan off the quotation --------------------------------------------
const express = (await import('express')).default;
const { extractRouter } = await import('../src/extract.ts');
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/costs', extractRouter);
const server = app.listen(4695, '127.0.0.1');
answer = {
  supplier: 'THE BRIDGERS PTE LTD', reference: 'TB_QU_YAKSON_0001', currency: 'SGD',
  stages: [{ name: 'Subscription', from: '', to: '', quantity: 24, lines: [{ description: 'Subscription', amount: 1500, category: SUB, project: '' }] }],
  notes: ['The start date depends on development completion.'],
};
const res = await fetch('http://127.0.0.1:4695/api/costs/extract-billing-plan', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ imageBase64: PNG, mediaType: 'image/png', accounts: [{ code: '485', name: 'Subscriptions' }] }),
});
const draft = (await res.json()) as any;
check('a draft comes back', [res.status, draft.plan?.stages?.[0]?.lines?.[0]?.amount, draft.notes?.length], [200, 1500, 1]);
check('…with how many invoices the stage runs to', draft.plan?.stages?.[0]?.quantity, 24);

// --- 5) Saved to Billing plans, and back again ----------------------------------------
const { billsRouter } = await import('../src/bills.ts');
app.use('/api/costs', billsRouter);
const paper = insertBill({
  orgId: 'cybm', fileHash: 'hash-quote', fileName: 'quote.png', supplier: 'The Bridgers Pte Ltd', invoiceNumber: 'TB_QU_YAKSON_0001',
  documentType: 'Quotation', currency: 'SGD', total: 2400, tax: 0, date: '2026-03-24', category: '', createdBy: 'dean@acme.sg',
  owner: 'dean@acme.sg', status: 'new', kind: 'cost',
} as never);
const patch = async (body: Record<string, unknown>) => {
  const r = await fetch(`http://127.0.0.1:4695/api/costs/bills/${paper.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', 'X-Org-Id': 'org_one0001' }, body: JSON.stringify(body),
  });
  return ((await r.json()) as any).bill;
};
let filed = await patch({ status: 'archived', billingPlanId: 'p1' });
check('saved to the plan', [filed?.status, filed?.billingPlanId], ['archived', 'p1']);
filed = await patch({ note: 'signed copy to follow' });
check('an ordinary edit keeps it there', filed?.billingPlanId, 'p1');
filed = await patch({ status: 'new' });
check('Unarchive takes it off the plan', filed?.billingPlanId, '');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
await finish(failures, reader, relay, server);
