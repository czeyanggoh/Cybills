// What is not a bill does not stand in the Costs inbox as one.
//
// Two documents in Red Alpha's inbox (16 Nov 2026) that were never costs:
//   - Pan Pacific's promotional banner, embedded in the signature of an email
//     whose BODY carried the real thing (a payment link). The banner was big
//     enough not to read as a logo, so it was filed, read as "Other", and sat
//     in the inbox as a cost.
//   - A Lazada "your order is confirmed!" email with nothing attached, whose
//     storefront and tracking links stood a "Trust this sender?" document in
//     the inbox.
// The first is set aside to Archived by the reader's own verdict; the second
// is mirrored on the Email tab and files nothing. A payment-link mail still
// asks, and a banner-only mail that is ABOUT a payment falls through to asking.
// Driven over real HTTP with a stub reader and a stub n8n.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-not-a-bill-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.INBOUND_SECRET = 'test-inbound-secret';
process.env.N8N_FETCH_URL = 'http://127.0.0.1:4732/webhook/fetch';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_EXTRACT_MODEL = 'gpt-4o-stub';
process.env.LLM_PROVIDER = 'openai';
process.env.ANTHROPIC_API_KEY = '';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'Red Alpha', tenantId: '', tenantName: '', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

// --- stub reader -------------------------------------------------------------
let answer: Record<string, unknown> = {};
const reader = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
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
await new Promise<void>((r) => reader.listen(4731, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4731';

// n8n exists so links are followable; never called (nobody is trusted).
let n8nCalls = 0;
const n8n = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    n8nCalls += 1;
    res.setHeader('content-type', 'application/json');
    res.end('[]');
  });
});
await new Promise<void>((r) => n8n.listen(4732, '127.0.0.1', r));

const express = (await import('express')).default;
const { inboundRouter, autoRead, readAsNotABill } = await import('../src/inbound.ts');
const { looksLikeBillMail } = await import('../src/emailPdf.ts');
const { ensure, save } = await import('../src/users.ts');
const { insertBill, getBillById, listBills } = await import('../src/store.ts');
const { loadMail } = await import('../src/mailThread.ts');

const users = ensure('cybm');
const me = users.find((u) => u.email === 'astridy2004@gmail.com')!;
me.emailHandle = 'amex';
me.organisationId = 'org_one0001';
save(users);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/inbound', inboundRouter);
const server = app.listen(4733, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

const FIELDS = {
  supplier: '', date: '', documentType: 'Other', invoiceNumber: '', currency: '', total: 0, tax: 0,
  category: 'Uncategorised', categoryReason: '', noteFollowed: '', description: '', dueDate: '',
  period: '', cardLast4: '', supplierGstRegNo: '', taxLabel: '', billedTo: '', billedToRegNo: '',
  customer: '', rebillable: false, taxRate: '', taxRateReason: '', project: '', projectReason: '',
  baseCurrency: '', baseTotal: 0, baseTax: 0, exchangeRate: 0, lineItems: [],
};
const BANNER = { ...FIELDS, supplier: 'Pan Pacific Singapore', description: 'Promotional banner for festive dining' };

// --- the rule itself -----------------------------------------------------------
check('Other with no amount is not a bill', readAsNotABill({ documentType: 'Other', total: 0, lineItems: [] }), true);
check('Other WITH an amount is kept (a letter asking for a fee)', readAsNotABill({ documentType: 'Other', total: 120, lineItems: [] }), false);
check('an Invoice with no total is kept', readAsNotABill({ documentType: 'Invoice', total: 0, lineItems: [] }), false);
check('the Lazada order confirmation is not about a bill', looksLikeBillMail('Hey Sefi, your order is confirmed!', 'Thank you for ordering from Lazada! You can check your order status here.', ''), false);
check('a payment-link mail is', looksLikeBillMail('Re: meeting room reservation', 'Please find payment link below for your soonest action.', ''), true);
check('a Xero subscription mail is', looksLikeBillMail('Your Xero invoice', 'View your bill online: INV-7822201', ''), true);

// --- autoRead: a read that found a non-bill is set aside -------------------------
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const req = { headers: {} } as never;
let n = 0;
const arrive = async () => {
  n += 1;
  const bill = insertBill({
    orgId: 'cybm', fileHash: `hash-${n}`, fileName: `f-${n}.png`, supplier: '', invoiceNumber: '', documentType: '',
    currency: '', total: 0, tax: 0, date: '', category: '', createdBy: 'astridy2004@gmail.com', owner: 'astridy2004@gmail.com',
    status: 'processing', kind: 'cost',
  } as never);
  const end = await autoRead(req, 'cybm', 'org_one0001', 'openai', bill.id, PNG, 'image/png');
  return { end, bill: getBillById('cybm', bill.id) };
};

answer = BANNER;
let r = await arrive();
check('a banner read as Other is set aside to Archived', [r.end, r.bill?.status], ['set_aside', 'archived']);
check('…saying why, on the row', String(r.bill?.categoryReason || '').startsWith('Set aside: not an invoice, receipt or request for payment'), true);

answer = { ...FIELDS, supplier: 'Pan Pacific Singapore', documentType: 'Invoice', total: 480, date: '2026-11-11' };
r = await arrive();
check('an invoice is filed as before', r.bill?.status === 'archived', false);

answer = { ...FIELDS };
r = await arrive();
check('a BLANK read still lands in the inbox (a person decides)', r.bill?.status, 'new');

// --- inbound mail ----------------------------------------------------------------
const CRLF = '\r\n';
const b64 = (buf: Buffer) => buf.toString('base64').replace(/.{76}/g, `$&${CRLF}`);
const deliver = async (raw: string) => {
  const res = await fetch('http://127.0.0.1:4733/api/inbound/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inbound-Secret': 'test-inbound-secret' },
    body: JSON.stringify({ raw: Buffer.from(raw).toString('base64') }),
  });
  return (await res.json()) as Record<string, unknown>;
};

