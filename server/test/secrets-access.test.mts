// The two credentials on the Extraction page belong to the DEPLOYMENT, not to
// whichever entity happens to be open.
//
// INBOUND_SECRET authorises submitting a document for any handle in any client
// entity. CYBILLS_API_KEY authorises filing a bill into any client's book. The
// SENDING MAILBOX is one mailbox for the whole account — every client's
// invitations and password resets leave from it. So a client's own Business
// Admin — who is an admin, and does see Business settings — must not be able to
// reach any of them: with one of the keys they could file documents into another
// client's books or read another client's paperwork out of their own, and with
// the mailbox they could disconnect everybody's account email. They are the
// practice's, and the practice's only.
//
// Checked on the SERVER, because the page hiding a block is a decision the
// browser makes and anybody can ask the API directly.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-secrets-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';
// Sign-in configured, which is what production looks like: without it the
// server stays open for local development and this would prove nothing.
process.env.GOOGLE_CLIENT_ID = 'x';
process.env.GOOGLE_CLIENT_SECRET = 'x';
process.env.INBOUND_SECRET = 'the-worker-secret';
process.env.WHATSAPP_INBOUND_KEY = 'the-cyws-key';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'CYBM', tenantId: 't-1', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const jwt = (await import('jsonwebtoken')).default;
const { inboundRouter } = await import('../src/inbound.ts');
const { whatsappRouter } = await import('../src/whatsapp.ts');
const { mailRouter } = await import('../src/mail.ts');
const { ensure, save } = await import('../src/users.ts');

// One of the practice's own, and one client entity's Business Admin.
const items = ensure('cybm');
const colleague = items.find((u) => u.email === 'astridy2004@gmail.com')!;
colleague.practice = true;
items.unshift({
  ...colleague,
  id: 'client_admin',
  name: 'Client Admin',
  email: 'admin@acme.example',
  practice: false,
  practiceRole: 'Standard',
  role: 'Business Admin',
  clientAccess: [],
  allClients: false,
} as never);
save(items);

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/inbound', inboundRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/mail', mailRouter);
const server = app.listen(4635, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const as = (email: string) =>
  `cyb_session=${jwt.sign({ sub: email, email, name: email }, 'test-session-secret', { expiresIn: '1h' })}`;

const get = async (path: string, cookie?: string) => {
  const res = await fetch(`http://127.0.0.1:4635${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

const post = async (path: string, cookie?: string) => {
  const res = await fetch(`http://127.0.0.1:4635${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: '{}',
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

// --- A client entity's own admin ---------------------------------------------
let r = await get('/api/inbound/config', as('admin@acme.example'));
check('a client admin cannot read the inbound-email secret', r.status, 403);
check('and is told why', r.body.error, 'not_practice_team');
check('the secret is not in the body', JSON.stringify(r.body).includes('the-worker-secret'), false);

r = await get('/api/whatsapp/config', as('admin@acme.example'));
check('nor the WhatsApp key', r.status, 403);
check('and is told why', r.body.error, 'not_practice_team');
check('the key is not in the body', JSON.stringify(r.body).includes('the-cyws-key'), false);

// The sending mailbox is the deployment's too, and DISCONNECTING it would stop
// account email for every client — so reading the panel, connecting, testing and
// disconnecting are all the practice's.
r = await get('/api/mail/status', as('admin@acme.example'));
check('a client admin cannot read the sending mailbox', [r.status, r.body.error], [403, 'not_practice_team']);
r = await post('/api/mail/disconnect', as('admin@acme.example'));
check('nor disconnect it', [r.status, r.body.error], [403, 'not_practice_team']);
r = await post('/api/mail/test', as('admin@acme.example'));
check('nor send from it', [r.status, r.body.error], [403, 'not_practice_team']);

// --- Nobody at all -----------------------------------------------------------
r = await get('/api/inbound/config');
check('a caller with no session is refused', r.status, 403);
r = await get('/api/whatsapp/config');
check('for both', r.status, 403);

// --- The practice's own ------------------------------------------------------
r = await get('/api/inbound/config', as('astridy2004@gmail.com'));
check('a colleague reads the inbound secret', r.status, 200);
check('and it is the real one', r.body.secret, 'the-worker-secret');

r = await get('/api/whatsapp/config', as('astridy2004@gmail.com'));
check('and the WhatsApp key', r.status, 200);
check('also the real one', r.body.apiKey, 'the-cyws-key');

r = await get('/api/mail/status', as('astridy2004@gmail.com'));
check('and the sending mailbox is theirs to see', r.status, 200);

// --- A colleague who has been deactivated ------------------------------------
{
  const rows = ensure('cybm');
  rows.find((u) => u.id === colleague.id)!.deactivated = true;
  save(rows);
  r = await get('/api/whatsapp/config', as('astridy2004@gmail.com'));
  check('a deactivated colleague loses them again', r.status, 403);
  r = await get('/api/mail/status', as('astridy2004@gmail.com'));
  check('the mailbox included', r.status, 403);
  rows.find((u) => u.id === colleague.id)!.deactivated = false;
  save(rows);
}

server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
