// A bill that arrives as a LINK, and the Email tab that says what became of it.
//
// The mail this exists for carries no attachment at all — Xero's own
// subscription invoice, "View your bill online: INV-7822201", with the PDF
// behind a login. That delivery used to file nothing and leave no trace: no
// document, no row, no reason. Now the links go to n8n, which holds the portal
// credentials, and what comes back is filed and read exactly as an attachment
// would be.
//
// Driven over real HTTP, both ends: the inbound endpoint as the Cloudflare
// Worker calls it, and a stub standing in for n8n — so what is asserted is the
// request that actually goes out and the bytes that actually come back.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-email-link-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.INBOUND_SECRET = 'test-inbound-secret';
process.env.N8N_FETCH_URL = 'http://127.0.0.1:4632/webhook/xero-pdf';
process.env.N8N_API_KEY = 'test-n8n-key';
// No reader key: the background read returns at its first line, which keeps
// this test about the delivery rather than about extraction.
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-1', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

// --- The n8n stub ------------------------------------------------------------
const PDF = Buffer.from('%PDF-1.4 the invoice behind the link');
type Answer = { status: number; contentType: string; body: string | Buffer };
let answer: Answer = {
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify([{ fileName: 'INV-7822201.pdf', mimeType: 'application/pdf', data: PDF.toString('base64') }]),
};
const calls: Array<{ key: string; body: Record<string, unknown> }> = [];
const n8n = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    calls.push({ key: String(req.headers['x-api-key'] || ''), body: JSON.parse(raw || '{}') });
    res.statusCode = answer.status;
    res.setHeader('content-type', answer.contentType);
    res.end(answer.body);
  });
});
await new Promise<void>((r) => n8n.listen(4632, '127.0.0.1', r));

const express = (await import('express')).default;
const { inboundRouter } = await import('../src/inbound.ts');
const { emailRouter } = await import('../src/email.ts');
const { linksIn } = await import('../src/n8n.ts');
const { ensure, save } = await import('../src/users.ts');
const { listBills } = await import('../src/store.ts');
const { loadMail } = await import('../src/mailThread.ts');

