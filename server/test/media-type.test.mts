// What a file IS, on the two roads nobody is watching.
//
// The upload road refuses anything that is not exactly one of the five types
// the reader takes, and the browser supplies a clean `file.type`. An emailed
// attachment carried whatever the Worker's MIME parser said — `application/
// octet-stream`, `image/jpg`, `application/pdf; name="x.pdf"` — and the reader
// treats only exactly `application/pdf` as a PDF, so a PDF under any other
// label went to OpenAI as an IMAGE and the read failed. The same invoice
// uploaded by hand read fine. Driven over real HTTP against a stubbed reader,
// so what is asserted is the file block that actually goes out.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-media-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.INBOUND_SECRET = 'test-inbound-secret';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_EXTRACT_MODEL = 'gpt-4o-stub';
process.env.LLM_PROVIDER = 'openai';
process.env.ANTHROPIC_API_KEY = '';
process.env.INBOUND_READ_RETRY_MS = '50';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'CY Business Management', tenantId: '', tenantName: '', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

// --- stub reader -------------------------------------------------------------
let failFirst = 0; // how many calls to answer 500 before answering
let calls: string[] = []; // the `input` of each request, serialised
const answer = {
  supplier: 'Fu Zhong Hua (Imp & Exp) Pte Ltd',
  date: '2026-09-08',
  documentType: 'Invoice',
  invoiceNumber: 'FZH-1',
  currency: 'SGD',
  total: 376.05,
  tax: 31.05,
  category: 'Uncategorised',
  categoryReason: 'read',
  description: 'goods',
  lineItems: [],
};
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    calls.push(JSON.stringify(parsed.input ?? []));
    if (failFirst > 0) {
      failFirst -= 1;
      res.statusCode = 500;
      res.end('{"error":"nope"}');
      return;
    }
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
await new Promise<void>((r) => stub.listen(4631, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4631';

const express = (await import('express')).default;
const { inboundRouter } = await import('../src/inbound.ts');
const { ensure, save } = await import('../src/users.ts');
const { listBills, getBillById } = await import('../src/store.ts');
const { readerMediaType, sniffMediaType, declaredMediaType, unreadableTypeNote } = await import('../src/mediaType.ts');

const users = ensure('cybm');
const me = users.find((u) => u.email === 'astridy2004@gmail.com')!;
me.emailHandle = 'astrid4';
me.organisationId = 'org_one0001';
save(users);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/inbound', inboundRouter);
const server = app.listen(4632, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- the pure rules ----------------------------------------------------------
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n%%EOF');
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const HEIC_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic')]);

check('bytes: a PDF is a PDF whatever it is called', sniffMediaType(PDF_BYTES), 'application/pdf');
check('bytes: a PNG', sniffMediaType(PNG_BYTES), 'image/png');
check('bytes: a JPEG', sniffMediaType(JPEG_BYTES), 'image/jpeg');
check('bytes: a HEIC is nothing the reader takes', sniffMediaType(HEIC_BYTES), '');
check('label: parameters are stripped', declaredMediaType('application/pdf; name="x.pdf"'), 'application/pdf');
check('label: image/jpg is image/jpeg', declaredMediaType('Image/JPG'), 'image/jpeg');
check('label: octet-stream says nothing', declaredMediaType('application/octet-stream'), '');
check('bytes beat the label', readerMediaType('image/jpeg', 'x.jpg', PDF_BYTES), 'application/pdf');
check('the name is the last resort', readerMediaType('', 'SCAN.PDF'), 'application/pdf');
check('…and a name that says nothing is nothing', readerMediaType('application/octet-stream', 'IMG_4821'), '');
check('the note names the label it arrived under', unreadableTypeNote('image/heic', 'IMG.HEIC').startsWith('file type image/heic'), true);

// --- over the wire -----------------------------------------------------------
const post = async (attachments: unknown[]) => {
  const res = await fetch('http://127.0.0.1:4632/api/inbound/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inbound-Secret': 'test-inbound-secret' },
    body: JSON.stringify({ to: 'astrid4@cybills.sg', from: 'astridy2004@gmail.com', subject: '', text: '', attachments }),
  });
  return { status: res.status, body: await res.json() };
};

// The read runs after the reply, so wait for it to settle.
const settled = async (fileName: string) => {
  const bill = listBills('cybm').find((b) => b.fileName === fileName)!;
  for (let i = 0; i < 400; i++) {
    const now = getBillById('cybm', bill.id)!;
    if (now.status !== 'processing') return now;
    await new Promise((r) => setTimeout(r, 50));
  }
  return getBillById('cybm', bill.id)!;
};

const fileBlock = (input: string) => {
  const items = JSON.parse(input).flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
  const f = items.find((c: any) => c.type === 'input_file' || c.type === 'input_image');
  if (!f) return '';
  return f.type === 'input_file' ? 'input_file' : String(f.image_url).split(';')[0];
};

// 1) A PDF the mail client labelled as an opaque blob.
calls = [];
let r = await post([{ filename: 'invoice.pdf', contentType: 'application/octet-stream', contentBase64: PDF_BYTES.toString('base64') }]);
check('a PDF labelled octet-stream is filed', [r.status, r.body.created], [200, 1]);
let bill = await settled('invoice.pdf');
check('…read as a PDF', fileBlock(calls[0] ?? '[]'), 'input_file');
check('…successfully', [bill.status, bill.supplier], ['new', 'Fu Zhong Hua (Imp & Exp) Pte Ltd']);
check('…and stored under its real type', bill.contentType, 'application/pdf');

// 2) A PDF whose label still carries its parameters.
calls = [];
r = await post([{ filename: 'inv2.pdf', contentType: 'application/pdf; name="inv2.pdf"', contentBase64: Buffer.concat([PDF_BYTES, Buffer.from('2')]).toString('base64') }]);
bill = await settled('inv2.pdf');
check('a parameterised PDF label is read as a PDF', fileBlock(calls[0] ?? '[]'), 'input_file');

// 3) A photo a phone called image/jpg that is really a PNG.
calls = [];
r = await post([{ filename: 'IMG_1.jpg', contentType: 'image/jpg', contentBase64: PNG_BYTES.toString('base64') }]);
bill = await settled('IMG_1.jpg');
check('an image goes up under the type its bytes say', fileBlock(calls[0] ?? '[]'), 'data:image/png');

// 4) No label at all, an upper-case extension.
calls = [];
r = await post([{ filename: 'SCAN.PDF', contentType: '', contentBase64: Buffer.concat([PDF_BYTES, Buffer.from('4')]).toString('base64') }]);
check('a file with no label is still filed', r.body.created, 1);
bill = await settled('SCAN.PDF');
check('…and read as what its name and bytes say', fileBlock(calls[0] ?? '[]'), 'input_file');

// 5) A kind the reader cannot take is SAID, not sent.
calls = [];
r = await post([{ filename: 'IMG.HEIC', contentType: 'image/heic', contentBase64: HEIC_BYTES.toString('base64') }]);
check('a HEIC is still filed', r.body.created, 1);
bill = await settled('IMG.HEIC');
check('…never sent to the reader', calls.length, 0);
check('…in the inbox', bill.status, 'new');
check('…saying why', String(bill.categoryReason).includes("file type image/heic can't be read"), true);

// 6) A read that threw is tried once more before it is given up on.
// The SDK's own retries come first (three attempts), then one more here.
calls = [];
failFirst = 3;
r = await post([{ filename: 'flaky.pdf', contentType: 'application/pdf', contentBase64: Buffer.concat([PDF_BYTES, Buffer.from('6')]).toString('base64') }]);
bill = await settled('flaky.pdf');
check('a read that outlasted the SDK retries gets one more', calls.length > 3, true);
check('…and the document is read', bill.supplier, 'Fu Zhong Hua (Imp & Exp) Pte Ltd');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
stub.close();
server.close();
process.exit(failures ? 1 : 0);
