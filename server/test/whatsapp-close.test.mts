// Closing a collection group down.
//
// Two acts behind one route, and the difference between them happens in front
// of a client: stopping collecting leaves the group standing with everyone in
// it, deleting has CYBot remove everyone and walk out. So what is pinned here
// is that the caller's choice is what reaches CYWS, that a refusal at the far
// end leaves the collection OPEN rather than reporting a group gone that is
// still sitting in somebody's WhatsApp, and that a closed collection actually
// stops accepting documents — enforced here, not trusted to stop at CYWS.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-wa-close-'));
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

// --- CYWS, stubbed -----------------------------------------------------------
type CloseCall = { submission_id: string; keep_group: boolean };
const closeCalls: CloseCall[] = [];
let closeReply: { status: number; body: unknown } = { status: 200, body: { data: { removed: 2, left: true } } };

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
  if (url.includes('/api/webhooks/cybills/delete-group')) {
    closeCalls.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify(closeReply.body), {
      status: closeReply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

const express = (await import('express')).default;
const { whatsappRouter, channelById } = await import('../src/whatsapp.ts');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/whatsapp', whatsappRouter);
const server = app.listen(4627, '127.0.0.1');
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
  const res = await fetch(`http://127.0.0.1:4627/api/whatsapp/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const openGroup = async () => {
  const r = await post('channels', { mobile: '60123456789' }, ORG);
  return r.body.channel.submissionId as string;
};

// --- Stop collecting: the group is left standing -----------------------------
let id = await openGroup();
let r = await post(`channels/${id}/close`, {}, ORG);
check('stopping collecting succeeds', r.status, 200);
check('and CYWS is told to KEEP the group', closeCalls.at(-1)?.keep_group, true);
check('the collection is marked disconnected', channelById(id)?.status, 'disconnected');
check('which is not the same as deleted', r.body.deleted, false);

// A document sent into it afterwards. Refused HERE — the decision is CYBills',
// and it has to hold even if the call telling CYWS to stop never landed.
r = await post('invoice', { submission_id: id, message_id: 'M-after', r2_key: 'whatsapp/x.pdf' }, KEY);
check('a bill sent after closing is refused', [r.status, r.body.error], [409, 'channel_closed']);
r = await post('message', { submission_id: id, wa_message_id: 'WA-after', body: 'hello?' }, KEY);
check('and so is a message', [r.status, r.body.error], [409, 'channel_closed']);

// Pressing it again. Somebody doing that wants it closed, and it is.
r = await post(`channels/${id}/close`, {}, ORG);
check('closing an already-closed collection is not an error', [r.status, r.body.already], [200, true]);
check('and nothing more is asked of CYWS', closeCalls.filter((c) => c.submission_id === id).length, 1);

// --- Delete: CYBot empties the group and leaves ------------------------------
id = await openGroup();
r = await post(`channels/${id}/close`, { deleteGroup: true }, ORG);
check('deleting succeeds', r.status, 200);
check('and CYWS is told NOT to keep the group', closeCalls.at(-1)?.keep_group, false);
check('how many were removed is reported', r.body.removed, 2);
check('the collection is marked deleted', channelById(id)?.status, 'deleted');

// --- When CYWS will not take it apart ----------------------------------------
// The failure that matters: a group somebody believes is gone, still sitting in
// front of a client. Nothing may be marked closed on the strength of it.
id = await openGroup();
closeReply = { status: 502, body: { error: 'remove_failed', message: 'Could not remove everyone, so the group was left alone rather than half-dismantled.' } };
r = await post(`channels/${id}/close`, { deleteGroup: true }, ORG);
check('a refusal is passed through, not swallowed', [r.status, r.body.error], [502, 'remove_failed']);
check("and CYWS's own words with it", String(r.body.message).startsWith('Could not remove everyone'), true);
check('the collection stays OPEN', channelById(id)?.status, 'open');

// Which means it is still collecting — the honest state, since it is.
r = await post('invoice', { submission_id: id, message_id: 'M-still', r2_key: 'whatsapp/y.pdf' }, KEY);
check('so a bill sent into it is not refused for being closed', r.body.error === 'channel_closed', false);

// And the retry works, leaving no trace of the failure.
closeReply = { status: 200, body: { data: { removed: 1, left: true } } };
r = await post(`channels/${id}/close`, { deleteGroup: true }, ORG);
check('the retry closes it', [r.status, channelById(id)?.status], [200, 'deleted']);
check('and the earlier error is cleared', channelById(id)?.lastError, '');

// --- A group that was never opened -------------------------------------------
// The id was minted, the call failed, and there is nothing at the far end to
// take apart. Asking CYWS about a group it never heard of would 404 and read as
// a failure, so it is forgotten locally and nothing is asked.
const before = closeCalls.length;
r = await post(`channels/${id}/close`, {}, ORG); // already deleted, cheap re-check
check('nothing is asked of CYWS for a closed one', closeCalls.length, before);

r = await post('channels/CYB-nope-0000/close', {}, ORG);
check('an id nobody holds is a 404', r.status, 404);

server.close();
globalThis.fetch = realFetch;
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
