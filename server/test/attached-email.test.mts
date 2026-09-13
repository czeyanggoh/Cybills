// An email forwarded AS AN ATTACHMENT — Gmail's "Forward as attachment", one
// mail carrying sixteen `.eml` invoices — is opened, and each attached email is
// delivered as the mail it is: its own row in the Email tab, its own documents,
// its own links.
//
// And the links of an attached email are trusted by who DELIVERED it, never by
// the From line inside the file: that line is text anybody can write, and a
// forged "invoice" from a trusted supplier must not point n8n at a URL.
//
// Driven over real HTTP at both ends, like trusted-sender.test.mts.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-attached-email-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.INBOUND_SECRET = 'test-inbound-secret';
process.env.N8N_FETCH_URL = 'http://127.0.0.1:4662/webhook/xero-pdf';
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

const PDF = Buffer.from('%PDF-1.4 the invoice behind the link');
const ATTACHED_PDF = Buffer.from('%PDF-1.4 the Canva invoice attached to the original email');
let calls = 0;
const asked: string[] = [];
const n8n = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    calls += 1;
    asked.push(String(JSON.parse(raw).from || ''));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ fileName: `INV-${calls}.pdf`, mimeType: 'application/pdf', data: PDF.toString('base64') }]));
  });
});
await new Promise<void>((r) => n8n.listen(4662, '127.0.0.1', r));

