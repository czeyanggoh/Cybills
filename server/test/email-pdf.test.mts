// The email itself, as the document.
//
// Some mail has nothing behind its links — they are a logo and a mail client's
// footer — and the paperwork is the body. The document it left in the inbox
// would be published to Xero with no paper at all, so the message is written
// out as a PDF and attached to the row that was asking.
//
// Driven over real HTTP: the inbound endpoint as the Worker calls it, then the
// route the page presses.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-email-pdf-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.INBOUND_SECRET = 'test-inbound-secret';
process.env.N8N_FETCH_URL = 'http://127.0.0.1:4663/never-called';
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-1', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org_two0002', orgId: 'cybm', name: 'Red Alpha', tenantId: 't-2', tenantName: 'Red Alpha', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const { PDFDocument } = await import('pdf-lib');
const { inboundRouter } = await import('../src/inbound.ts');
const { emailRouter } = await import('../src/email.ts');
const { ensure, save } = await import('../src/users.ts');
const { listBills, updateBill } = await import('../src/store.ts');
const { loadMail } = await import('../src/mailThread.ts');
const { getBillFile } = await import('../src/storage.ts');
const { emailAsPdf, htmlToText, emailPdfName } = await import('../src/emailPdf.ts');

const users = ensure('cybm');
const me = users.find((u) => u.email === 'astridy2004@gmail.com')!;
me.emailHandle = 'astrid4';
me.organisationId = 'org_one0001';
save(users);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/inbound', inboundRouter);
app.use('/api/email', emailRouter);
const server = app.listen(4661, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const deliver = async (over: Record<string, unknown>) => {
  await fetch('http://127.0.0.1:4661/api/inbound/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inbound-Secret': 'test-inbound-secret' },
    body: JSON.stringify({ to: 'astrid4@cybills.sg', from: 'Martin Lim <martin.lim@dart.com.sg>', ...over }),
  });
  await new Promise((r) => setTimeout(r, 200));
};
const api = async (path: string, org = 'org_one0001') => {
  const res = await fetch(`http://127.0.0.1:4661/api/email${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': org },
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const stored = async (key: string) => {
  const file = await getBillFile(key, 'application/pdf');
  const chunks: Buffer[] = [];
  for await (const c of file!.body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
};

// --- The writer itself ------------------------------------------------------
check('markup is read as lines, rows and entities', htmlToText(
  '<html><head><style>p{color:red}</style></head><body><p>Order &amp; request</p><table><tr><td>Snack Box</td><td>S$&nbsp;12.00</td></tr></table><ul><li>40 pax</li></ul></body></html>'
), 'Order & request\nSnack Box S$ 12.00\n\n- 40 pax');
check('a subject becomes a safe file name', emailPdfName('Fw: 09 OCTOBER 2026 - Order Request: Snack/Box?'), 'Fw 09 OCTOBER 2026 - Order Request Snack Box.pdf');
const long = await emailAsPdf({
  from: 'a@b.sg',
  to: 'c@cybills.sg',
  subject: 'A long thread',
  date: 'today',
  // Text the standard fonts cannot draw must not cost the page, and a word
  // wider than the line must not run off it.
  text: `收据 קבלה ${'x'.repeat(400)}\n\n${'A line of an order. '.repeat(12)}\n`.repeat(40),
});
check('a long mail runs onto further pages rather than off one', (await PDFDocument.load(long)).getPageCount() > 1, true);

// --- A mail whose links lead nowhere ----------------------------------------
await deliver({
  subject: 'Fw: Order Request: Snack Box',
  text: 'Please quote "Dart091026" in your payment.\nPaynow to: 198000198N\nhttps://example.com/logo.png',
  messageId: '<pdf-1@dart.com.sg>',
});
let bill = listBills('cybm')[0]!;
check('it stands in the inbox with no file', [bill.emailLink?.status, bill.storageKey], ['awaiting_trust', '']);

// Somebody has coded it by hand before asking for the paper.
updateBill('cybm', bill.id, { supplier: "KATE'S CATERING PTE LTD", category: '3202 - Cost of Sales - Event Costs' });

let r = await api(`/documents/${bill.id}/pdf`, 'org_two0002');
check('another entity cannot convert it', r.status, 404);

r = await api(`/documents/${bill.id}/pdf`);
check('the email is saved as a PDF', [r.status, r.body.ok, r.body.document?.via], [200, true, 'email']);
bill = listBills('cybm')[0]!;
check('…on the document that was asking, not beside it', [listBills('cybm').length, r.body.document?.billId], [1, bill.id]);
check('…named for the mail', [bill.fileName, bill.contentType], ['Fw Order Request Snack Box.pdf', 'application/pdf']);
const bytes = await stored(bill.storageKey);
check('…and it is a PDF, titled with the subject', [bytes.subarray(0, 5).toString(), (await PDFDocument.load(bytes)).getTitle()], [
  '%PDF-',
  'Fw: Order Request: Snack Box',
]);
check('what was typed by hand is left alone, and nothing is re-read over it', [r.body.reading, bill.supplier, bill.status !== 'processing'], [
  false,
  "KATE'S CATERING PTE LTD",
  true,
]);
check('the document stops asking about its links', bill.emailLink?.status, 'converted');
check('the mirrored mail has its document', [loadMail()[0]?.outcome, loadMail()[0]?.pendingBillId, loadMail()[0]?.documents[0]?.via], [
  'documents',
  '',
  'email',
]);

r = await api(`/documents/${bill.id}/pdf`);
check('a document that has its file is not converted again', [r.status, r.body.error], [409, 'has_file']);

// --- A mail with no links and no attachment at all ---------------------------
await deliver({ subject: 'Receipt for your booking', text: 'Paid SGD 45.00 on 3 Oct 2026. Thank you.', messageId: '<pdf-2@dart.com.sg>' });
check('it filed nothing, so Costs has never heard of it', listBills('cybm').length, 1);
r = await api(`/messages/${encodeURIComponent('<pdf-2@dart.com.sg>')}/pdf`);
check('from the Email tab it becomes a document of its own', [r.status, r.body.ok, r.body.reading, listBills('cybm').length], [200, true, true, 2]);
const made = listBills('cybm').find((b) => b.id === r.body.document?.billId)!;
check('…owned by the person it was sent to, carrying the message', [made.owner, made.email?.subject, Boolean(made.storageKey)], [
  'astridy2004@gmail.com',
  'Receipt for your booking',
  true,
]);
r = await api(`/messages/${encodeURIComponent('<pdf-2@dart.com.sg>')}/pdf`);
check('…once', [r.status, r.body.error], [409, 'already_filed']);

// --- The message as it was sent ----------------------------------------------
// An order confirmation is laid out in its HTML part, so that part is kept —
// past the moment a document lands — and the page may hand back the PDF it
// drew from it.
const get = async (path: string, org = 'org_one0001') => {
  const res = await fetch(`http://127.0.0.1:4661/api/email${path}`, { headers: { 'X-Org-Id': org } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const HTML = '<html><body><h1>Your order request has been received</h1><table><tr><td>Normal Snack Box</td><td>1285.20</td></tr></table></body></html>';
await deliver({ subject: 'Order request', text: 'Normal Snack Box 1285.20', html: HTML, messageId: '<pdf-3@dart.com.sg>' });
const id3 = encodeURIComponent('<pdf-3@dart.com.sg>');
check('the HTML part is kept, in storage rather than on the row', [Boolean(loadMail().find((m) => m.id === '<pdf-3@dart.com.sg>')?.bodyKey), (await get(`/messages/${id3}/body`)).body.html], [true, HTML]);
check('another entity cannot read it', (await get(`/messages/${id3}/body`, 'org_two0002')).status, 404);
const listed = (await get(`/threads/${me.id}`)).body.messages.find((m: any) => m.id === '<pdf-3@dart.com.sg>');
check('a listing says there is a body and does not carry it', [listed.hasBody, 'html' in listed, 'bodyKey' in listed], [true, false, false]);
check('a mail with no HTML part has none', (await get(`/messages/${encodeURIComponent('<pdf-2@dart.com.sg>')}/body`)).body.html, '');

const post = async (path: string, body: unknown) => {
  const res = await fetch(`http://127.0.0.1:4661/api/email${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': 'org_one0001' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
r = await post(`/messages/${id3}/pdf`, { pdf: Buffer.from('<html>a sign-in page</html>').toString('base64') });
check('what the page sends must BE a PDF', [r.status, r.body.error, listBills('cybm').length], [422, 'not_a_pdf', 2]);
const drawn = Buffer.from(await (await PDFDocument.create().then((p) => (p.addPage(), p.setTitle('Drawn by the page'), p))).save());
r = await post(`/messages/${id3}/pdf`, { pdf: drawn.toString('base64') });
const third = listBills('cybm').find((b) => b.id === r.body.document?.billId)!;
check('the PDF the page drew is the one attached', [r.status, (await PDFDocument.load(await stored(third.storageKey))).getTitle()], [200, 'Drawn by the page']);
check('…and the body is still there once the document has landed', (await get(`/documents/${third.id}/body`)).body.html, HTML);

await finish(failures, server);
