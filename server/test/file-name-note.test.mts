// What the sender called the file, and what that is allowed to decide.
//
// A document reaches CYBills three ways and only two of them can carry a typed
// message — but every one of them carries a FILE NAME, and on the commonest
// road of all (a file dropped into a WhatsApp collection group with no caption)
// the name is the only thing the sender wrote down. So it goes to the reader.
//
// The whole of the care is in what it is NOT. A name is a label, not evidence
// and not an instruction: it may help decide what a document is FOR, it may
// never supply a fact about the document, and it may never outrank the standing
// rule an entity wrote about that supplier. Driven over real HTTP against a
// stubbed reader, so what is asserted is the prompt that actually goes out.
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
await new Promise<void>((r) => stub.listen(4611, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4611';

const express = (await import('express')).default;
const { extractRouter } = await import('../src/extract.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/costs', extractRouter);
const server = app.listen(4612, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const read = async (emailNote: Record<string, unknown> | null) => {
  calls = [];
  const res = await fetch('http://127.0.0.1:4612/api/costs/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageBase64: PNG,
      mediaType: 'image/png',
      accounts: [{ code: '429', name: 'General Expenses', description: 'Anything else' }],
      ...(emailNote ? { emailNote } : {}),
    }),
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
  supplier: 'Singtel',
  date: '2026-09-03',
  documentType: 'Invoice',
  invoiceNumber: '',
  currency: 'SGD',
  total: 1098.57,
  tax: 0,
  category: '429 - General Expenses',
  categoryReason: 'Telco bill',
  noteFollowed: '',
  description: 'Mobile and broadband',
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

// --- 1) A name somebody typed reaches the reader -----------------------------
answer = { ...FIELDS };
let r = await read({ via: 'upload', from: '', subject: '', text: '', fileName: 'Singtel tiffinlabs paid.pdf' });
check('the name is in the prompt, opened out', r.prompt.includes('named the file "Singtel tiffinlabs paid"'), true);
// And said to be what it is. Without this line the reader takes the supplier
// off the name while the paper in front of it says something else — and a
// supplier read off a file name goes on to match a supplier rule, a duplicate,
// and a contact in somebody's ledger.
check('…and is called a label, not evidence', r.prompt.includes('NEVER evidence about the document itself'), true);
// A name is not a covering message, so the message paragraph is not written.
check('no covering-message paragraph was invented for it', r.prompt.includes('the covering message is below'), false);

// --- 2) A name a device wrote reaches nobody ---------------------------------
r = await read({ via: 'whatsapp', from: 'Dean', subject: '', text: '', fileName: 'IMG_4821.jpg' });
check('a camera name is left out of the prompt entirely', r.prompt.includes('named the file'), false);
// The one that matters: it is nothing but a date, in front of a reader whose
// job at that moment is to find the document's date.
r = await read({ via: 'whatsapp', from: 'Dean', subject: '', text: '', fileName: 'WhatsApp Image 2026-09-03 at 11.19.00.jpeg' });
check('nor a name that is only the moment it arrived', r.prompt.includes('named the file'), false);

// --- 3) A name can never beat a standing rule --------------------------------
// `noteFollowed` is the flag that lets a note outrank the supplier rule. Every
// document now arrives carrying a file name, so a reader that answered this off
// the name would quietly overrule "everything from Grab is travel" on every
// document Grab ever sent. Enforced here rather than asked for in the prompt.
answer = { ...FIELDS, noteFollowed: 'The file name said tiffinlabs — coded to the recharge account.' };
r = await read({ via: 'upload', from: '', subject: '', text: '', fileName: 'Singtel tiffinlabs paid.pdf' });
check('a name cannot fill noteFollowed', r.data.noteFollowed, '');

// A typed message still can — that is the whole point of the field.
answer = { ...FIELDS, noteFollowed: 'The sender asked to recharge this to CY-Biz.' };
r = await read({ via: 'whatsapp', from: 'Dean', subject: '', text: 'recharge this to CY-Biz', fileName: 'Singtel tiffinlabs paid.pdf' });
check('a message still fills it', r.data.noteFollowed, 'The sender asked to recharge this to CY-Biz.');
check('and both reach the reader, each said to be what it is', [r.prompt.includes('named the file "Singtel tiffinlabs paid"'), r.prompt.includes('SENT IN OVER WHATSAPP')], [true, true]);

// A document that arrived with nothing at all is unchanged: no note, no name,
// no paragraph, and the org's own rules decide.
answer = { ...FIELDS, noteFollowed: 'invented' };
r = await read(null);
check('an unnamed document adds nothing to the prompt', r.prompt.includes('named the file'), false);
check('…and nothing was followed', r.data.noteFollowed, '');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
server.close();
stub.close();
process.exit(failures ? 1 : 0);
