// Answering a mail from the page it is being read on.
//
// A document that arrived as a link with no invoice behind it ends with
// somebody asking the sender for the invoice, and that used to mean leaving
// CYBills to find the email again. The reply goes out from the deployment's
// mailbox, so everything that matters is in the HEADERS: who it reaches, where
// their answer comes back to, and which message it says it answers.
//
// Driven over real HTTP in, and over a real SMTP conversation out — a stub
// server takes the message nodemailer sends, so what is asserted is the mail
// that actually leaves.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-email-reply-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.INBOUND_SECRET = 'test-inbound-secret';
process.env.N8N_FETCH_URL = 'http://127.0.0.1:4653/never-called';
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '4652';
process.env.SMTP_SECURE = 'false';
process.env.SMTP_USER = 'robot';
process.env.SMTP_PASS = 'secret';
process.env.MAIL_FROM = 'no-reply@cybills.sg';
process.env.MAIL_REPLY_TO = 'practice@cy-bm.sg';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-1', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org_two0002', orgId: 'cybm', name: 'Red Alpha', tenantId: 't-2', tenantName: 'Red Alpha', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

// Just enough SMTP to be sent a message: no TLS offered, any login accepted.
const sent: Array<{ rcpt: string[]; data: string }> = [];
let refuse = false;
const smtp = net.createServer((sock) => {
  let buf = '';
  let inData = false;
  let cur = { rcpt: [] as string[], data: '' };
  sock.write('220 stub ESMTP\r\n');
  sock.on('error', () => {});
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    for (;;) {
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        cur.data = buf.slice(0, end);
        buf = buf.slice(end + 5);
        inData = false;
        sent.push(cur);
        cur = { rcpt: [], data: '' };
        sock.write('250 queued\r\n');
        continue;
      }
      const nl = buf.indexOf('\r\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === 'EHLO') sock.write('250-stub\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (verb === 'AUTH') sock.write('235 ok\r\n');
      else if (verb === 'MAIL') sock.write(refuse ? '550 mailbox unavailable\r\n' : '250 ok\r\n');
      else if (verb === 'RCPT') {
        cur.rcpt.push(/<([^>]+)>/.exec(line)?.[1] || '');
        sock.write('250 ok\r\n');
      } else if (verb === 'DATA') {
        inData = true;
        sock.write('354 go on\r\n');
      } else if (verb === 'QUIT') {
        sock.write('221 bye\r\n');
        sock.end();
      } else sock.write('250 ok\r\n');
    }
  });
});
await new Promise<void>((r) => smtp.listen(4652, '127.0.0.1', r));

const express = (await import('express')).default;
const { inboundRouter } = await import('../src/inbound.ts');
const { emailRouter } = await import('../src/email.ts');
const { ensure, save } = await import('../src/users.ts');
const { listBills } = await import('../src/store.ts');

