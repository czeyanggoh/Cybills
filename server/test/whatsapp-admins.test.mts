// Everyone in a collection group is an ADMIN of it.
//
// A group CYBot opens has to keep working when CYBot is not looking at it. Only
// an admin of a WhatsApp group can add somebody to it, rename it, or take
// somebody out — and every shortfall this app reports ends in exactly that
// instruction ("somebody already in the group has to add them", because CYWS
// mints no invite link), which an ordinary member cannot follow. So the people
// CYBills puts into a group go in as admins, on both roads a person is added
// by, and a group opened before that can be repaired.
//
// What is pinned here: the ask travels with the group being MADE rather than as
// a step somebody remembers, it travels with a number added to an existing
// group, the repair promotes whoever the group holds without naming anybody
// (WhatsApp answers with LIDs, and an entity-wide group can hold a member added
// from inside WhatsApp whose number was never typed here), pressing it twice is
// safe, and the two kinds of group CYBills has no business editing are refused
// — the same two the rename and the add paths refuse.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-wa-admins-'));
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
const createCalls: any[] = [];
const addCalls: any[] = [];
const promoteCalls: any[] = [];
// WhatsApp hands back LIDs — opaque per-user ids — never the numbers we sent.
let promoteReply: { status: number; body: unknown } = { status: 200, body: { data: { participants_promoted: ['217630539546875'] } } };
let nextChatId = 1;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = JSON.parse(String(init?.body ?? '{}'));
  if (url.includes('/api/webhooks/cybills/create-group')) {
    createCalls.push(body);
    return new Response(
      JSON.stringify({
        data: {
          chat_id: `12036300000${nextChatId++}@g.us`,
          subject: body.subject,
          submission_id: body.submission_id,
          participants_added: ['217630539546800'],
          participants_requested: body.participants,
          // Promoted as the group was made, because it was asked for there.
          participants_promoted: body.promote_participants ? ['217630539546800'] : [],
          already_existed: false,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (url.includes('/api/webhooks/cybills/add-participants')) {
    addCalls.push(body);
    return new Response(
      JSON.stringify({
        data: {
          participants_added: ['217630539546801'],
          participants_promoted: body.promote ? ['217630539546801'] : [],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (url.includes('/api/webhooks/cybills/promote-participants')) {
    promoteCalls.push(body);
    return new Response(JSON.stringify(promoteReply.body), {
      status: promoteReply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (url.includes('/api/webhooks/cybills/delete-group')) {
    return new Response(JSON.stringify({ data: { removed: 1, left: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
const server = app.listen(4641, '127.0.0.1');
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
  const res = await fetch(`http://127.0.0.1:4641/api/whatsapp/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

// --- Opening a group ---------------------------------------------------------
// Asked for as the group is MADE, not as a step afterwards: a step afterwards
// is one somebody has to remember, and the person who forgets it is the one who
// then cannot add their colleague.
let r = await post('channels/user', { userId: astrid.id, mobile: '6594247700' }, ORG);
const group = r.body.channel.submissionId as string;
check('the group is asked for with its members as admins', createCalls.at(-1).promote_participants, true);
check('and what WhatsApp made an admin is kept', channelById(group)?.participantsPromoted, ['217630539546800']);
check('counted rather than named, like everything else WhatsApp answers with', r.body.channel.participantsPromotedCount, 1);

// --- Adding a number to that group -------------------------------------------
// The same reasoning: somebody added to a collection group holds the client's
// paperwork, and the next thing asked of them is to add a colleague WhatsApp
// would not add for us.
r = await post(`channels/${group}/participants`, { mobile: '6592961171' }, ORG);
check('a number added to an existing group goes in as an admin', addCalls.at(-1).promote, true);
check('and the answer says so', r.body.promotedNow, 1);
check('both admins are on the record', channelById(group)?.participantsPromoted, ['217630539546800', '217630539546801']);

// --- The repair for a group opened before any of this -------------------------
r = await post(`channels/${group}/admins`, {}, ORG);
check('promoting succeeds', r.status, 200);
check('CYWS is asked for THAT group, by submission id', promoteCalls.at(-1), { submission_id: group });
// Who is in the group is WhatsApp's answer, not ours: it hands back LIDs, and an
// entity-wide group can hold somebody added from inside WhatsApp whose number
// was never typed here. So nobody is named in the request.
check('and nobody is named in it', Object.keys(promoteCalls.at(-1)), ['submission_id']);
check('a newly promoted person is added to the record', channelById(group)?.participantsPromoted?.length, 3);

// Pressing it again. Promoting an existing admin changes nothing at WhatsApp's
// end, so CYWS reports promoting nobody — which must not read as everybody
// having lost it.
promoteReply = { status: 200, body: { data: { participants_promoted: [] } } };
r = await post(`channels/${group}/admins`, {}, ORG);
check('a second press is a 200 that changed nobody', [r.status, r.body.promotedNow], [200, 0]);
check('and takes nothing away from the record', channelById(group)?.participantsPromoted?.length, 3);
promoteReply = { status: 200, body: { data: { participants_promoted: ['217630539546875'] } } };

// --- A CYWS that has never heard of the route --------------------------------
// An older one 404s the path itself, with no error of its own. Reported as
// WhatsApp refusing, that would have somebody pressing the button all
// afternoon, so the two are told apart — as they are on the add road.
promoteReply = { status: 404, body: null };
r = await post(`channels/${group}/admins`, {}, ORG);
check('an unimplemented route is named as one', [r.status, r.body.error], [404, 'promote_route_unavailable']);
check('and is not offered as retryable', r.body.retryable, false);

promoteReply = { status: 404, body: { error: 'unknown_submission' } };
r = await post(`channels/${group}/admins`, {}, ORG);
check('an unknown group is not confused with an unknown route', r.body.error, 'unknown_submission');

promoteReply = { status: 502, body: { error: 'promote_failed' } };
r = await post(`channels/${group}/admins`, {}, ORG);
check('WhatsApp refusing is retryable', [r.status, r.body.retryable], [502, true]);
promoteReply = { status: 200, body: { data: { participants_promoted: ['217630539546875'] } } };

// --- The two kinds of group this may not touch -------------------------------
// A conversation the client already had, merely pointed at CYBills. Handing out
// admin in it from an accounting app is the same species of act as taking it
// apart, which the close path refuses to do unasked.
r = await post('channels/attach', { user_id: astrid.id, chat_id: '120363999@g.us', subject: 'Sunstream bills' }, KEY);
const adopted = r.body.channel.submissionId as string;
let before = promoteCalls.length;
r = await post(`channels/${adopted}/admins`, {}, ORG);
check("the client's own group is refused", [r.status, r.body.error], [409, 'channel_adopted']);
check('and nothing is asked of CYWS', promoteCalls.length, before);

// A collection that has been closed is no longer CYBills' to change.
await post(`channels/${group}/close`, {}, ORG);
r = await post(`channels/${group}/admins`, {}, ORG);
check('a closed collection is refused', [r.status, r.body.error], [409, 'channel_not_open']);
check('still nothing asked of CYWS', promoteCalls.length, before);

// --- An id nobody holds ------------------------------------------------------
r = await post('channels/CYB-nope-0000/admins', {}, ORG);
check('an unknown submission id is a 404', [r.status, r.body.error], [404, 'unknown_channel']);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
await finish(failures, server);
