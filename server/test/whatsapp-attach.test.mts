// Pointing a group that ALREADY EXISTS at somebody, and how many of those one
// person may have.
//
// The rule here was "one person, one group", and it was wrong in exactly one
// direction. It is right for OPENING a group — a second one would appear in
// front of a client for no reason. It is wrong for adopting a conversation that
// is already running, because refusing does not prevent a split: it leaves the
// operator no way to point the chat at that person except to hand it the
// submission id of a group they already have. Two chats on one id is not two
// collections, it is ONE — CYBills cannot tell them apart at all, and both
// conversations fold into a single row and a single thread. Which is how a
// bridge chat came to appear as somebody's personal group.
//
// So: a person may collect through several groups, each with its own id; a
// GROUP still belongs to one person; and none of it splits the book, because
// every channel names the same person.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-wa-attach-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'relay-key';
process.env.CYWORKSPACE_RELAY_URL = 'https://cyworkspace.cy-bm.sg';
process.env.WHATSAPP_INBOUND_KEY = 'inbound-key';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'Acme Pte Ltd', tenantId: 't-1', tenantName: 'Acme', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/api/webhooks/cybills/create-group')) {
    const body = JSON.parse(String(init?.body ?? '{}'));
    return new Response(
      JSON.stringify({
        data: {
          chat_id: '120363000@g.us',
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
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

const express = (await import('express')).default;
const { whatsappRouter, channelById } = await import('../src/whatsapp.ts');
const { ensure, save } = await import('../src/users.ts');

const users = ensure('cybm');
const dean = users.find((u) => u.email === 'astridy2004@gmail.com')!;
dean.organisationId = 'org_one0001';
dean.mobile = '+60 12-345 6789';
save(users);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/whatsapp', whatsappRouter);
const server = app.listen(4629, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const ORG = { 'X-Org-Id': 'org_one0001' };
const KEY = { 'X-API-Key': 'inbound-key' };
const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`http://127.0.0.1:4629/api/whatsapp/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const get = async (path: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`http://127.0.0.1:4629/api/whatsapp/${path}`, { headers });
  return { status: res.status, body: (await res.json()) as any };
};

// Their own group, opened by CYBot with their number in it.
let r = await post('channels/user', { userId: dean.id, mobile: '60123456789' }, ORG);
check('CYBot opens their group', r.status, 200);
const opened = r.body.channel.submissionId as string;
check('and it is not an adopted one', r.body.channel.adopted, false);

// Now a conversation that was already running — the client chat holding their
// bills — pointed at the same person. This is the case that used to 409.
r = await post('channels/attach', { user_id: dean.id, chat_id: '120363999@g.us', subject: 'CYBM.gcy@dext.cc' }, KEY);
check('a group of their own can be attached as well', r.status, 200);
const adopted = r.body.channel.submissionId as string;
check('and it gets an id of ITS OWN, not the other group’s', adopted === opened, false);
check('marked as adopted, which is what decides how it may be closed', r.body.channel.adopted, true);
check('carrying the name the operator is looking at', r.body.channel.subject, 'CYBM.gcy@dext.cc');

// Both are live, and both name the same person — which is why nothing splits.
r = await get(`channels?userId=${dean.id}`);
const open = (r.body.channels ?? []).filter((c: any) => c.status === 'open');
check('they now collect through two groups', open.length, 2);
check('both filed under them', open.every((c: any) => c.userId === dean.id), true);
check('and the two are told apart', open.map((c: any) => c.adopted).sort(), [false, true]);

// A GROUP still belongs to one person. Two channels on one chat id would file
// the same bill into two people's books.
r = await post('channels/attach', { user_id: dean.id, chat_id: '120363999@g.us', subject: 'again' }, KEY);
check('the same chat cannot be attached twice', [r.status, r.body.error], [409, 'chat_in_use']);

// Each collects on its own. A document sent into one names that submission id,
// so it is that thread it lands in — the whole thing the fold destroyed.
r = await post('message', { submission_id: adopted, wa_message_id: 'WA-1', body: 'the bill is coming' }, KEY);
check('a message into the adopted group is accepted', r.status, 200);
r = await get(`threads/${adopted}`, ORG);
check('and lands in ITS thread', r.body.messages.length, 1);
r = await get(`threads/${opened}`, ORG);
check('not in the group CYBot opened', r.body.messages.length, 0);

// Replacing a group because the number drifted must not touch the adopted one:
// CYBot cannot swap a number inside a conversation it merely joined, and
// marking it replaced would quietly stop collecting from a chat still in use.
r = await post('channels/user', { userId: dean.id, mobile: '6591234567', replace: true }, ORG);
check('replacing opens a new group', r.status, 200);
check('the group CYBot opened is the one retired', channelById(opened)?.status, 'replaced');
check('the adopted conversation is left alone', channelById(adopted)?.status, 'open');

server.close();
globalThis.fetch = realFetch;
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