const users = ensure('cybm');
const me = users.find((u) => u.email === 'astridy2004@gmail.com')!;
me.emailHandle = 'astrid4';
me.organisationId = 'org_one0001';
save(users);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/inbound', inboundRouter);
app.use('/api/email', emailRouter);
const server = app.listen(4651, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const api = async (path: string, body?: unknown, org = 'org_one0001') => {
  const res = await fetch(`http://127.0.0.1:4651/api/email${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': org },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

// A header off the wire, unfolded: a long one is wrapped onto a second line.
const header = (data: string, name: string) => {
  const head = data.split('\r\n\r\n')[0].replace(/\r\n[ \t]+/g, ' ');
  return new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(head)?.[1]?.trim() ?? '';
};

// --- The mail being answered: an invoice that never came --------------------
await fetch('http://127.0.0.1:4651/api/inbound/email', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Inbound-Secret': 'test-inbound-secret' },
  body: JSON.stringify({
    to: 'astrid4@cybills.sg',
    from: 'Martin Lim <martin.lim@dart.com.sg>',
    subject: 'Fw: Order Request: Snack Box',
    text: 'Please quote "Dart091026" in your payment.\nhttps://example.com/logo.png',
    messageId: '<SN6PR01.abc123@dart.com.sg>',
  }),
});
await new Promise((r) => setTimeout(r, 200));
const bill = listBills('cybm')[0]!;
check('the mail stands in the inbox as a document that asks', bill?.emailLink?.status, 'awaiting_trust');

// --- What the document page is told ------------------------------------------
let r = await api(`/documents/${bill.id}/replies`);
check('the page learns it can be answered, and who the answer goes to', [r.status, r.body.replyEnabled, r.body.replyAddress, r.body.replies], [
  200,
  true,
  'martin.lim@dart.com.sg',
  [],
]);

// --- Sending ----------------------------------------------------------------
r = await api('/reply', { billId: bill.id, body: 'Hi Martin,\nThis only carried logos. Could you send the invoice itself?' });
check('the reply is sent', [r.status, r.body.ok], [200, true]);
check('…to whoever sent the original, by address', sent[0]?.rcpt, ['martin.lim@dart.com.sg']);
check('…with the subject of the mail it answers', header(sent[0]?.data || '', 'Subject'), 'Re: Fw: Order Request: Snack Box');
check('…their answer comes back to the address the original was delivered to, not the deploy default', header(sent[0]?.data || '', 'Reply-To'), 'astrid4@cybills.sg');
check('…and it names the message it answers, so their mail client threads it', [
  header(sent[0]?.data || '', 'In-Reply-To'),
  header(sent[0]?.data || '', 'References'),
], ['<SN6PR01.abc123@dart.com.sg>', '<SN6PR01.abc123@dart.com.sg>']);
const html = Buffer.from(sent[0]?.data.split('\r\n\r\n').slice(1).join('\r\n\r\n') || '', 'utf8').toString();
const plain = html.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
check('what was typed is in it, line breaks kept', plain.includes('Hi Martin,<br>This only carried logos.'), true);
check('…with the original quoted beneath', plain.includes('Please quote &quot;Dart091026&quot; in your payment.'), true);

// --- It is recorded, where both pages read it -------------------------------
r = await api(`/documents/${bill.id}/replies`);
check('the document shows what was sent', [r.body.replies.length, r.body.replies[0]?.to, r.body.replies[0]?.text.split('\n')[0]], [
  1,
  ['martin.lim@dart.com.sg'],
  'Hi Martin,',
]);
r = await api(`/threads/${me.id}`);
check('…and so does the thread', [r.body.replyEnabled, r.body.messages[0]?.replies.length, r.body.messages[0]?.replyAddress], [
  true,
  1,
  'martin.lim@dart.com.sg',
]);

// --- Other recipients -------------------------------------------------------
r = await api('/reply', {
  messageId: '<SN6PR01.abc123@dart.com.sg>',
  to: 'Ivor Chua <ivor@dart.com.sg>',
  cc: 'martin.lim@dart.com.sg; finance@dart.com.sg',
  body: 'Copying Ivor.',
});
check('a reply can be addressed by message, to somebody else, with copies', [r.status, sent[1]?.rcpt], [
  200,
  ['ivor@dart.com.sg', 'martin.lim@dart.com.sg', 'finance@dart.com.sg'],
]);

// --- Refusals ---------------------------------------------------------------
r = await api('/reply', { billId: bill.id, body: '   ' });
check('an empty reply is not sent', [r.status, r.body.error], [422, 'empty_reply']);
r = await api('/reply', { billId: bill.id, to: 'martin at dart', body: 'x' });
check('a recipient that is not an address is refused, not dropped', [r.status, r.body.error], [422, 'bad_address']);
r = await api('/reply', { billId: bill.id, to: 'org_one0001.general@cybills.local', body: 'x' });
check('an internal identity is not a mailbox', [r.status, r.body.error], [422, 'bad_address']);
r = await api('/reply', { billId: bill.id, body: 'x' }, 'org_two0002');
check("another entity cannot answer this entity's mail", [r.status, r.body.error], [404, 'unknown_message']);
r = await api(`/documents/${bill.id}/replies`, undefined, 'org_two0002');
check('…or learn it exists', r.status, 404);
check('none of those reached the mail server', sent.length, 2);

// --- A send the mailbox refuses is not recorded as sent ---------------------
refuse = true;
r = await api('/reply', { billId: bill.id, body: 'Did this go?' });
check('a refused send says so', [r.status, r.body.error], [502, 'send_failed']);
r = await api(`/documents/${bill.id}/replies`);
check('…and leaves no reply on the record', r.body.replies.length, 2);

await finish(failures, server, smtp);
