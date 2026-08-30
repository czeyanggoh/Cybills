// A collection group is named after the address it collects for.
//
// They are one pipe — a bill emailed to `gcy.cybm@cybills.sg` and one sent into
// the group called `gcy.cybm@cybills.sg` file under exactly the same person —
// so the name was never decoration. It was a SNAPSHOT, though, taken when the
// group was created and never touched again, which is how a group came to sit
// there called `czeyanggoh.cybm@cybills.sg` under an Extract-by-email card
// reading `gcy.cybm@cybills.sg`, with nothing on the page to say the two were
// the same thing.
//
// So what is pinned here is that an address which MOVES takes its group with
// it — by either of the two routes that can move one — that the row records
// only what WhatsApp actually took, and that the two kinds of group CYBills has
// no business renaming are left exactly as they are.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-wa-rename-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'relay-key';
process.env.CYWORKSPACE_RELAY_URL = 'https://cyworkspace.cy-bm.sg';
process.env.WHATSAPP_INBOUND_KEY = 'inbound-key';

const org = (id: string, name: string) => ({
  id,
  orgId: 'cybm',
  name,
  tenantId: `t-${id}`,
  tenantName: name,
  createdAt: new Date(0).toISOString(),
  createdBy: '',
});

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({ organisations: [org('org_cybm001', 'CY Business Management'), org('org_red00001', 'Red Alpha')] })
);

