// The Files tab: choose which of a mail's files stand as the document's proof.
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

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-doc-files-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.INBOUND_SECRET = 'test-inbound-secret';
process.env.N8N_FETCH_URL = 'http://127.0.0.1:4673/never-called';
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
const { listBills, markBillPosted } = await import('../src/store.ts');
const { loadMail } = await import('../src/mailThread.ts');
const { getBillFile } = await import('../src/storage.ts');
const { emailAsPdf, htmlToText, emailPdfName, looksLikeInvoiceMail } = await import('../src/emailPdf.ts');

const users = ensure('cybm');
const me = users.find((u) => u.email === 'astridy2004@gmail.com')!;
me.emailHandle = 'astrid4';
me.organisationId = 'org_one0001';
save(users);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/inbound', inboundRouter);
app.use('/api/email', emailRouter);
const server = app.listen(4671, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const deliver = async (over: Record<string, unknown>) => {
  await fetch('http://127.0.0.1:4671/api/inbound/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inbound-Secret': 'test-inbound-secret' },
    body: JSON.stringify({ to: 'astrid4@cybills.sg', from: 'Martin Lim <martin.lim@dart.com.sg>', ...over }),
  });
  await new Promise((r) => setTimeout(r, 200));
};
const stored = async (key: string) => {
  const file = await getBillFile(key, 'application/pdf');
  const chunks: Buffer[] = [];
  for await (const c of file!.body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
};

const getJson = async (path: string, org = 'org_one0001') => {
  const res = await fetch(`http://127.0.0.1:4671/api/email${path}`, { headers: { 'X-Org-Id': org } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const put = async (path: string, body: unknown, org = 'org_one0001') => {
  const res = await fetch(`http://127.0.0.1:4671/api/email${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': org },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const pdfOf = async (pages: number, title: string) => {
  const p = await PDFDocument.create();
  for (let i = 0; i < pages; i++) p.addPage();
  p.setTitle(title);
  return Buffer.from(await p.save()).toString('base64');
};

// A booking: the terms and conditions (2 pages) and the e-ticket (1 page), both attachments.
await deliver({
  subject: 'Your booking confirmation FAZ37Y',
  text: 'Booking confirmed',
  messageId: '<files-1@dart.com.sg>',
  attachments: [
    { filename: 'Terms and Conditions.pdf', contentType: 'application/pdf', contentBase64: await pdfOf(2, 'terms') },
    { filename: 'E-ticket.pdf', contentType: 'application/pdf', contentBase64: await pdfOf(1, 'ticket') },
  ],
});
const bills = listBills('cybm');
const terms = bills.find((b) => b.fileName === 'Terms and Conditions.pdf')!;
const ticket = bills.find((b) => b.fileName === 'E-ticket.pdf')!;
check('both attachments were filed', [Boolean(terms), Boolean(ticket)], [true, true]);

let r = await getJson(`/documents/${terms.id}/files`);
check('the list offers the attached file, the email and the other attachment', r.body.files?.map((f: any) => f.key), ['current', 'email', `bill:${ticket.id}`]);
check('another entity cannot list them', (await getJson(`/documents/${terms.id}/files`, 'org_two0002')).status, 404);

r = await put(`/documents/${terms.id}/files`, { keys: ['current'] });
check('choosing only what is attached changes nothing', [r.status, r.body.error], [409, 'no_change']);
r = await put(`/documents/${terms.id}/files`, { keys: [] });
check('nothing chosen is refused', [r.status, r.body.error], [422, 'nothing_selected']);
r = await put(`/documents/${terms.id}/files`, { keys: ['bill:not-this-mail'] });
check("a file that is not this mail's is refused", [r.status, r.body.error], [422, 'unknown_file']);

const oldKey = terms.storageKey;
r = await put(`/documents/${terms.id}/files`, { keys: ['email', `bill:${ticket.id}`] });
check('the email and the ticket are combined', [r.status, r.body.ok, r.body.files], [200, true, 2]);
const after = listBills('cybm').find((b) => b.id === terms.id)!;
const merged = await PDFDocument.load(await stored(after.storageKey));
check('…into one PDF of the email page(s) then the ticket', merged.getPageCount() >= 2, true);
check('…named for the item, the wrong file gone', [after.fileName, after.storageKey !== oldKey], [`Item ${terms.displayId || terms.id} combined.pdf`, true]);
check('…and the other document keeps its own file', listBills('cybm').find((b) => b.id === ticket.id)?.storageKey, ticket.storageKey);

markBillPosted('cybm', ticket.id, { xeroInvoiceId: 'x-1', xeroTenantId: 't-1', xeroTenantName: 'CYBM' });
r = await put(`/documents/${ticket.id}/files`, { keys: ['email'] });
check('a document already in Xero keeps its file', [r.status, r.body.error], [409, 'in_xero']);

await finish(failures, server);