const express = (await import('express')).default;
const { inboundRouter } = await import('../src/inbound.ts');
const { emailRouter } = await import('../src/email.ts');
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
const server = app.listen(4661, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- MIME, written out by hand so what is parsed is what a mail client sends --
const CRLF = '\r\n';
const b64 = (buf: Buffer) => buf.toString('base64').replace(/.{76}/g, `$&${CRLF}`);

const linkEmail = (id: string, from: string, subject: string, link: string) =>
  [
    `From: ${from}`,
    'To: finance@excellenceas.sg',
    `Subject: ${subject}`,
    `Message-ID: <${id}>`,
    'Date: Mon, 07 Sep 2026 09:00:00 +0800',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `View your bill online: ${link}`,
    '',
  ].join(CRLF);

const pdfEmail = (id: string, from: string, subject: string) =>
  [
    `From: ${from}`,
    'To: finance@excellenceas.sg',
    `Subject: ${subject}`,
    `Message-ID: <${id}>`,
    'Date: Tue, 08 Sep 2026 09:00:00 +0800',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="inner-b"',
    '',
    '--inner-b',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Thanks for your payment. Your invoice is attached.',
    '--inner-b',
    'Content-Type: application/pdf; name="canva-invoice.pdf"',
    'Content-Disposition: attachment; filename="canva-invoice.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(ATTACHED_PDF),
    '--inner-b--',
    '',
  ].join(CRLF);

// The forward itself: a note from the forwarder, and each email as an .eml.
const forward = (id: string, from: string, attached: Array<{ name: string; eml: string }>, note = '') => {
  // Its own boundary per message, or a forward nested inside a forward would
  // close its parent's parts early.
  const boundary = `outer-${id.replace(/[^a-z0-9]/gi, '')}`;
  return Buffer.from(
    [
      `From: finance Excellence A.S <${from}>`,
      'To: astrid4@cybills.sg',
      'Subject: ',
      `Message-ID: <${id}>`,
      'Date: Sun, 13 Sep 2026 21:10:00 +0800',
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      note,
      ...attached.flatMap((a) => [
        `--${boundary}`,
        `Content-Type: message/rfc822; name="${a.name}"`,
        `Content-Disposition: attachment; filename="${a.name}"`,
        '',
        a.eml,
      ]),
      `--${boundary}--`,
      '',
    ].join(CRLF)
  ).toString('base64');
};

const deliver = async (body: Record<string, unknown>) => {
  const res = await fetch('http://127.0.0.1:4661/api/inbound/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inbound-Secret': 'test-inbound-secret' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
};

const api = async (path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:4661/api/email${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': 'org_one0001' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const settle = async (want: () => boolean) => {
  for (let i = 0; i < 60 && !want(); i++) await new Promise((r) => setTimeout(r, 50));
};

const XERO = 'subscription.notifications@post.xero.com';
const FORWARDER = 'finance@excellenceas.sg';

// --- A forward carrying two attached emails ---------------------------------
let out = await deliver({
  raw: forward('outer-1@excellenceas.sg', FORWARDER, [
    { name: 'Invoice for subscription - Canva.eml', eml: pdfEmail('canva-1@canva.com', 'Canva <billing@canva.com>', 'Invoice for subscription - Canva') },
    { name: 'Invoice for subscription - Xero.pdf.eml', eml: linkEmail('xero-1@post.xero.com', `Xero <${XERO}>`, 'Invoice for subscription - Xero', 'https://in.xero.com/aug111') },
  ]),
});
await new Promise((r) => setTimeout(r, 200));
let bills = listBills('cybm');
let mail = loadMail();
const outer = mail.find((m) => m.id === '<outer-1@excellenceas.sg>');
const canva = mail.find((m) => m.id === '<canva-1@canva.com>');
const xero = mail.find((m) => m.id === '<xero-1@post.xero.com>');

check('both attached emails were opened', out.forwarded, 2);
check('the PDF inside one of them was filed', out.created, 1);
check('each attached email is its own row in the Email tab', [Boolean(outer), Boolean(canva), Boolean(xero)], [true, true, true]);
check('…threaded where the forward was DELIVERED', [canva?.to, xero?.to, canva?.userId], ['astrid4@cybills.sg', 'astrid4@cybills.sg', me.id]);
check('…saying who it was originally from', [canva?.from, xero?.from], ['billing@canva.com', XERO]);
check('…and who delivered it', [canva?.forwardedBy, xero?.forwardedBy, xero?.forwardedIn], [FORWARDER, FORWARDER, '<outer-1@excellenceas.sg>']);
check('the forward says what it carried, not "nothing filed"', [outer?.outcome, outer?.forwarded?.length], ['forwarded', 2]);
check('…and no attachment of it is reported skipped', outer?.attachments.filter((a) => a.skipped).length, 0);

const filed = bills.find((b) => b.storageKey);
check('the attached PDF is a cost document', [filed?.fileName, filed?.contentType], ['canva-invoice.pdf', 'application/pdf']);
check('…read with its own email as the covering note', [filed?.email?.from, filed?.email?.subject], ['billing@canva.com', 'Invoice for subscription - Canva']);
check('an .eml named ".pdf.eml" is opened, never filed as a PDF', bills.some((b) => b.fileName.endsWith('.pdf.eml')), false);

const asking = bills.find((b) => b.emailLink?.status === 'awaiting_trust');
check('the link email ASKS, because the forwarder is not trusted', [Boolean(asking), calls], [true, 0]);
check('…and asks about the FORWARDER, not the From line in the file', asking?.emailLink?.from, FORWARDER);
check('…while its covering note still names the original sender', asking?.email?.from, XERO);
check('the reply names it', out.awaiting, asking?.displayId);

// A retried delivery must not stand a second question beside the first.
await deliver({
  raw: forward('outer-1@excellenceas.sg', FORWARDER, [
    { name: 'Invoice for subscription - Xero.pdf.eml', eml: linkEmail('xero-1@post.xero.com', `Xero <${XERO}>`, 'Invoice for subscription - Xero', 'https://in.xero.com/aug111') },
  ]),
});
await new Promise((r) => setTimeout(r, 200));
check('a retried forward asks once, not twice', listBills('cybm').filter((b) => b.emailLink?.status === 'awaiting_trust').length, 1);

// --- Trusting the ORIGINAL sender does not follow a forwarded link ----------
let r = await api('/senders/trust', { address: XERO });
check('trusting the address inside the file fetches nothing', [r.body.waiting, calls], [0, 0]);

// --- Trusting the FORWARDER fetches what was waiting ------------------------
r = await api('/senders/trust', { address: FORWARDER });
check('trusting the forwarder fetches the attached email waiting on them', [r.body.waiting, r.body.fetched, calls], [1, 1, 1]);
check('…asking n8n with the ORIGINAL sender, whose portal it is', asked[0], XERO);
bills = listBills('cybm');
check('…onto the row that asked', bills.find((b) => b.id === asking?.id)?.emailLink?.status, 'fetched');

r = await api(`/threads/${me.id}`);
const rows = r.body.messages as Array<{ id: string; senderTrusted: boolean; summary: string }>;
check('the Email tab calls the attached email trusted by its forwarder', rows.find((m) => m.id === '<xero-1@post.xero.com>')?.senderTrusted, true);
check('…and the forward itself says what it carried', rows.find((m) => m.id === '<outer-1@excellenceas.sg>')?.summary, '2 attached emails, each listed on its own');

// --- A trusted forwarder's next attached link is fetched on arrival ---------
out = await deliver({
  raw: forward('outer-2@excellenceas.sg', FORWARDER, [
    { name: 'September.eml', eml: linkEmail('xero-2@post.xero.com', `Xero <${XERO}>`, 'Invoice for subscription - September', 'https://in.xero.com/sep222') },
  ]),
});
await settle(() => calls > 1);
check('a trusted forwarder is not asked about again', [out.awaiting, calls], ['', 2]);

// --- A stranger forging a trusted supplier is still asked about -------------
// XERO is trusted here now. The From line of an attached email is text in a
// file, so a stranger attaching an email "from" Xero must not have it followed.
out = await deliver({
  raw: forward('outer-3@evil.example', 'stranger@evil.example', [
    { name: 'Xero.eml', eml: linkEmail('forged-1@post.xero.com', `Xero <${XERO}>`, 'Invoice for subscription', 'https://in-xero.evil.example/login') },
  ]),
});
await new Promise((r2) => setTimeout(r2, 200));
check('a forged attached email from a trusted supplier ASKS', Boolean(out.awaiting), true);
check('…and nothing was fetched for it', calls, 2);
check('…the question is about the stranger who sent it', listBills('cybm').find((b) => b.displayId === out.awaiting)?.emailLink?.from, 'stranger@evil.example');

// --- The pre-parsed Worker road opens attached emails too -------------------
out = await deliver({
  to: 'astrid4@cybills.sg',
  from: FORWARDER,
  subject: 'Fwd: receipts',
  text: '',
  attachments: [
    {
      filename: 'receipt.eml',
      contentType: 'message/rfc822',
      contentBase64: Buffer.from(pdfEmail('canva-2@canva.com', 'Canva <billing@canva.com>', 'Receipt - October')).toString('base64'),
    },
  ],
});
check('a Worker posting parsed attachments has its .eml opened', [out.forwarded, out.created], [1, 1]);

// --- Nested too deeply is reported, not silently dropped --------------------
const level3 = linkEmail('deep-3@x.example', 'a@x.example', 'three deep', 'https://x.example/3');
const wrap = (id: string, name: string, eml: string) =>
  Buffer.from(forward(id, FORWARDER, [{ name, eml }]), 'base64').toString('utf8');
out = await deliver({
  raw: forward('deep-0@excellenceas.sg', FORWARDER, [
    { name: 'one.eml', eml: wrap('deep-1@excellenceas.sg', 'two.eml', wrap('deep-2@excellenceas.sg', 'three.eml', level3)) },
  ]),
});
mail = loadMail();
check('two levels are opened', [Boolean(mail.find((m) => m.id === '<deep-1@excellenceas.sg>')), Boolean(mail.find((m) => m.id === '<deep-2@excellenceas.sg>'))], [true, true]);
check('…a third is reported on the row that carried it', mail.find((m) => m.id === '<deep-2@excellenceas.sg>')?.attachments[0]?.skipped, 'an attached email nested too deeply to open');

await finish(failures, server, n8n);
