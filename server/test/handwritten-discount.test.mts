// The total is what was PAID, and the paper is not always finished at the
// printed total.
//
// A HaveFun KTV bill printed 993.38; the merchant wrote "-$200.00" under it and
// "$793.38" beneath that, and the UOB card slip photographed beside it charged
// 793.38. The read took the printed 993.38, because the schema said only "Grand
// total amount" and nothing anywhere said that a figure written on afterwards,
// or a slip charging something else, could be the answer. So the rule is said,
// in the cached prompt and on the field: a card slip's amount first, else a
// handwritten DEDUCTION, and a larger handwritten figure (a tip) only where a
// slip charged it. The printed GST stays as printed.
//
// Driven over real HTTP against a stubbed reader, so what is asserted is the
// request that goes out — the system prompt and the schema together.
import http from 'node:http';
import { finish } from './support.mts';

process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_EXTRACT_MODEL = 'gpt-4o-stub';
process.env.LLM_PROVIDER = 'openai';
process.env.ANTHROPIC_API_KEY = '';

let sent: any = null;

const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    sent = JSON.parse(body || '{}');
    const out = JSON.stringify({
      supplier: 'HaveFun KTV', date: '2026-10-20', documentType: 'Receipt',
      invoiceNumber: 'T261020184706002', currency: 'SGD', total: 793.38, tax: 74.57,
      category: '420 - Entertainment', categoryReason: 'KTV', noteFollowed: '',
      description: 'KTV session with food and drinks after a 200.00 discount written on the bill',
      dueDate: '', period: '', cardLast4: '9482', supplierGstRegNo: '', taxLabel: 'GST-9%', billedTo: '', billedToRegNo: '',
      customer: '', rebillable: false, taxRate: '', taxRateReason: '', project: '', projectReason: '',
      baseCurrency: '', baseTotal: 0, baseTax: 0, exchangeRate: 0, lineItems: [], printedTotal: 993.38,
    });
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-4o-stub', output_text: out,
        output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: out, annotations: [] }] }],
        usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 0 } },
      })
    );
  });
});
await new Promise<void>((r) => stub.listen(4751, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4751';

const express = (await import('express')).default;
const { extractRouter } = await import('../src/extract.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/costs', extractRouter);
const server = app.listen(4752, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

sent = null;
const res = await fetch('http://127.0.0.1:4752/api/costs/extract', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    imageBase64: PNG,
    mediaType: 'image/png',
    accounts: [{ code: '420', name: 'Entertainment', description: 'Client and staff entertainment' }],
  }),
});
const data = (await res.json())?.data ?? null;

const system = String(sent?.instructions ?? '');
const schema = JSON.stringify(sent?.text?.format?.schema ?? sent?.response_format ?? {});

// --- the cached prompt says what the total is --------------------------------
check('the total is what was paid', system.includes('The `total` is the amount actually PAID'), true);
check('the handwritten discount case is described', system.includes('"-$200.00" written under the printed 993.38'), true);
check('a card slip in the same image decides first', system.includes('Where a card slip or payment record in the same image states the amount charged, that amount is the total'), true);
check('else a handwritten deduction', system.includes('a handwritten DEDUCTION with the figure it leaves is taken'), true);
// A larger number is the one somebody could write on to claim more.
check('a larger handwritten figure needs a slip', system.includes('a handwritten figure HIGHER than the printed total (a tip) is taken only where a card slip on the same image charged it'), true);
check('the printed GST is left as printed', system.includes('Leave `tax` as the GST figure PRINTED'), true);

// --- and the field says it too ----------------------------------------------
check('the total field is no longer bare "Grand total amount"', schema.includes('"Grand total amount"'), false);
check('the total field carries the paid rule', schema.includes('The amount actually PAID'), true);
// A Cold Storage receipt paid "yuu Points 1.22 / MASTER 9.28" against a printed
// "GST AMT 0.87" came back total 9.28, tax 0 — and was coded No Tax (29 Oct
// 2026). The bare "0 if none shown" on the tax field is what let it.
check('points or a voucher: the card part is the total', system.includes('settled partly by loyalty points, a voucher or a gift card'), true);
check('…and the GST is never zeroed for it', system.includes('never 0 because the total moved'), true);
check('the tax field is no longer bare "0 if none shown"', schema.includes('Tax / GST amount; 0 if none shown'), false);
check('the tax field keeps the printed GST when the total is smaller', schema.includes('It stays the printed figure even where `total` is a smaller amount actually paid'), true);
check('the bill total is asked for when less was paid', schema.includes('"printedTotal"') && system.includes('put that printed total in `printedTotal`'), true);

// --- what the reader answers is what is stored --------------------------------
check('the paid total comes back', data?.total, 793.38);
check('beside the printed GST', data?.tax, 74.57);
check('the bill total read comes back', data?.printedTotal, 993.38);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
await finish(failures, server, stub);
