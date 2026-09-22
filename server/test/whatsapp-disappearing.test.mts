// A collection group's messages can be set to disappear after 7 days.
//
// WhatsApp's own group setting. A collection group is a PIPE rather than a
// record — by the time a bill has been mirrored and filed, CYWS holds its bytes
// in the shared bucket and CYBills holds a document pointing at them, none of
// it in WhatsApp — so the chat clearing itself loses nothing anybody accounts
// from, and what it stops is a client's paperwork living for ever on the phone
// of everybody who has ever been in the group.
//
// What is pinned here: the route sends WhatsApp's own duration for seven days,
// it is what the button gets without asking for anything, only the four
// durations WhatsApp takes are accepted, a refusal records nothing (the card
// must not state a setting the phones never had), and the two kinds of group
// CYBills has no business editing are refused — the same two the promote,
// rename and add paths refuse.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-wa-disappearing-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'relay-key';
process.env.CYWORKSPACE_RELAY_URL = 'https://cyworkspace.cy-bm.sg';
process.env.WHATSAPP_INBOUND_KEY = 'inbound-key';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_cybm001', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-1', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

// --- CYWS, stubbed -----------------------------------------------------------
const setCalls: any[] = [];
let setReply: { status: number; body: unknown } = { status: 200, body: { data: { ok: true } } };
let nextChatId = 1;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = JSON.parse(String(init?.body ?? '{}'));
  if (url.includes('/api/webhooks/cybills/create-group')) {
    return new Response(
      JSON.stringify({
        data: {
          chat_id: `12036300000${nextChatId++}@g.us`,
          subject: body.subject,
          submission_id: body.submission_id,
          participants_added: [],
          participants_requested: [],
          already_existed: false,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (url.includes('/api/webhooks/cybills/invite-link')) {
    return new Response(JSON.stringify({ data: { invite_link: 'https://chat.whatsapp.com/AstridGroup' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('/api/webhooks/cybills/set-disappearing')) {
    setCalls.push(body);
    return new Response(JSON.stringify(setReply.body), { status: setReply.status, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('/api/webhooks/cybills/delete-group')) {
    return new Response(JSON.stringify({ data: { removed: 0, left: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

const express = (await import('express')).default;
const { whatsappRouter, channelById } = await import('../src/whatsapp.ts');
const { ensure, save, full } = await import('../src/users.ts');

const items = ensure('cybm');
const astrid = full({ name: 'Astrid Ho', email: 'astrid@sunstream.sg', organisationId: 'org_cybm001', emailHandle: 'astrid', login: 'No' }, 'cybm');
items.push(astrid);
save(items);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/whatsapp', whatsappRouter);
const server = app.listen(4649, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const ORG = { 'X-Org-Id': 'org_cybm001' };
const KEY = { 'X-API-Key': 'inbound-key' };
const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`http://127.0.0.1:4649/api/whatsapp/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

// --- A group, and seven days -------------------------------------------------
let r = await post('channels/user', { userId: astrid.id, mobile: '6594247700' }, ORG);
const group = r.body.channel.submissionId as string;
check('a new group is not asked about', channelById(group)?.disappearing ?? null, null);
check('and says nothing about it', r.body.channel.disappearing, null);

r = await post(`channels/${group}/disappearing`, {}, ORG);
check('setting it succeeds', r.status, 200);
// Seven days in seconds, which is one of the four durations WhatsApp takes.
check('CYWS is asked for THAT group, for 7 days', setCalls.at(-1), { submission_id: group, duration: 604800 });
check('and the reply carries the wording', [r.body.seconds, r.body.label], [604800, '7 days']);
check('it is recorded on the group', channelById(group)?.disappearing?.seconds, 604800);
check('and labelled for the card', r.body.channel.disappearing.label, '7 days');

// --- Only WhatsApp's own durations -------------------------------------------
let before = setCalls.length;
r = await post(`channels/${group}/disappearing`, { seconds: 3600 }, ORG);
check('a duration WhatsApp does not take is refused', [r.status, r.body.error], [400, 'invalid_duration']);
check('and nothing is asked of CYWS', setCalls.length, before);

r = await post(`channels/${group}/disappearing`, { seconds: 0 }, ORG);
check('off is one of them', [r.status, r.body.label], [200, 'off']);
check('and is recorded as what the group now is', channelById(group)?.disappearing?.seconds, 0);

// --- A refusal records nothing -----------------------------------------------
// What is stored is what the group IS. A record left behind by a failed call
// would have the card stating a setting the phones in the group never had.
setReply = { status: 502, body: { error: 'disappearing_failed' } };
r = await post(`channels/${group}/disappearing`, {}, ORG);
check('WhatsApp refusing is retryable', [r.status, r.body.retryable], [502, true]);
check('and leaves the record as it was', channelById(group)?.disappearing?.seconds, 0);

// --- A CYWS that has never heard of the route --------------------------------
// An older one 404s the path itself, with no error of its own. Reported as
// WhatsApp refusing, that would have somebody pressing the button all
// afternoon, so the two are told apart — as they are on the promote road.
setReply = { status: 404, body: null };
r = await post(`channels/${group}/disappearing`, {}, ORG);
check('an unimplemented route is named as one', [r.status, r.body.error], [404, 'disappearing_route_unavailable']);
check('and is not offered as retryable', r.body.retryable, false);

setReply = { status: 404, body: { error: 'unknown_submission' } };
r = await post(`channels/${group}/disappearing`, {}, ORG);
check('an unknown group is not confused with an unknown route', r.body.error, 'unknown_submission');
setReply = { status: 200, body: { data: { ok: true } } };

// --- The two kinds of group this may not touch -------------------------------
r = await post('channels/attach', { user_id: astrid.id, chat_id: '120363999@g.us', subject: 'Sunstream bills' }, KEY);
const adopted = r.body.channel.submissionId as string;
before = setCalls.length;
r = await post(`channels/${adopted}/disappearing`, {}, ORG);
check("the client's own group is refused", [r.status, r.body.error], [409, 'channel_adopted']);
check('and nothing is asked of CYWS', setCalls.length, before);

await post(`channels/${group}/close`, {}, ORG);
r = await post(`channels/${group}/disappearing`, {}, ORG);
check('a closed collection is refused', [r.status, r.body.error], [409, 'channel_not_open']);
check('still nothing asked of CYWS', setCalls.length, before);

// --- An id nobody holds ------------------------------------------------------
r = await post('channels/CYB-nope-0000/disappearing', {}, ORG);
check('an unknown submission id is a 404', [r.status, r.body.error], [404, 'unknown_channel']);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
await finish(failures, server);
