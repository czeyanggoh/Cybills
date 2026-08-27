// Bill collection over WhatsApp: asking CYWorkspace for a group, and receiving
// the supplier bills it picks out of that group.
//
// The two things worth pinning down here are both about things that already
// happened elsewhere. A group is a REAL WhatsApp group with real people in it,
// so a retry has to adopt the one a lost response may already have made rather
// than create a second; and a delivered message is a document already filed, so
// a re-send has to answer "yes, that one" rather than file it twice.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-whatsapp-'));
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

// --- The far end, stubbed ----------------------------------------------------
// Every outbound call CYBills makes here: the create-group request to CYWS, and
// the signed file link it falls back to when the shared bucket isn't readable.
type CreateCall = { submission_id: string; participants: string[]; subject: string };
const createCalls: CreateCall[] = [];
let createReply: { status: number; body: unknown } = { status: 200, body: null };
let fileFetches = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/api/webhooks/cybills/create-group')) {
    createCalls.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify(createReply.body), {
      status: createReply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (url.includes('/api/invoice-file')) {
    fileFetches++;
    return new Response(Buffer.from('%PDF-1.4 a bill'), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf' },
    });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

const express = (await import('express')).default;
const { whatsappRouter, normaliseMobile, channelById } = await import('../src/whatsapp.ts');
const { ensure, save } = await import('../src/users.ts');
const { listBills } = await import('../src/store.ts');

// One person on the roster with a known mobile — the number a document sent in
// from is matched against.
const users = ensure('cybm');
const dean = users.find((u) => u.email === 'astridy2004@gmail.com')!;
dean.organisationId = 'org_one0001';
dean.mobile = '+60 12-345 6789';
dean.emailHandle = 'astrid4';
save(users);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/whatsapp', whatsappRouter);
const server = app.listen(4623, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`http://127.0.0.1:4623/api/whatsapp/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

// --- Phone numbers -----------------------------------------------------------
// CYWS wants bare international digits. People type everything else.
check('a plus and spacing are stripped', normaliseMobile('+60 12-345 6789'), '60123456789');
check('00 is the other way of writing +', normaliseMobile('0060123456789'), '60123456789');
check('brackets and dashes go', normaliseMobile('(65) 9123-4567'), '6591234567');
// A national trunk prefix is refused rather than repaired: no country code
// starts with 0, and guessing which country to prepend would add a stranger.
check('a leading 0 is refused, not guessed at', normaliseMobile('0123456789'), '');
check('too short is refused', normaliseMobile('12345'), '');
check('too long is refused', normaliseMobile('1234567890123456'), '');
check('a word is refused', normaliseMobile('call me'), '');

// --- Asking for a group ------------------------------------------------------
let r = await post('channels', { mobile: 'not a number' }, { 'X-Org-Id': 'org_one0001' });
check('a number CYWS could never use is refused before any group exists', r.status, 400);
check('and the one that was wrong is named', r.body.rejected, ['not a number']);
check('nothing was asked of CYWS', createCalls.length, 0);

// CYWS is having a bad afternoon.
createReply = { status: 502, body: { error: 'group_create_failed' } };
r = await post('channels', { mobile: '60123456789' }, { 'X-Org-Id': 'org_one0001' });
check('a WhatsApp refusal is reported', r.status, 502);
check('and marked worth retrying', r.body.retryable, true);
const firstId = createCalls[0].submission_id;
check('the submission id was minted before the call', Boolean(firstId), true);
check('and persisted, so the retry can find it', channelById(firstId)?.status, 'failed');

// The retry. The dangerous case is not "the call failed" but "the call
// succeeded and the answer was lost" — so the SAME id has to go out again, or
// a second real group appears in front of the client.
createReply = {
  status: 200,
  body: {
    data: {
      chat_id: '120363000@g.us',
      subject: 'CYBills - Acme Pte Ltd',
      submission_id: firstId,
      // WhatsApp silently refused the second number: its owner's privacy
      // settings disallow being added. Not an error — but not silent either.
      participants_added: ['60123456789'],
      participants_requested: ['60123456789', '6591234567'],
      already_existed: false,
    },
  },
};
r = await post('channels', { participants: ['60123456789', '(65) 9123-4567'] }, { 'X-Org-Id': 'org_one0001' });
check('the retry succeeds', r.status, 200);
check('reusing the id, so no second group is made', createCalls[1].submission_id, firstId);
check('the chat id comes back to be stored', r.body.channel.chatId, '120363000@g.us');
check('the number WhatsApp would not add is surfaced', r.body.channel.participantsMissing, ['6591234567']);
check('and counted', r.body.channel.addedShortfall, 1);
check('only one channel exists for the entity', createCalls.length, 2);

const submissionId = firstId;

// --- Adopting a group that already existed ------------------------------------
// CYWS answers a repeat with `already_existed` and EMPTY participant arrays —
// "this already exists", not "nobody is in it". Reading those as refusals would
// have a resumed channel announce that WhatsApp had turned everybody away.
createReply = {
  status: 200,
  body: {
    data: {
      chat_id: '120363111@g.us',
      subject: 'CYBills - Second Group',
      submission_id: 'CYB-org_one0001-adopted',
      participants_added: [],
      participants_requested: [],
      already_existed: true,
    },
  },
};
r = await post('channels', { participants: ['6588887777'], subject: 'CYBills - Second Group' }, { 'X-Org-Id': 'org_one0001' });
check('an adopted group opens', r.body.channel.status, 'open');
check('and claims nobody was refused', r.body.channel.participantsMissing, []);
check('because it never said who is in it', r.body.channel.participantsKnown, false);

// --- What WhatsApp actually answers with --------------------------------------
// It does not hand back phone numbers. `participants_added` comes back as LIDs
// — opaque per-user ids — so against the numbers we asked with, every person
// who WAS added looks like a stranger. That is how somebody sitting in the
// group on her own phone got reported as having refused to join it.
createReply = {
  status: 200,
  body: {
    data: {
      chat_id: '120363999@g.us',
      subject: 'CYBills - Lids',
      submission_id: 'x',
      participants_added: ['217630539546875', '176940472352839'],
      participants_requested: ['6582534031'],
      already_existed: false,
    },
  },
};
r = await post('channels', { participants: ['6582534031'], subject: 'CYBills - Lids' }, { 'X-Org-Id': 'org_one0001' });
check('an id that is not a phone number accuses nobody', r.body.channel.participantsMissing, []);
check('nor counts anyone short — two ids for one person asked for', r.body.channel.addedShortfall, 0);
// And the LIDs themselves never reach the page: two 15-digit numbers under
// "In the group" tell the reader nothing about whose they are.
check('the opaque ids are reported only as a count', r.body.channel.participantsAddedCount, 2);
check('what is shown is what we asked with', r.body.channel.participantsRequested, ['6582534031']);

// --- Connecting one person ---------------------------------------------------
// The ordinary case: a group is a conversation with SOMEBODY, opened from their
// own page. The number goes with the request and is saved as part of connecting
// — an unstored number means the bills that arrive can't be matched back to
// them, which is the one thing the button exists to prevent.
createReply = {
  status: 200,
  body: {
    data: {
      chat_id: '120363222@g.us',
      subject: 'astrid4@cybills.sg',
      submission_id: 'x',
      participants_added: ['6591112222'],
      participants_requested: ['6591112222'],
      already_existed: false,
    },
  },
};
r = await post('channels/user', { userId: dean.id, mobile: '+65 9111 2222' });
check('connecting a person opens a group', r.status, 200);
// The same pipe under a second name: send a bill to that address or into this
// group and it is filed under exactly the same person.
check('named for their own CYBills address', r.body.channel.subject, 'astrid4@cybills.sg');
check('and tied to them', r.body.channel.userId, dean.id);
check('the number is stored as typed', ensure('cybm').find((u) => u.id === dean.id)?.mobile, '+65 9111 2222');

r = await post('channels/user', { userId: 'nobody', mobile: '6591112222' });
check('a person CYBills has no row for is refused', r.status, 404);

r = await post('channels/user', { userId: dean.id, mobile: '0123456789' });
check('and so is a number in national format', r.status, 400);
check('leaving the stored one alone', ensure('cybm').find((u) => u.id === dean.id)?.mobile, '+65 9111 2222');

// A person's half-made group must not adopt the ENTITY's pending submission id:
// they are different conversations, and the entity's was pointed elsewhere.
const personChannel = await (await fetch(`http://127.0.0.1:4623/api/whatsapp/channels?userId=${dean.id}`)).json();
check('the person has their own submission id', personChannel.channels[0].submissionId !== submissionId, true);

// Put the roster number back — the rest of this file matches a document's
// sender against it.
{
  const items = ensure('cybm');
  const row = items.find((u) => u.id === dean.id)!;
  row.mobile = '+60 12-345 6789';
  save(items);
}

// --- Receiving a bill --------------------------------------------------------
const invoice = {
  submission_id: submissionId,
  chat_id: '120363000@g.us',
  chat_subject: 'CYBills - Acme Pte Ltd',
  message_id: 'clx8f2aaa',
  wa_message_id: 'false_120363000@g.us_AAA',
  r2_key: 'whatsapp/ab12cd34.pdf',
  file_url: 'https://cyworkspace.cy-bm.sg/api/invoice-file?k=abc&ct=pdf&s=sig',
  file_name: 'bridgers annual return.pdf',
  content_type: 'application/pdf',
  body: 'recharge this to CY-Biz',
  sender_name: 'Dean',
  sender: '60123456789@c.us',
  sent_at: '2026-08-27T08:56:00.000Z',
};

r = await post('invoice', invoice, { 'X-API-Key': 'wrong' });
check('a wrong API key is refused', r.status, 401);

r = await post('invoice', { ...invoice, submission_id: 'SUB-nobody' }, { 'X-API-Key': 'inbound-key' });
// The submission id is what names the book. A bill for one CYBills has never
// heard of is refused rather than filed into a guess at which client it is.
check('an unknown submission is refused', r.status, 404);

r = await post('invoice', invoice, { 'X-API-Key': 'inbound-key' });
check('a supplier bill is accepted', r.status, 200);
check('the file was fetched once', fileFetches, 1);

const bills = listBills('cybm').filter((b) => b.whatsapp);
check('one document was filed', bills.length, 1);
const filed = bills[0]!;
check('under the entity CYBills was told', r.body.org_id, 'org_one0001');
check('it lands in the inbox, unread', filed.status, 'new');
// What the sender typed is the instruction. Keeping it on the document is what
// lets a RE-READ see it too — read once with "recharge this to CY-Biz" and
// again without, and the second read quietly undoes the first.
check('the covering note is kept', filed.whatsapp?.text, 'recharge this to CY-Biz');
check('with who sent it and when', [filed.whatsapp?.senderName, filed.whatsapp?.sentAt], ['Dean', '2026-08-27T08:56:00.000Z']);
check('and the group it came from', filed.whatsapp?.chatSubject, 'CYBills - Acme Pte Ltd');
// The sender's number is on the roster, so the document is theirs — spelled
// however they wrote it there ('+60 12-345 6789' is the same number).
check('the sender is matched to their roster row', filed.owner, 'astridy2004@gmail.com');
check('and is the uploader too', filed.createdBy, 'astridy2004@gmail.com');

// --- Sent twice --------------------------------------------------------------
// CYWS does not retry on its own; a repeat is an operator re-tagging the
// message. Either way the answer is the document that already exists, and a
// 2xx — a non-2xx would leave it undelivered and invite a third send.
r = await post('invoice', invoice, { 'X-API-Key': 'inbound-key' });
check('a re-send is accepted', r.status, 200);
check('and says which document it already is', r.body.bill_id, filed.id);
check('no second document was filed', listBills('cybm').filter((b) => b.whatsapp).length, 1);
check('and the file was not fetched again', fileFetches, 1);

// A different message from the same group is a different document.
r = await post('invoice', { ...invoice, message_id: 'clx8f2bbb', body: '' }, { 'X-API-Key': 'inbound-key' });
check('a new message is filed', listBills('cybm').filter((b) => b.whatsapp).length, 2);

const channel = channelById(submissionId)!;
check('the channel counts what it has received', channel.received, 2);

// --- The file link -----------------------------------------------------------
// Whoever holds the inbound key could otherwise hand the server any URL at all
// and use it to fetch addresses only it can reach.
r = await post(
  'invoice',
  { ...invoice, message_id: 'clx8f2ccc', file_url: 'http://169.254.169.254/latest/meta-data/' },
  { 'X-API-Key': 'inbound-key' }
);
check('a file link that is not CYWS is not followed', r.status, 502);
check('and nothing was fetched', fileFetches, 2);

server.close();
globalThis.fetch = realFetch;
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