// The Lazada order confirmation: nothing attached, storefront + tracker links.
const before = listBills('cybm').length;
await deliver([
  'From: sefi@redalphacyber.com',
  'To: amex@cybills.sg',
  'Subject: Fw: Hey Sefi Kirshberg, your order is confirmed!',
  'Message-ID: <lazada-1@redalphacyber.com>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Thank you for ordering from Lazada! You can check your order status here.',
  'https://sg.mmstat.com//lzdmailer.module.exp?mail_id=b039&email_type=promotion',
  'https://c.lazada.sg/t/c.2I2p?sub_id1=promotion&url=https%3A%2F%2Fmy.lazada.com.sg%2Fcustomer%2Forder%2Fview%2F',
  '',
].join(CRLF));
await settle();
check('an order confirmation with no attachment files nothing', listBills('cybm').length, before);
const lz = loadMail().find((m) => m.id === '<lazada-1@redalphacyber.com>');
check('…and is still mirrored on the Email tab, links and all', [Boolean(lz), (lz?.links.length || 0) > 0, lz?.outcome], [true, true, 'nothing']);

// A payment-link mail with nothing attached still asks.
await deliver([
  'From: sefi@redalphacyber.com',
  'To: amex@cybills.sg',
  'Subject: Fw: meeting room reservation',
  'Message-ID: <pp-link@redalphacyber.com>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Please find payment link below for your soonest action, thank you.',
  'https://pgwv4.2c2p.com/qpv2/1.0/QuickPay/FZWA7',
  '',
].join(CRLF));
await settle();
check('a payment-link mail stands a "Trust sender?" document in the inbox',
  listBills('cybm').some((b) => b.emailLink?.messageId === '<pp-link@redalphacyber.com>' && b.emailLink.status === 'awaiting_trust'), true);

// The Pan Pacific case: a big banner embedded in the body, a payment link in the text.
answer = BANNER;
const PNG_HEAD = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const BANNER_BYTES = Buffer.concat([PNG_HEAD, Buffer.alloc(150000, 3)]);
await deliver([
  'From: sefi@redalphacyber.com',
  'To: amex@cybills.sg',
  'Subject: Fw: Red Alpha - meeting room reservation',
  'Message-ID: <pp-banner@redalphacyber.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/related; boundary="rel"',
  '',
  '--rel',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Please find payment link below for your soonest action, thank you.</p><p>https://pgwv4.2c2p.com/qpv2/1.0/QuickPay/AB123</p><img src="cid:banner1">',
  '--rel',
  'Content-Type: image/png',
  'Content-ID: <banner1>',
  'Content-Disposition: inline',
  'Content-Transfer-Encoding: base64',
  '',
  b64(BANNER_BYTES),
  '--rel--',
  '',
].join(CRLF));
await settle(800);
const pp = listBills('cybm').filter((b) => b.email?.subject === 'Fw: Red Alpha - meeting room reservation');
const bannerDoc = pp.find((b) => b.storageKey);
check('the banner is set aside, not left in the inbox', bannerDoc?.status, 'archived');
check('…and the payment link it came with asks instead',
  pp.some((b) => b.emailLink?.messageId === '<pp-banner@redalphacyber.com>' && b.emailLink.status === 'awaiting_trust'), true);
check('…recorded on the mail', Boolean(loadMail().find((m) => m.id === '<pp-banner@redalphacyber.com>')?.pendingBillId), true);
check('nothing was fetched without trust', n8nCalls, 0);

// --- An invoice typed into the email itself, nothing attached ---------------------
const { statesBillAmount } = await import('../src/emailPdf.ts');
check('"Total: S$1,200" with no cents is an inline bill', statesBillAmount('Invoice INV-204', 'Consulting, October.\nTotal: S$1,200', ''), true);
check('"Total payable 480" is', statesBillAmount('Your bill for November', 'Room hire 3 hours\nTotal payable 480', ''), true);
check('"Fee: SGD 350.00" on a payment request is', statesBillAmount('Payment request', 'Course fee: SGD 350.00, please pay by Friday', ''), true);
check('a promotion with prices is not', statesBillAmount('Invoice your clients faster', 'Plans from $9.00 a month', ''), false);
check('an order confirmation with a total is not (not about a bill)', statesBillAmount('Your order is confirmed!', 'Total: $45.20', ''), false);

const inline = async (id: string, subject: string, body: string) => {
  await deliver([
    'From: sefi@redalphacyber.com',
    'To: amex@cybills.sg',
    `Subject: ${subject}`,
    `Message-ID: <${id}@redalphacyber.com>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '',
  ].join(CRLF));
  await settle(800);
  return listBills('cybm').filter((b) => b.email?.subject === subject);
};
answer = { ...FIELDS, supplier: 'Acme Consulting', documentType: 'Invoice', total: 1200, date: '2026-11-10' };
let docs = await inline('inline-1', 'Invoice INV-204 from Acme', 'Consulting for October.\nTotal: S$1,200\nPlease pay to UOB 123-456-789.');
check('an inline invoice with a round total is saved as a PDF and filed', [docs.length, docs[0]?.contentType, docs[0]?.status === 'archived'], [1, 'application/pdf', false]);
docs = await inline('inline-2', 'Invoice INV-205 from Acme', 'Your invoice is ready.\nAmount due: SGD 99\nhttps://acme.example/files/INV-205.pdf');
check('…but one whose link IS the file waits for the link instead', [docs.length, docs[0]?.emailLink?.status], [1, 'awaiting_trust']);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
await finish(failures, server, reader, n8n);
