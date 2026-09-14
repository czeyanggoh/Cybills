// A number for the group that already exists — sent an INVITE, never added.
//
// A person changes their phone. Two things are then true at once: they are
// reachable on the new number, and the group was opened for the old one. The
// answer is still the same group rather than a second one — but CYBot does not
// put the number into it. CYBot adding numbers that have never spoken to it is
// the pattern WhatsApp enforces against, and the number is shared by every
// client's group. So the person is emailed the group's invite link and joins
// from the new number themselves.
//
// What is pinned here: no add-participants call ever goes to CYWS, no second
// group is made, the number is stored as theirs (an unstored one lands every
// bill they send on the entity's General account), the link is fetched when the
// group has none and REPORTED when it cannot be had, and the two kinds of group
// CYBills has no business editing are refused — the same two the rename and the
// close paths refuse.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-wa-add-'));
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
const addCalls: unknown[] = [];
const linkCalls: any[] = [];
// The create answers with no link — CYWS made the group and could not read it —
// so the first add has to ask for one.
let linkReply: { status: number; body: unknown } = { status: 200, body: { data: { invite_link: 'https://chat.whatsapp.com/JennyGroup' } } };
let nextChatId = 1;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/api/webhooks/cybills/create-group')) {
    const body = JSON.parse(String(init?.body ?? '{}'));
    createCalls.push(body);
    return new Response(
      JSON.stringify({
        data: {
          chat_id: `12036300000${nextChatId++}@g.us`,
          subject: body.subject,
          submission_id: body.submission_id,
          participants_added: [],
          participants_requested: [],
          invite_link: '',
          already_existed: false,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (url.includes('/api/webhooks/cybills/add-participants')) {
    addCalls.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ data: { participants_added: ['217630539546875'] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('/api/webhooks/cybills/invite-link')) {
    linkCalls.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify(linkReply.body), { status: linkReply.status, headers: { 'Content-Type': 'application/json' } });
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
const jenny = full({ name: 'Jenny Lye', email: 'jenny@sunstream.sg', organisationId: 'org_cybm001', emailHandle: 'jenny.sunstream', login: 'No' }, 'cybm');
items.push(jenny);
save(items);
const rowFor = (id: string) => ensure('cybm').find((u) => u.id === id)!;

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/whatsapp', whatsappRouter);
const server = app.listen(4638, '127.0.0.1');
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
  const res = await fetch(`http://127.0.0.1:4638/api/whatsapp/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

// --- Opening the group: nobody is added --------------------------------------
// The link comes back failing first, so the group opens with none and says so.
linkReply = { status: 502, body: { error: 'invite_link_failed' } };
let r = await post('channels/user', { userId: jenny.id, mobile: '6594247700' }, ORG);
const group = r.body.channel.submissionId as string;
check('the group opens', r.body.channel.status, 'open');
check('asked for invite-only', createCalls.at(-1).invite_only, true);
check('with no numbers sent to CYWS at all', createCalls.at(-1).participants, undefined);
check('and it is recorded as an invite group', r.body.channel.invite, true);
check('the group is FOR the number, though nobody was added', channelById(group)?.participantsRequested, ['6594247700']);
check('a link that could not be had is said, not swallowed', Boolean(r.body.inviteError), true);
check('and nothing is claimed to have been emailed', r.body.invite, null);
linkReply = { status: 200, body: { data: { invite_link: 'https://chat.whatsapp.com/JennyGroup' } } };

// --- The ordinary case: her number changed -----------------------------------
const groupsBefore = createCalls.length;
r = await post(`channels/${group}/participants`, { mobile: '6592961171' }, ORG);
check('sending the invite succeeds', r.status, 200);
check('CYBot is never asked to ADD a number', addCalls.length, 0);
check('the link is fetched for THAT group, by submission id', linkCalls.at(-1), { submission_id: group });
check('and handed back', r.body.inviteLink, 'https://chat.whatsapp.com/JennyGroup');
check('and kept on the channel', channelById(group)?.inviteLink, 'https://chat.whatsapp.com/JennyGroup');
check('no second group is made', createCalls.length, groupsBefore);
check('the group is now for both numbers', channelById(group)?.participantsRequested, ['6594247700', '6592961171']);
check('it is the same conversation as before', channelById(group)?.chatId, '120363000001@g.us');
check('and still open', channelById(group)?.status, 'open');
check('nobody is reported missing — nobody was asked of WhatsApp', r.body.channel.addedShortfall, 0);

// The number is what a bill arriving from it is matched back to.
check('the number is stored as hers', rowFor(jenny.id).mobile, '6592961171');

// The email is attempted to her own address. This deploy has no mailbox, which
// is reported rather than claimed as sent.
check('the invite goes to her address', r.body.invite?.email, 'jenny@sunstream.sg');
check('and a deploy with no mailbox says it did not go', r.body.invite?.sent, false);

// A stored link is reused rather than fetched again.
const linksBefore = linkCalls.length;
r = await post(`channels/${group}/invite`, { send: false }, ORG);
check('the invite route returns the stored link', [r.status, r.body.inviteLink], [200, 'https://chat.whatsapp.com/JennyGroup']);
check('without asking CYWS again', linkCalls.length, linksBefore);
check('and sends nothing when told not to', r.body.invite, null);

r = await post(`channels/${group}/invite`, { email: 'not an address' }, ORG);
check('a typed address that is not one is refused', [r.status, r.body.error], [400, 'invalid_email']);
r = await post(`channels/${group}/invite`, { email: 'ops@sunstream.sg' }, ORG);
check('a typed address is where it goes', r.body.invite?.email, 'ops@sunstream.sg');

// --- Pressing it again --------------------------------------------------------
let before = linkCalls.length;
r = await post(`channels/${group}/participants`, { mobile: '6592961171' }, ORG);
check('a number already on the group is not an error', [r.status, r.body.already], [200, true]);
r = await post(`channels/${group}/participants`, { mobile: '+65 9296 1171' }, ORG);
check('however it is typed', [r.status, r.body.already], [200, true]);

// --- A number that cannot be one ---------------------------------------------
r = await post(`channels/${group}/participants`, { mobile: '091234567' }, ORG);
check('a number that cannot be international is refused', [r.status, r.body.error], [400, 'participant_required']);
check('and named back, so it can be corrected', r.body.rejected, ['091234567']);

// --- A CYWS that has never heard of the invite route --------------------------
// Only reachable for a group with no stored link — one opened before invites.
{
  const channel = channelById(group)!;
  const { patchChannel } = await import('../src/waChannels.ts');
  patchChannel(channel.id, { inviteLink: '' });
}
linkReply = { status: 404, body: null };
before = linkCalls.length;
const mobileBefore = rowFor(jenny.id).mobile;
r = await post(`channels/${group}/participants`, { mobile: '6577776666' }, ORG);
check('an unimplemented route is named as one', [r.status, r.body.error], [404, 'invite_route_unavailable']);
check('and is not offered as retryable', r.body.retryable, false);
check('nothing is recorded on the strength of a call that failed', channelById(group)?.participantsRequested.includes('6577776666'), false);
check('nor is the number stored as hers', rowFor(jenny.id).mobile, mobileBefore);

linkReply = { status: 404, body: { error: 'unknown_submission' } };
r = await post(`channels/${group}/participants`, { mobile: '6577776666' }, ORG);
check('an unknown group is not confused with an unknown route', r.body.error, 'unknown_submission');

linkReply = { status: 502, body: { error: 'invite_link_failed' } };
r = await post(`channels/${group}/participants`, { mobile: '6577776666' }, ORG);
check('WhatsApp refusing is retryable', [r.status, r.body.retryable], [502, true]);
linkReply = { status: 200, body: { data: { invite_link: 'https://chat.whatsapp.com/JennyGroup' } } };

// --- The two kinds of group this may not touch -------------------------------
r = await post('channels/attach', { user_id: jenny.id, chat_id: '120363999@g.us', subject: 'Sunstream bills' }, KEY);
const adopted = r.body.channel.submissionId as string;
before = linkCalls.length;
r = await post(`channels/${adopted}/participants`, { mobile: '6512341234' }, ORG);
check("the client's own group is refused", [r.status, r.body.error], [409, 'channel_adopted']);
r = await post(`channels/${adopted}/invite`, {}, ORG);
check("and so is sharing its link", [r.status, r.body.error], [409, 'channel_adopted']);
check('and nothing is asked of CYWS', linkCalls.length, before);

await post(`channels/${group}/close`, {}, ORG);
r = await post(`channels/${group}/participants`, { mobile: '6512341234' }, ORG);
check('a closed collection is refused', [r.status, r.body.error], [409, 'channel_not_open']);
r = await post(`channels/${group}/invite`, {}, ORG);
check('and has no link to share', [r.status, r.body.error], [409, 'channel_not_open']);
check('still nothing asked of CYWS', linkCalls.length, before);

// --- An id nobody holds ------------------------------------------------------
r = await post('channels/CYB-nope-0000/participants', { mobile: '6512341234' }, ORG);
check('an unknown submission id is a 404', [r.status, r.body.error], [404, 'unknown_channel']);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
await finish(failures, server);
