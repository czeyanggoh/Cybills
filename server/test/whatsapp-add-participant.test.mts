// Adding a number to the group that already exists.
//
// A person changes their phone. Two things are then true at once: they are
// reachable on the new number, and the group holds the old one — and WhatsApp
// cannot swap a number inside a group. The only answer CYBills had was to open
// a SECOND group, which puts a second real conversation in front of a client
// and splits the paperwork across the two with nothing saying which is current.
//
// WhatsApp can hold both numbers, though. So what is pinned here is that adding
// touches the group that exists rather than making another, that the number is
// stored as theirs (an unstored one lands every bill they send on the entity's
// General account), that WhatsApp declining to add somebody is REPORTED and not
// mistaken for success, and that the two kinds of group CYBills has no business
// editing are refused — the same two the rename and the close paths refuse.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
type AddCall = { submission_id: string; participants: string[] };
const addCalls: AddCall[] = [];
const createCalls: unknown[] = [];
// WhatsApp hands back LIDs — opaque per-user ids — not the numbers we sent, so
// the stub answers the way the real thing does.
let addReply: { status: number; body: unknown } = { status: 200, body: { data: { participants_added: ['217630539546875'] } } };
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
          participants_added: body.participants,
          participants_requested: body.participants,
          already_existed: false,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (url.includes('/api/webhooks/cybills/add-participants')) {
    addCalls.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify(addReply.body), {
      status: addReply.status,
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

// --- The ordinary case: her number changed -----------------------------------
let r = await post('channels/user', { userId: jenny.id, mobile: '6594247700' }, ORG);
const group = r.body.channel.submissionId as string;
check('the group is opened with the old number', channelById(group)?.participantsRequested, ['6594247700']);

const groupsBefore = createCalls.length;
r = await post(`channels/${group}/participants`, { mobile: '6592961171' }, ORG);
check('adding succeeds', r.status, 200);
check('CYWS is asked for THAT group, by submission id', addCalls.at(-1), { submission_id: group, participants: ['6592961171'] });
check('and no second group is made', createCalls.length, groupsBefore);
check('the group now holds both numbers', channelById(group)?.participantsRequested, ['6594247700', '6592961171']);
check('the one it was opened with is still first', channelById(group)?.participantsRequested[0], '6594247700');
check('it is the same conversation as before', channelById(group)?.chatId, '120363000001@g.us');
check('and still open', channelById(group)?.status, 'open');

// The number is what a bill arriving from it is matched back to. Unstored,
// everything she sends lands on the entity's General account instead — which is
// the one thing this card exists to prevent — so adding stores it, exactly as
// connecting does.
check('the number is stored as hers', rowFor(jenny.id).mobile, '6592961171');

// WhatsApp answered with a LID, so it is kept alongside the one from the open.
check('what WhatsApp acknowledged is kept', channelById(group)?.participantsAdded.length, 2);
check('so nobody is reported missing', r.body.channel.addedShortfall, 0);

// --- Pressing it again --------------------------------------------------------
// Asking twice would put a second "added" line in front of everyone in the
// group to change nothing at all.
let before = addCalls.length;
r = await post(`channels/${group}/participants`, { mobile: '6592961171' }, ORG);
check('a number already in the group is not an error', [r.status, r.body.already], [200, true]);
check('and nothing is asked of CYWS', addCalls.length, before);
// Written in another shape. The same number, so the same answer.
r = await post(`channels/${group}/participants`, { mobile: '+65 9296 1171' }, ORG);
check('however it is typed', [r.status, r.body.already], [200, true]);
check('still nothing asked', addCalls.length, before);

// --- A number that cannot be one ---------------------------------------------
// A leading 0 is a national trunk prefix, and no country code starts with one,
// so there is no way to know which country to put in front of it. Refused
// rather than guessed at — guessing would add a stranger abroad to a group
// holding a client's bills.
r = await post(`channels/${group}/participants`, { mobile: '091234567' }, ORG);
check('a number that cannot be international is refused', [r.status, r.body.error], [400, 'participant_required']);
check('and named back, so it can be corrected', r.body.rejected, ['091234567']);
check('nothing reached CYWS', addCalls.length, before);

// --- WhatsApp declining ------------------------------------------------------
// It silently refuses somebody whose privacy settings disallow it and answers
// as though nothing happened. That is not an error and must not read as one —
// but it must not pass unsaid either, or she sits waiting to be added to a
// group she will never see.
addReply = { status: 200, body: { data: { participants_added: [] } } };
r = await post(`channels/${group}/participants`, { mobile: '6588887777' }, ORG);
check('a refusal by WhatsApp is still a 200', r.status, 200);
check('but nothing is claimed to have been added', r.body.addedNow, 0);
check('the number is on the record as asked for', channelById(group)?.participantsRequested.includes('6588887777'), true);
check('and the shortfall says so out loud', r.body.channel.addedShortfall, 1);
addReply = { status: 200, body: { data: { participants_added: ['217630539546876'] } } };

// --- A CYWS that has never heard of the route --------------------------------
// An older one 404s the path itself, with no error of its own. Reported as
// WhatsApp refusing, that would have somebody pressing the button all
// afternoon, so the two are told apart.
addReply = { status: 404, body: null };
before = addCalls.length;
const mobileBefore = rowFor(jenny.id).mobile;
r = await post(`channels/${group}/participants`, { mobile: '6577776666' }, ORG);
check('an unimplemented route is named as one', [r.status, r.body.error], [404, 'route_unavailable']);
check('and is not offered as retryable', r.body.retryable, false);
check('nothing is recorded on the strength of a call that failed', channelById(group)?.participantsRequested.includes('6577776666'), false);
check('nor is the number stored as hers', rowFor(jenny.id).mobile, mobileBefore);

// A group CYWS knows nothing about is a different answer, and says so.
addReply = { status: 404, body: { error: 'unknown_submission' } };
r = await post(`channels/${group}/participants`, { mobile: '6577776666' }, ORG);
check('an unknown group is not confused with an unknown route', r.body.error, 'unknown_submission');

// And WhatsApp declining the request itself is worth pressing again.
addReply = { status: 502, body: { error: 'add_participants_failed' } };
r = await post(`channels/${group}/participants`, { mobile: '6577776666' }, ORG);
check('WhatsApp refusing is retryable', [r.status, r.body.retryable], [502, true]);
addReply = { status: 200, body: { data: { participants_added: ['217630539546877'] } } };

// --- The two kinds of group this may not touch -------------------------------
// A conversation the client already had, merely pointed at CYBills. Putting a
// number into it from an accounting app is the same species of act as taking it
// apart, which the close path refuses to do unasked.
r = await post('channels/attach', { user_id: jenny.id, chat_id: '120363999@g.us', subject: 'Sunstream bills' }, KEY);
const adopted = r.body.channel.submissionId as string;
before = addCalls.length;
r = await post(`channels/${adopted}/participants`, { mobile: '6512341234' }, ORG);
check("the client's own group is refused", [r.status, r.body.error], [409, 'channel_adopted']);
check('and nothing is asked of CYWS', addCalls.length, before);

// A collection that has been closed. Adding somebody would put them in a group
// nothing here reads.
await post(`channels/${group}/close`, {}, ORG);
r = await post(`channels/${group}/participants`, { mobile: '6512341234' }, ORG);
check('a closed collection is refused', [r.status, r.body.error], [409, 'channel_not_open']);
check('still nothing asked of CYWS', addCalls.length, before);

// --- An id nobody holds ------------------------------------------------------
r = await post('channels/CYB-nope-0000/participants', { mobile: '6512341234' }, ORG);
check('an unknown submission id is a 404', [r.status, r.body.error], [404, 'unknown_channel']);

server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
