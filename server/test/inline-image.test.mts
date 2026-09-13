// A logo or signature image inside an email is not a document, and must not
// stop the mail's LINKS being followed — the smartbee receipt mail embeds an
// 11 KB logo by content id and puts the receipt itself behind a link. Driven
// over real HTTP, like attached-email.test.mts.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-inline-image-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.INBOUND_SECRET = 'test-inbound-secret';
process.env.N8N_FETCH_URL = 'http://127.0.0.1:4698/webhook/fetch';
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'Excellence AS', tenantId: 't-1', tenantName: 'Excellence AS', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

// n8n is never called here (the sender is not trusted), but it has to exist
// for links to be followable at all.
let calls = 0;
const n8n = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    calls += 1;
    res.setHeader('content-type', 'application/json');
    res.end('[]');
  });
});
await new Promise<void>((r) => n8n.listen(4698, '127.0.0.1', r));

const express = (await import('express')).default;
const { inboundRouter } = await import('../src/inbound.ts');
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
const server = app.listen(4697, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const CRLF = '\r\n';
const b64 = (buf: Buffer) => buf.toString('base64').replace(/.{76}/g, `$&${CRLF}`);
const PNG_HEAD = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const LOGO = Buffer.concat([PNG_HEAD, Buffer.alloc(11000, 1)]); // ~11 KB, like the smartbee logo
const PHOTO = Buffer.concat([PNG_HEAD, Buffer.alloc(180000, 2)]); // a real receipt photo is far bigger

const deliver = async (raw: string) => {
  const res = await fetch('http://127.0.0.1:4697/api/inbound/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inbound-Secret': 'test-inbound-secret' },
    body: JSON.stringify({ raw: Buffer.from(raw).toString('base64') }),
  });
  return (await res.json()) as Record<string, unknown>;
};

// --- The smartbee receipt mail: a logo inline by content id, the receipt a link --
const LINK = 'https://smartbee.co.il/public/files/6a8d465d/1.a04ba735';
let out = await deliver([
  'From: Sharon Shimoni <sharon@excellenceas.sg>',
  'To: astrid4@cybills.sg',
  "Subject: Fwd: קבלה מס' 700040",
  'Message-ID: <smartbee-1@excellenceas.sg>',
  'Date: Mon, 14 Sep 2026 00:58:00 +0800',
  'MIME-Version: 1.0',
  'Content-Type: multipart/related; boundary="rel"',
  '',
  '--rel',
  'Content-Type: text/html; charset=utf-8',
  '',
  `<img src="cid:logo123"><p>להורדת הקובץ נא ללחוץ על הקישור: <a href="${LINK}">קישור לצפייה בקובץ</a></p>`,
  '--rel',
  'Content-Type: image/png',
  'Content-ID: <logo123>',
  'Content-Disposition: inline',
  'Content-Transfer-Encoding: base64',
  '',
  b64(LOGO),
  '--rel--',
  '',
].join(CRLF));
await new Promise((r) => setTimeout(r, 200));
let bills = listBills('cybm');
let mail = loadMail().find((m) => m.id === '<smartbee-1@excellenceas.sg>');

check('the logo inside the email is not filed as a document', bills.some((b) => b.storageKey && b.contentType === 'image/png'), false);
check('…it is listed on the mail, with the reason', mail?.attachments.map((a) => a.skipped), ['an image inside the email (a logo or signature), not a document']);
const asking = bills.find((b) => b.emailLink?.status === 'awaiting_trust');
check('so the link is followable: the receipt behind it waits as a "Trust sender?" document', [Boolean(asking), out.awaiting === asking?.displayId], [true, true]);
check('…and nothing was fetched without trust', calls, 0);

// --- A real receipt photo attached to a mail is still filed ----------------------
out = await deliver([
  'From: Sharon Shimoni <sharon@excellenceas.sg>',
  'To: astrid4@cybills.sg',
  'Subject: Taxi receipt',
  'Message-ID: <photo-1@excellenceas.sg>',
  'Date: Mon, 14 Sep 2026 09:00:00 +0800',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="mix"',
  '',
  '--mix',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Receipt attached. Our site: https://excellenceas.sg',
  '--mix',
  'Content-Type: image/png; name="taxi.png"',
  'Content-Disposition: attachment; filename="taxi.png"',
  'Content-Transfer-Encoding: base64',
  '',
  b64(PHOTO),
  '--mix--',
  '',
].join(CRLF));
await new Promise((r) => setTimeout(r, 200));
bills = listBills('cybm');
mail = loadMail().find((m) => m.id === '<photo-1@excellenceas.sg>');
check('a real receipt photo is filed', [out.created, bills.some((b) => b.fileName === 'taxi.png')], [1, true]);
check('…and its mail is not also asked about by link', mail?.outcome, 'documents');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
await finish(failures, server, n8n);
