// Whose links CYBills will follow, and how it asks.
//
// `<handle>@cybills.sg` is a public catch-all, so a mail carrying a link is a
// stranger's URL until somebody here says otherwise — and following one means
// pointing a workflow that HOLDS PORTAL CREDENTIALS at it. So the first mail
// from an address lands in the Costs inbox as a document that asks, and
// trusting the sender fetches it and everything of theirs that follows.
//
// Driven over real HTTP at both ends, like email-link.test.mts: the inbound
// endpoint as the Cloudflare Worker calls it, and a stub standing in for n8n.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-trusted-sender-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.INBOUND_SECRET = 'test-inbound-secret';
process.env.N8N_FETCH_URL = 'http://127.0.0.1:4642/webhook/xero-pdf';
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
let calls = 0;
const n8n = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    calls += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ fileName: `INV-${calls}.pdf`, mimeType: 'application/pdf', data: PDF.toString('base64') }]));
  });
});
await new Promise<void>((r) => n8n.listen(4642, '127.0.0.1', r));

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
const server = app.listen(4641, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const deliver = async (over: Record<string, unknown>) => {
  const res = await fetch('http://127.0.0.1:4641/api/inbound/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inbound-Secret': 'test-inbound-secret' },
    body: JSON.stringify({
      to: 'astrid4@cybills.sg',
      from: 'subscription.notifications@post.xero.com',
      subject: 'Your Xero Invoice for Tiffinlabs US LLC',
      text: 'View your bill online: https://in.xero.com/abc123DEF',
      ...over,
    }),
  });
  return (await res.json()) as Record<string, string>;
};

const api = async (path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:4641/api/email${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': 'org_one0001' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const settle = async (want: () => boolean) => {
  for (let i = 0; i < 60 && !want(); i++) await new Promise((r) => setTimeout(r, 50));
};

// --- An unknown sender is ASKED about, in the inbox -------------------------
let out = await deliver({});
await new Promise((r) => setTimeout(r, 200));
let bills = listBills('cybm');
check('the delivery names the document that is asking', Boolean(out.awaiting), true);
check('n8n is not called for a sender nobody has trusted', calls, 0);
check('…but the mail IS a cost in the inbox', [bills.length, bills[0]?.status], [1, 'new']);
check('…named for what the sender called it', bills[0]?.fileName, 'Your Xero Invoice for Tiffinlabs US LLC');
check('…owned by the person it was emailed to', bills[0]?.owner, 'astridy2004@gmail.com');
check('…carrying no file, because fetching one is the decision', [bills[0]?.storageKey, bills[0]?.contentType], ['', '']);
check('…and the question itself, with the links to answer it from', [
  bills[0]?.emailLink?.status,
  bills[0]?.emailLink?.from,
  bills[0]?.emailLink?.links.length,
], ['awaiting_trust', 'subscription.notifications@post.xero.com', 1]);
check('the mirrored mail says what it is waiting for', [loadMail()[0]?.outcome, loadMail()[0]?.pendingBillId], [
  'awaiting_trust',
  bills[0]?.id,
]);

// A second delivery of the SAME mail must not stand a second question beside it.
await deliver({});
await new Promise((r) => setTimeout(r, 200));
check('a retried delivery asks once, not twice', listBills('cybm').length, 1);

// --- Trusting the sender fetches what was waiting ---------------------------
const pendingId = bills[0]!.id;
let r = await api('/senders/trust', { address: 'subscription.notifications@post.xero.com' });
check('the answer is taken', [r.status, r.body.ok], [200, true]);
check('…and acted on for what was already waiting', [r.body.waiting, r.body.fetched], [1, 1]);
check('n8n was asked once', calls, 1);

bills = listBills('cybm');
check('the document that asked is the document that arrived', [bills.length, bills[0]?.id], [1, pendingId]);
check('…now carrying the file', [Boolean(bills[0]?.storageKey), bills[0]?.contentType], [true, 'application/pdf']);
check('…under the name n8n gave it', bills[0]?.fileName, 'INV-1.pdf');
check('…and saying where it came from', bills[0]?.emailLink?.status, 'fetched');
check('the mirrored mail stops waiting', [loadMail()[0]?.outcome, loadMail()[0]?.pendingBillId], ['documents', '']);

// --- The next mail from them is fetched on arrival --------------------------
out = await deliver({ subject: 'Your Xero Invoice — September', text: 'https://in.xero.com/sept999' });
await settle(() => calls > 1);
await settle(() => listBills('cybm').length > 1);
bills = listBills('cybm');
check('a trusted sender is never asked about again', out.awaiting, '');
check('…their next invoice is fetched on arrival', [calls, bills.length], [2, 2]);
const arrived = bills.find((b) => b.email?.subject.includes('September'));
check('…as a document with its file, not a question', [Boolean(arrived?.storageKey), arrived?.emailLink?.status], [true, 'fetched']);

// --- Trust is about ONE address ---------------------------------------------
out = await deliver({ from: 'billing@some-other-portal.com', subject: 'Invoice 44', text: 'https://pay.example.com/44' });
await new Promise((r) => setTimeout(r, 200));
check('somebody else is still asked about', Boolean(out.awaiting), true);
check('…and nothing was fetched for them', calls, 2);

// --- Fetching one without trusting anybody ----------------------------------
const asking = listBills('cybm').find((b) => b.emailLink?.status === 'awaiting_trust')!;
r = await api(`/documents/${encodeURIComponent(asking.id)}/fetch`, {});
check('the one-off fetch answers when it is done', [r.status, r.body.ok], [200, true]);
check('…and fills the row that asked', listBills('cybm').filter((b) => b.emailLink?.status === 'awaiting_trust').length, 0);
r = await api('/senders');
check('…without trusting anybody new', (r.body.senders as unknown[]).length, 1);

// --- Untrusting puts the question back --------------------------------------
r = await api('/senders/untrust', { address: 'subscription.notifications@post.xero.com' });
check('the trust is taken away', r.body.removed, true);
const before = listBills('cybm').length;
out = await deliver({ subject: 'Your Xero Invoice — October', text: 'https://in.xero.com/oct111' });
await new Promise((r2) => setTimeout(r2, 200));
check('…so their next mail asks again', Boolean(out.awaiting), true);
check('…and nothing is fetched', calls, 3);
check('…leaving a document that asks', listBills('cybm').length, before + 1);

// --- With no n8n at all, nothing is asked ------------------------------------
// The answer to the question would lead nowhere, so asking it would put a
// document in the inbox for every newsletter that ever reached a CYBills
// address. The mail is still mirrored, links and all.
const { env } = await import('../src/env.ts');
const configured = env.N8N_FETCH_URL;
env.N8N_FETCH_URL = '';
const quiet = listBills('cybm').length;
out = await deliver({ from: 'news@marketing.example', subject: 'Our September newsletter', text: 'https://marketing.example/september' });
await new Promise((r) => setTimeout(r, 200));
check('with no n8n webhook, nothing is asked', [Boolean(out.awaiting), listBills('cybm').length], [false, quiet]);
check('…but the mail is still mirrored, links and all', loadMail().find((m) => m.subject.includes('newsletter'))?.links.length, 1);
env.N8N_FETCH_URL = configured;

await finish(failures, server, n8n);
