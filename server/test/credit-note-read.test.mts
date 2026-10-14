// A credit note is read AS one, whatever it is titled.
//
// QBE refunds part of a premium on a page headed TAX INVOICE: "Premium 72.38-",
// "GST @ 9.00% 6.51-", "Total Due 78.89-", and one line saying "this is a Credit
// Note and no payment is required". The general read's type list had no credit
// note in it at all, so the reader could only answer Invoice, and an Invoice
// with a negative total is refused as incomplete ("Missing: Total amount").
//
// Two halves, both asserted over real HTTP against a stubbed reader: the type
// is OFFERED (schema and prompt), and a credit note's figures come back
// POSITIVE whatever the reader did with the sign, because every tax rule reads
// a document by asking whether its tax is above 0.
import http from 'node:http';
import { finish } from './support.mts';

process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_EXTRACT_MODEL = 'gpt-4o-stub';
process.env.LLM_PROVIDER = 'openai';
process.env.ANTHROPIC_API_KEY = '';

let sent: any = null;
let answer: any = {};

const BASE = {
  supplier: 'QBE Insurance (Singapore) Pte Ltd', date: '2026-09-02', documentType: 'Credit note/refund',
  invoiceNumber: '08-B0039228-BIZ-E001-T00008', currency: 'SGD', total: -78.89, tax: -6.51,
  category: '433 - Insurance', categoryReason: 'Insurance', noteFollowed: '', description: 'Credit note for insurance premium',
  dueDate: '', period: '', cardLast4: '', supplierGstRegNo: 'M200644018', taxLabel: 'GST @ 9.00%', billedTo: '', billedToRegNo: '',
  customer: '', rebillable: false, taxRate: '', taxRateReason: '', project: '', projectReason: '',
  baseCurrency: '', baseTotal: 0, baseTax: 0, exchangeRate: 0,
  lineItems: [{ description: 'Premium', amount: -78.89, net: -72.38, tax: -6.51 }],
};

const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    sent = JSON.parse(body || '{}');
    const out = JSON.stringify(answer);
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
await new Promise<void>((r) => stub.listen(4641, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4641';

const express = (await import('express')).default;
const { extractRouter } = await import('../src/extract.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/costs', extractRouter);
const server = app.listen(4642, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const read = async () => {
  const res = await fetch('http://127.0.0.1:4642/api/costs/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageBase64: PNG,
      mediaType: 'image/png',
      accounts: [{ code: '433', name: 'Insurance', description: 'Insurance premiums' }],
    }),
  });
  return (await res.json()) as any;
};

answer = BASE;
let body = await read();
const all = JSON.stringify(sent);
check('the read succeeds', body.ok, true);
check('the type list offers a credit note', all.includes('"Credit note/refund"'), true);
check('the prompt names the trailing minus', all.includes('78.89-'), true);
check('the prompt says the title does not decide it', all.includes('TAX INVOICE'), true);
check('it comes back as a credit note', body.data?.documentType, 'Credit note/refund');
check('the total is positive', body.data?.total, 78.89);
check('the tax is positive', body.data?.tax, 6.51);
check('the line is positive', [body.data?.lineItems?.[0]?.amount, body.data?.lineItems?.[0]?.net, body.data?.lineItems?.[0]?.tax], [78.89, 72.38, 6.51]);

// An ordinary invoice is not touched: a negative total there is a misread, and
// it must stay visible as one rather than be turned into a charge.
answer = { ...BASE, documentType: 'Invoice' };
body = await read();
check('an invoice keeps the sign it was read with', body.data?.total, -78.89);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
await finish(failures, server, stub);
