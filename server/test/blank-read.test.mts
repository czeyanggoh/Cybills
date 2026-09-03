// A document the reader got nothing off does not join the work.
//
// The Costs inbox is the working list, and on the WhatsApp road a photo taken
// in a car park is an ordinary event: the read runs, costs a model call, and
// comes back with no supplier, no total, no date, no reference and no rows.
// Filed, that document sits in the inbox wearing "Nothing read" — indefinitely,
// because there is nothing on it for a reviewer to type in. Ten of those beside
// two real ones is a working list that has stopped being one.
//
// So it is SET ASIDE instead: kept, in Archived and in Submission history,
// still wearing the badge that says why. What must not happen is the same
// treatment for a document that was never read at all — a reader switched off,
// a read that threw, a process that died — because that document looks
// identical and means the opposite: nobody has looked at it yet.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-blank-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_EXTRACT_MODEL = 'gpt-4o-stub';
process.env.LLM_PROVIDER = 'openai';
process.env.ANTHROPIC_API_KEY = '';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'CY Business Management', tenantId: '', tenantName: '', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

// --- stub reader -------------------------------------------------------------
let answer: Record<string, unknown> | null = null; // null = the read fails outright
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (!answer) {
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
await new Promise<void>((r) => stub.listen(4621, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4621';

const { autoRead } = await import('../src/inbound.ts');
const { insertBill, getBillById } = await import('../src/store.ts');
const { readGotNothing } = await import('../src/blankRead.ts');

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const req = { headers: {} } as never;

let n = 0;
const arrive = async () => {
  n += 1;
  const bill = insertBill({
    orgId: 'cybm',
    fileHash: `hash-${n}`,
    fileName: `photo-${n}.png`,
    supplier: '',
    invoiceNumber: '',
    documentType: '',
    currency: '',
    total: 0,
    tax: 0,
    date: '',
    category: '',
    createdBy: 'dean@acme.sg',
    owner: 'dean@acme.sg',
    // Both background roads create it as being read, and this is the state the
    // read settles out of.
    status: 'processing',
    kind: 'cost',
  } as never);
  await autoRead(req, 'cybm', 'org_one0001', 'openai', bill.id, PNG, 'image/png');
  return getBillById('cybm', bill.id);
};

const FIELDS = {
  // 'Other' rather than '': documentType is an enum, and a reader that got
  // nothing off a file still has to answer with one of its three words.
  supplier: '', date: '', documentType: 'Other', invoiceNumber: '', currency: '', total: 0, tax: 0,
  category: 'Uncategorised', categoryReason: '', noteFollowed: '', description: '', dueDate: '',
  period: '', cardLast4: '', supplierGstRegNo: '', taxLabel: '', billedTo: '', billedToRegNo: '',
  customer: '', rebillable: false, taxRate: '', taxRateReason: '', project: '', projectReason: '',
  baseCurrency: '', baseTotal: 0, baseTax: 0, exchangeRate: 0, lineItems: [],
};

// --- 1) The reader saw nothing ----------------------------------------------
answer = { ...FIELDS };
let bill = await arrive();
check('a blank read is set aside, not filed', bill?.status, 'archived');
// Kept, not thrown away: the file is still there and the row is still a
// submission, which is the whole difference between this and deleting it.
check('…and the document is still there', Boolean(bill), true);
// The badge that explains it is derived from the same rule, so Archived and
// Submission history can say why it is there.
check('…and still reads as blank, which is what the badge says', await readGotNothing(bill), true);

// --- 2) A read that got something ------------------------------------------
answer = { ...FIELDS, supplier: 'Singtel', total: 1098.57, date: '2026-09-03' };
bill = await arrive();
check('a document with something on it is filed', bill?.status, 'new');
check('…and does not read as blank', await readGotNothing(bill), false);

// One fact is enough. A receipt whose total the reader found and whose supplier
// it could not is real work waiting for a person — the opposite of a blank.
answer = { ...FIELDS, total: 31.99 };
bill = await arrive();
check('a total alone is enough to be filed', bill?.status, 'new');

// --- 3) A read that never happened ------------------------------------------
// The distinction the whole change rests on. This document looks exactly like
// the first one and means the opposite: nobody has read it yet, so it belongs
// in the inbox where somebody will.
answer = null;
bill = await arrive();
check('a failed read lands in the inbox', bill?.status, 'new');
check('…saying so, where the reviewer will see it', String(bill?.categoryReason || '').includes("Auto-read didn't complete"), true);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
stub.close();
process.exit(failures ? 1 : 0);