const users = ensure('cybm');
const me = users.find((u) => u.email === 'astridy2004@gmail.com')!;
me.emailHandle = 'astrid4';
me.organisationId = 'org_one0001';
save(users);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/inbound', inboundRouter);
app.use('/api/email', emailRouter);
const server = app.listen(4631, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const post = async (body: unknown) => {
  const res = await fetch('http://127.0.0.1:4631/api/inbound/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inbound-Secret': 'test-inbound-secret' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
};

// The link fetch runs AFTER the delivery is answered — the Worker must not wait
// on a portal login — so the test waits for it the way anything else would.
const settle = async (want: () => boolean) => {
  for (let i = 0; i < 100 && !want(); i++) await new Promise((r) => setTimeout(r, 50));
};

const xeroMail = {
  to: 'astrid4@cybills.sg',
  from: 'czeyang.goh@cy-bm.sg',
  subject: 'FW: Your Xero Invoice for Tiffinlabs US LLC',
  text: 'Here is the Xero bill.\nView it at https://in.xero.com/abc123DEF.',
  html:
    '<p>View your bill online: <a href="https://in.xero.com/abc123DEF">INV-7822201</a></p>' +
    '<p><a href="https://central.xero.com/s/article/billing">see the support article</a></p>',
};

// --- The links a message carries --------------------------------------------
check(
  'the anchor, the bare URL and nothing twice',
  linksIn(xeroMail.text, xeroMail.html),
  ['https://in.xero.com/abc123DEF', 'https://central.xero.com/s/article/billing']
);
check(
  'a full stop at the end of a sentence is not part of the link',
  linksIn('pay this: https://in.xero.com/abc123DEF.', ''),
  ['https://in.xero.com/abc123DEF']
);

// --- A mail with no attachment, and a link ----------------------------------
let r = await post(xeroMail);
check('the delivery is answered straight away', [r.status, r.body.kind], [200, 'documents']);
check('…having filed nothing of its own', r.body.created, 0);

await settle(() => listBills('cybm').length > 0);
let bills = listBills('cybm');
check('n8n was asked once', calls.length, 1);
check('…with the key it is configured with', calls[0]?.key, 'test-n8n-key');
check('…and every link, the first one named', [calls[0]?.body.url, (calls[0]?.body.links as string[])?.length], ['https://in.xero.com/abc123DEF', 2]);
check('the document behind the link was filed', bills.length, 1);
check('…under the name n8n gave it', bills[0]?.fileName, 'INV-7822201.pdf');
check('…owned by the person it was emailed to', [bills[0]?.owner, bills[0]?.createdBy], ['astridy2004@gmail.com', 'astridy2004@gmail.com']);
check('…carrying the covering message, so a re-read sees it too', bills[0]?.email?.subject, xeroMail.subject);
check('…as a PDF, whatever the mail said', bills[0]?.contentType, 'application/pdf');

let mail = loadMail();
check('the delivery is mirrored, once', mail.length, 1);
check('…saying what n8n answered', mail[0]?.linkNote, 'n8n returned 1 document');
check('…and pointing at the document it produced', [mail[0]?.documents.length, mail[0]?.documents[0]?.via], [1, 'link']);
check('…which is what the delivery came to', mail[0]?.outcome, 'documents');

// --- The same delivery, sent again -------------------------------------------
// The Worker's own fetch timing out after we had already filed everything is
// the ordinary case. It must leave one row, one document, and must not pay for
// the same invoice to be fetched twice.
r = await post(xeroMail);
await new Promise((res) => setTimeout(res, 300));
check('a retried delivery asks n8n nothing', calls.length, 1);
check('…files no second copy', listBills('cybm').length, 1);
check('…and leaves one row, still pointing at its document', [loadMail().length, loadMail()[0]?.documents.length], [1, 1]);

// --- A link that needs a login n8n could not complete ------------------------
// The failure that matters: a portal answers 200 with a sign-in PAGE, and a
// workflow that hands it back verbatim would otherwise have it filed as a cost
// document and read as an invoice.
answer = { status: 200, contentType: 'text/html', body: '<html><body>Sign in to Xero</body></html>' };
r = await post({ ...xeroMail, subject: 'FW: Your Xero Invoice — second copy', text: 'https://in.xero.com/zzz999' });
await settle(() => calls.length > 1);
await settle(() => loadMail().length > 1);
bills = listBills('cybm');
mail = loadMail().filter((m) => m.subject.includes('second copy'));
check('a login page is not a document', bills.length, 1);
check('…and the reason is on the message, in words', mail[0]?.linkNote.startsWith('n8n returned text/html rather than a document'), true);
check('…which is not counted as having filed anything', [mail[0]?.outcome, mail[0]?.documents.length], ['nothing', 0]);

// --- An attachment wins, and the link is never followed ----------------------
// A mail carrying both the invoice and a link to the same invoice must not file
// the cost twice.
const before = calls.length;
r = await post({
  ...xeroMail,
  subject: 'FW: invoice attached',
  attachments: [{ filename: 'inv.pdf', contentType: 'application/pdf', contentBase64: PDF.toString('base64') }],
});
check('the attachment is the document', r.body.created, 1);
await new Promise((res) => setTimeout(res, 300));
check('…so n8n is not asked what is behind the link', calls.length, before);

// --- Pressing "Fetch the document" again -------------------------------------
// The retry a person presses: the workflow was down, the login had expired,
// somebody has since taught n8n how to follow that link.
answer = {
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ fileName: 'INV-7822202.pdf', contentBase64: Buffer.from('%PDF-1.4 the retried invoice').toString('base64') }),
};
const stale = loadMail().find((m) => m.subject.includes('second copy'))!;
const retry = await fetch(`http://127.0.0.1:4631/api/email/messages/${encodeURIComponent(stale.id)}/fetch`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Org-Id': 'org_one0001' },
});
const retried = (await retry.json()) as { ok: boolean; documents: Array<{ fileName: string }> };
check('the retry answers when it is done, not before', [retry.status, retried.ok], [200, true]);
check('…having filed what came back this time', retried.documents?.[0]?.fileName, 'INV-7822202.pdf');
check('…onto the message it was pressed on', loadMail().find((m) => m.subject.includes('second copy'))?.documents.length, 1);

// --- The threads listing -----------------------------------------------------
const threadsRes = await fetch('http://127.0.0.1:4631/api/email/threads', { headers: { 'X-Org-Id': 'org_one0001' } });
const threads = (await threadsRes.json()) as { threads: Array<Record<string, unknown>>; unfiled: number };
check('one mailbox, the person the mail was addressed to', threads.threads.length, 1);
check('…named, and at their own address', [threads.threads[0]?.personName, threads.threads[0]?.address], ['Astrid Yang', 'astrid4@cybills.sg']);
check('…counting every message that arrived', threads.threads[0]?.messages, 3);
check('…and the ones that filed nothing', threads.unfiled, 0);

// A message the entity does not hold is not confirmed to exist.
const other = await fetch(`http://127.0.0.1:4631/api/email/messages/nope/fetch`, {
  method: 'POST',
  headers: { 'X-Org-Id': 'org_one0001' },
});
check('an unknown message is a 404, never a 403', other.status, 404);

await finish(failures, server, n8n);