// --- CYWS, stubbed -----------------------------------------------------------
type RenameCall = { submission_id: string; subject: string };
const renames: RenameCall[] = [];
let renameReply: { status: number; body: unknown } = { status: 200, body: { data: {} } };
let nextChatId = 1;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/api/webhooks/cybills/create-group')) {
    const body = JSON.parse(String(init?.body ?? '{}'));
    return new Response(
      JSON.stringify({
        data: {
          chat_id: `12036300000${nextChatId++}@g.us`,
          subject: body.subject,
          submission_id: body.submission_id,
          participants_added: body.participants,
          participants_requested: body.participants,
          already_existed: false,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (url.includes('/api/webhooks/cybills/delete-group')) {
    return new Response(JSON.stringify({ data: { removed: 1, left: true } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (url.includes('/api/webhooks/cybills/rename-group')) {
    renames.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify(renameReply.body), {
      status: renameReply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

const express = (await import('express')).default;
const { whatsappRouter, channelById } = await import('../src/whatsapp.ts');
const { organisationsRouter } = await import('../src/organisations.ts');
const { usersRouter, ensure, save, full, addressForUser } = await import('../src/users.ts');

// Two people. Cze is a practice colleague, filed under the practice's own
// entity — which is the case this was reported from, since a colleague's
// address follows the PRACTICE's short form. Martin works for a client.
const items = ensure('cybm');
const cze = items.find((u) => u.email === 'czeyang.goh@cy-bm.sg')!;
const martin = full(
  { name: 'Martin Lim', email: 'martin@redalpha.sg', organisationId: 'org_red00001', emailHandle: 'martin', login: 'Yes' },
  'cybm'
);
items.push(martin);
save(items);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/organisations', organisationsRouter);
app.use('/api/users', usersRouter);
const server = app.listen(4631, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const call = async (method: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`http://127.0.0.1:4631${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

// The rename is deliberately NOT awaited by the request that triggers it — a
// person saving their details must not wait on WhatsApp — so give the loop a
// turn to finish before reading what happened.
const settle = () => new Promise((r) => setTimeout(r, 20));

const connect = async (userId: string, mobile: string, orgId: string) => {
  const r = await call('POST', '/api/whatsapp/channels/user', { userId, mobile }, { 'X-Org-Id': orgId });
  if (!r.body?.channel) throw new Error(`connect failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.channel.submissionId as string;
};

// --- Opened under one name ---------------------------------------------------
const czeGroup = await connect(cze.id, '6592961171', 'org_cybm001');
check('the group is named after the address', channelById(czeGroup)?.subject, 'czeyanggoh@cybills.sg');

// --- The entity takes a short form -------------------------------------------
// Everybody's address moves at once, so every group in the entity does too.
let r = await call('PUT', '/api/organisations/org_cybm001/email-suffix', { suffix: 'cybm' });
check('the short form is saved', [r.status, r.body.organisation.emailSuffix], [200, 'cybm']);
await settle();
check('the address moved', addressForUser(ensure('cybm').find((u) => u.id === cze.id)!), 'czeyanggoh.cybm@cybills.sg');
check('and CYWS was asked to rename the group', renames.at(-1), {
  submission_id: czeGroup,
  subject: 'czeyanggoh.cybm@cybills.sg',
});
check('the row says what the group is now called', channelById(czeGroup)?.subject, 'czeyanggoh.cybm@cybills.sg');

// --- The person changes their handle -----------------------------------------
r = await call('PATCH', `/api/users/${cze.id}`, { emailHandle: 'gcy' });
check('the handle is saved', [r.status, r.body.user.emailHandle], [200, 'gcy']);
await settle();
check('the group follows it', channelById(czeGroup)?.subject, 'gcy.cybm@cybills.sg');
check('which is the address on the card', renames.at(-1)?.subject, 'gcy.cybm@cybills.sg');

// Saving something else about them asks CYWS nothing — the address is what the
// name is made of, and a phone number is not part of it.
let before = renames.length;
await call('PATCH', `/api/users/${cze.id}`, { mobile: '6591234567' });
await settle();
check('an unrelated edit renames nothing', renames.length, before);

// Nor does re-saving the same handle: the group already says that.
await call('PATCH', `/api/users/${cze.id}`, { emailHandle: 'gcy' });
await settle();
check('and neither does saving the same handle again', renames.length, before);

// --- What WhatsApp would not take --------------------------------------------
// The row keeps saying what the group is REALLY called, so the next address
// change tries again rather than believing the two already agree.
renameReply = { status: 502, body: { error: 'rename_failed', message: 'WhatsApp refused' } };
await call('PATCH', `/api/users/${cze.id}`, { emailHandle: 'czeyang' });
await settle();
check('a refusal changes nothing here either', channelById(czeGroup)?.subject, 'gcy.cybm@cybills.sg');
renameReply = { status: 200, body: { data: {} } };
await call('PATCH', `/api/users/${cze.id}`, { emailHandle: 'czeyang' });
await settle();
check('and the next change asks again', channelById(czeGroup)?.subject, 'czeyang.cybm@cybills.sg');

// --- A conversation that was never ours --------------------------------------
// An ADOPTED group is the client's own, merely pointed at CYBills. Renaming it
// from an accounting app is the same species of act as taking it apart, which
// the close path refuses to do unasked.
r = await call(
  'POST',
  '/api/whatsapp/channels/attach',
  { user_id: martin.id, chat_id: '120363999999@g.us', subject: 'Red Alpha — bills' },
  { 'X-API-Key': 'inbound-key' }
);
const adopted = r.body.channel.submissionId as string;
check('the adopted group keeps its own name', channelById(adopted)?.subject, 'Red Alpha — bills');
before = renames.length;
await call('PATCH', `/api/users/${martin.id}`, { emailHandle: 'martinlim' }, { 'X-Org-Id': 'org_red00001' });
await settle();
check("and is not renamed when their address moves", renames.length, before);
check('nor is its name touched here', channelById(adopted)?.subject, 'Red Alpha — bills');

// --- A collection that is over -----------------------------------------------
// Renaming a group CYBills has stopped collecting through would edit a chat
// that is no longer any of its business.
await call('POST', `/api/whatsapp/channels/${czeGroup}/close`, {}, { 'X-Org-Id': 'org_cybm001' });
check('the collection is closed', channelById(czeGroup)?.status, 'disconnected');
before = renames.length;
await call('PATCH', `/api/users/${cze.id}`, { emailHandle: 'czeyanggoh' });
await settle();
check('a closed collection is left alone', renames.length, before);

server.close();
globalThis.fetch = realFetch;
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
