// What a meal document says about who was at the table.
//
// A restaurant bill states an amount and says nothing about the only thing
// anybody asks of it afterwards: who it was for. So on the categories where the
// people are half the record, the read asks — and the answer is joined onto the
// description here rather than left for the reader to work into a sentence,
// where it would be written twice as often as not and there would be nothing to
// check.
//
// Driven over real HTTP against a stubbed reader, so what is asserted is the
// prompt that actually goes out and the description that actually comes back.
import http from 'node:http';

process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_EXTRACT_MODEL = 'gpt-4o-stub';
process.env.LLM_PROVIDER = 'openai';
process.env.ANTHROPIC_API_KEY = '';

// --- stub reader -------------------------------------------------------------
let answer: Record<string, unknown> = {};
let calls: Array<{ instructions: string }> = [];

const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    calls.push({ instructions: parsed.instructions ?? '' });
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
await new Promise<void>((r) => stub.listen(4621, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4621';

const express = (await import('express')).default;
const { extractRouter } = await import('../src/extract.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/costs', extractRouter);
const server = app.listen(4622, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const ACCOUNTS = [
  { code: '420', name: 'Entertainment', description: 'Meals and entertaining' },
  { code: '429', name: 'General Expenses', description: 'Anything else' },
];

const read = async (accounts: unknown[] = ACCOUNTS) => {
  calls = [];
  const res = await fetch('http://127.0.0.1:4622/api/costs/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64: PNG, mediaType: 'image/png', accounts }),
  });
  const body = await res.json();
  return { prompt: calls[0]?.instructions ?? '', data: body?.data ?? null };
};

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const FIELDS = {
  supplier: 'Din Tai Fung',
  date: '2026-09-03',
  documentType: 'Receipt',
  invoiceNumber: '',
  currency: 'SGD',
  total: 128.4,
  tax: 0,
  category: '420 - Entertainment',
  categoryReason: 'Restaurant bill',
  noteFollowed: '',
  description: 'Lunch at Din Tai Fung',
  attendees: '',
  dueDate: '',
  period: '',
  cardLast4: '',
  supplierGstRegNo: '',
  taxLabel: '',
  billedTo: '',
  billedToRegNo: '',
  customer: '',
  rebillable: false,
  taxRate: '',
  taxRateReason: '',
  project: '',
  projectReason: '',
  baseCurrency: '',
  baseTotal: 0,
  baseTax: 0,
  exchangeRate: 0,
  lineItems: [],
};

// --- 1) The question is asked, and it names this entity's own categories ------
answer = { ...FIELDS };
let r = await read();
check('the read is asked who was there', r.prompt.includes('WHO WAS THERE.'), true);
check('and the entertainment account is named', r.prompt.includes('- "420 - Entertainment"'), true);
// Named, not described: the chart has already made the judgement, and a reader
// left to decide which of its accounts is "an entertainment one" would answer
// differently on every document.
check('the general one is not', r.prompt.includes('- "429 - General Expenses"\n- "420'), false);
// Nothing is asked of an entity with no such category — one fewer paragraph in
// a prompt that already runs to thousands of tokens.
r = await read([{ code: '429', name: 'General Expenses', description: 'Anything else' }]);
check('no such category, no paragraph', r.prompt.includes('WHO WAS THERE.'), false);

// --- 2) The answer is joined onto the description ----------------------------
answer = { ...FIELDS, attendees: 'Kai Tan and two of the ARC3 team' };
r = await read();
check('who was there is on the description', r.data.description, '* Lunch at Din Tai Fung — attendees: Kai Tan and two of the ARC3 team');

// --- 3) And so is the silence ------------------------------------------------
// The reader found nothing about the people, which is what an entertainment
// expense with no guest list actually is: an incomplete record. Said out loud,
// because a blank there is indistinguishable from a meal whose guests did not
// matter — and this is the line that sends a reviewer to fill them in.
answer = { ...FIELDS, attendees: '' };
r = await read();
check('nobody recorded, and it says so', r.data.description, '* Lunch at Din Tai Fung — attendees not stated');

// Filler is not an answer. A model told a field must be filled reaches for
// "N/A", which would publish to the ledger as though somebody had checked.
answer = { ...FIELDS, attendees: 'N/A' };
r = await read();
check('filler is not a guest list', r.data.description, '* Lunch at Din Tai Fung — attendees not stated');

// --- 4) Every other cost is left exactly as it was read ----------------------
answer = { ...FIELDS, supplier: 'Grab', category: '429 - General Expenses', description: 'Grab ride Jurong to Raffles', attendees: '' };
r = await read();
check('a taxi keeps its own description', r.data.description, '* Grab ride Jurong to Raffles');

// --- 5) The period and the people both fit ----------------------------------
// Two things appended to one description, and neither may swallow the other.
answer = { ...FIELDS, description: 'Client dinner', period: 'August 2026', attendees: '6 pax' };
r = await read();
check('both said, once each', r.data.description, '* Client dinner (August 2026) — attendees: 6 pax');

// --- 6) And every description a READ wrote carries its star -------------------
// Two hands write a description — the reader's and a person's — and in the
// ledger they look identical. The star says which, on the whole composed
// sentence, and it is never doubled however many times the text is composed.
answer = { ...FIELDS, description: '* Lunch at Din Tai Fung', attendees: '' };
r = await read();
check('the star is not doubled', r.data.description, '* Lunch at Din Tai Fung — attendees not stated');
// Even where the reader gave nothing usable and the description was composed
// from the supplier and the category it was coded to.
answer = { ...FIELDS, description: '', category: '429 - General Expenses', supplier: 'Singtel', attendees: '' };
r = await read();
check('a composed description too', r.data.description, '* Singtel — General Expenses');

// --- 7) A read that got nothing gets no marker -------------------------------
// There is no description to append to, and "attendees not stated" on its own
// describes nothing at all — which is also what tells the inbox this document
// read as blank.
answer = { ...FIELDS, supplier: '', description: '', total: 0, attendees: '' };
r = await read();
check('nothing read, nothing said', r.data.description, '');

server.close();
stub.close();
console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exit(failures ? 1 : 0);
