// The date is read off the document, and nothing else may move it.
//
// A whole batch of GrabFood order summaries came back dated 31 Oct 2025 against
// receipts that plainly said "Delivered on 30 Sep 12:37". Nothing in CYBills had
// touched them — a supplier rule's Invoice date only ever moves a date BACK to
// the end of the month before, and is matched per supplier — so the date came
// out of the read, and the prompt was the thing that had nothing to say about
// this case: an app order summary prints a day and a month and NO YEAR, and the
// schema asked for ISO YYYY-MM-DD while saying only "empty string if no date is
// printed". A reader that must produce a year, told nothing about how, is free
// to produce a date that is on no part of the paper.
//
// So the rule is in two halves, and both must actually go out: the day and month
// printed are FACTS, and only the YEAR is ever supplied. Driven over real HTTP
// against a stubbed reader, so what is asserted is the request that goes out —
// the system prompt, the schema and the per-document message together.
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
      supplier: 'Feng Ji Chicken Rice (River Valley Road)', date: '2025-09-30', documentType: 'Receipt',
      invoiceNumber: 's2gt-2540-3acb', currency: 'SGD', total: 88.6, tax: 0,
      category: '429 - General Expenses', categoryReason: 'Meal', noteFollowed: '', description: 'Lunch',
      dueDate: '', period: '', cardLast4: '', supplierGstRegNo: '', taxLabel: '', billedTo: '', billedToRegNo: '',
      customer: '', rebillable: false, taxRate: '', taxRateReason: '', project: '', projectReason: '',
      baseCurrency: '', baseTotal: 0, baseTax: 0, exchangeRate: 0, lineItems: [],
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
await new Promise<void>((r) => stub.listen(4631, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4631';

const express = (await import('express')).default;
const { extractRouter } = await import('../src/extract.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/costs', extractRouter);
const server = app.listen(4632, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

sent = null;
const res = await fetch('http://127.0.0.1:4632/api/costs/extract', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    imageBase64: PNG,
    mediaType: 'image/png',
    accounts: [{ code: '429', name: 'General Expenses', description: 'Anything else' }],
    // What the entity wrote in Review instructions rides in the same prompt and
    // is told it may override the printed GST and the coding. The date is the
    // line it may not cross, which is the whole point of the rule below.
    instructions: 'These are the October 2025 staff meal claims.',
  }),
});
const data = (await res.json())?.data ?? null;

const system = String(sent?.instructions ?? '');
const schema = JSON.stringify(sent?.text?.format?.schema ?? sent?.response_format ?? {});
const message = JSON.stringify(sent?.input ?? '');

// --- the day and month are facts --------------------------------------------
check('the read still starts from what is printed', system.includes('Read the day and month exactly'), true);
check('and nothing may shift it to a month or period end', system.includes('never shift a date to a month end, a period end, a claim period'), true);
// Named one by one, because each of the three is a real road into the prompt:
// the entity's Review instructions, an emailed covering line, and the file name.
check('…named: the business context', system.includes('the business context'), true);
check('…the covering message', system.includes('the covering message'), true);
check('…and the file name', system.includes('the file name suggests'), true);

// --- only the year is ever supplied -----------------------------------------
check('the missing-year case is described', system.includes('Delivered on 30 Sep 12:37'), true);
check('and only the year is supplied', system.includes('supply only the year'), true);
check('from the document first', system.includes('first from elsewhere on the same document'), true);
check('and never into the future', system.includes('must never put the date in the future'), true);

// --- the schema says it too, where the field is ------------------------------
// The description travels with the field, and a model reading the schema alone
// must not find the old "empty string if no date is printed" standing by itself.
check('the date field carries the day/month rule', schema.includes('DAY and MONTH printed are facts'), true);
check('…and the no-year rule', schema.includes('A date printed with NO YEAR'), true);
check('…and asks for a blank only when there is no date at all', schema.includes('Empty string only when NO date at all is printed'), true);

// --- the year rule has an anchor --------------------------------------------
// "The most recent occurrence that is not in the future" means nothing without
// today's date, which rides on the per-document message rather than the cached
// system prompt — it would invalidate the cache daily.
check('today is still stated per document', /Today is \d{4}-\d{2}-\d{2}\./.test(message), true);
check('and not in the cached prompt', /Today is \d{4}-\d{2}-\d{2}\./.test(system), false);

// --- and the read still comes back whole -------------------------------------
check('the date read off the paper is what is stored', data?.date, '2025-09-30');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
await finish(failures, server, stub);
