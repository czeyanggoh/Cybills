// "Ignore future mail like this": a document the CYWS AP Mailbox forwarded asks
// CYWS to stop forwarding mail like it. Over real HTTP in, and against a stub
// CYWS out, so what is asserted is the request that actually leaves.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-ap-ignore-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.INBOUND_SECRET = 'test-inbound-secret';
process.env.N8N_FETCH_URL = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4662';
process.env.CYWORKSPACE_API_KEY = 'cyws-key';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-1', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org_two0002', orgId: 'cybm', name: 'Bridge', tenantId: '', tenantName: '', kind: 'standalone', parentOrgId: 'org_one0001', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

// The stub CYWS: records each call, answers like the real handler.
const calls: Array<{ key: string; body: any }> = [];
let answer: { status: number; body: unknown } = { status: 200, body: { added: true, description: 'from support@info.airwallex.com', mailboxes: ['czeyang.goh@cy-bm.sg'] } };
const cyws = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.url === '/api/webhooks/cybills/ap-mailbox/ignore') {
      calls.push({ key: String(req.headers['x-api-key'] || ''), body: JSON.parse(raw || '{}') });
      res.writeHead(answer.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer.body));
    } else res.writeHead(404).end();
  });
});
await new Promise<void>((r) => cyws.listen(4662, '127.0.0.1', r));

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
app.use(express.json());
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
const api = async (path: string, body: unknown, org = 'org_one0001') => {
  const res = await fetch(`http://127.0.0.1:4661/api/email${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': org },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

// The AP Mailbox's forward of an Airwallex statement, as it arrives here.
await fetch('http://127.0.0.1:4661/api/inbound/email', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Inbound-Secret': 'test-inbound-secret' },
  body: JSON.stringify({
    to: 'astrid4@cybills.sg',
    from: 'czeyang.goh@cy-bm.sg',
    subject: 'Fwd: Your Airwallex billing statement is ready',
    text: 'Forwarded automatically from czeyang.goh@cy-bm.sg for CYBills processing.\n\nOriginal sender: support@info.airwallex.com\n\nThe latest statement is ready. Invoice: total amount due SGD 0.00',
    messageId: '<aw-1@info.airwallex.com>',
  }),
});
await new Promise((r) => setTimeout(r, 300));
const bill = listBills('cybm')[0]!;
check('the forward is a document here', Boolean(bill?.id), true);

let r = await api(`/documents/${bill.id}/ignore-sender`, {
  scope: 'person', address: 'support@info.airwallex.com', subject: 'your airwallex billing statement is ready',
});
check('the rule is saved', [r.status, r.body.ok, r.body.added], [200, true, true]);
check('…with the CYWS key', calls[0]?.key, 'cyws-key');
check('…naming the Xero org, the address it was delivered to and the scope', [
  calls[0]?.body.tenant_id, calls[0]?.body.delivered_to, calls[0]?.body.scope, calls[0]?.body.address, calls[0]?.body.subject,
], ['t-1', 'astrid4@cybills.sg', 'person', 'support@info.airwallex.com', 'your airwallex billing statement is ready']);
// No session in this harness, so the rule is signed by the app itself.
check('…and who asked', calls[0]?.body.added_by, 'CYBills');

r = await api(`/documents/${bill.id}/ignore-sender`, { scope: 'entity', domain: 'airwallex.com' });
check('entity scope is passed as such', [r.status, calls[1]?.body.scope, calls[1]?.body.domain], [200, 'entity', 'airwallex.com']);

r = await api(`/documents/${bill.id}/ignore-sender`, { scope: 'person' });
check('a rule naming no sender is refused here, before CYWS', [r.status, r.body.error, calls.length], [422, 'no_sender', 2]);

answer = { status: 404, body: { error: 'no_ap_mailbox', message: 'No AP Mailbox for this Xero org forwards to astrid4@cybills.sg' } };
r = await api(`/documents/${bill.id}/ignore-sender`, { scope: 'person', address: 'a@b.com' });
check("CYWS's refusal comes back in its own words", [r.status, r.body.error, r.body.message.startsWith('No AP Mailbox')], [404, 'no_ap_mailbox', true]);

answer = { status: 404, body: 'Cannot POST' };
r = await api(`/documents/${bill.id}/ignore-sender`, { scope: 'person', address: 'a@b.com' });
check('an older CYWS with no such route says it needs updating', [r.status, r.body.error], [502, 'cyws_outdated']);

r = await api(`/documents/${bill.id}/ignore-sender`, { scope: 'person', address: 'a@b.com' }, 'org_two0002');
check("another entity cannot reach this document's mail", r.status, 404);

await finish(failures, server, cyws);
