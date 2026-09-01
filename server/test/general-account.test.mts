// The practice's own General account — the row that owns the paperwork nobody
// claimed here — and the group it collects through.
//
// Every entity has one, and every CLIENT's is managed on its Users page. The
// practice's own could be managed nowhere at all: a colleague opening the
// practice entity is redirected off Users to Colleagues, so the row sat in the
// data with nothing in the UI reaching it. It is on the colleagues payload now,
// on its own key rather than in the list — it is not a colleague — and what this
// pins down is the three facts that follow from a group being opened for it.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-general-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'relay-key';
process.env.CYWORKSPACE_RELAY_URL = 'https://cyworkspace.cy-bm.sg';
process.env.WHATSAPP_INBOUND_KEY = 'inbound-key';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      {
        id: 'org_cybm001',
        orgId: 'cybm',
        name: 'CY Business Management',
        tenantId: 't-cybm',
        tenantName: 'CYBM',
        createdAt: new Date(0).toISOString(),
        createdBy: '',
      },
    ],
  })
);

// --- CYWS, stubbed -----------------------------------------------------------
const renames: Array<{ submission_id: string; subject: string }> = [];
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
  if (url.includes('/api/webhooks/cybills/rename-group')) {
    renames.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('/api/webhooks/cybills/react')) {
    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('/api/invoice-file')) {
    return new Response(Buffer.from('%PDF-1.4 a bill'), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf' },
    });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

const express = (await import('express')).default;
const { whatsappRouter, channelById } = await import('../src/whatsapp.ts');
const { organisationsRouter } = await import('../src/organisations.ts');
const { practiceRouter } = await import('../src/practice.ts');
const { listBills } = await import('../src/store.ts');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/organisations', organisationsRouter);
app.use('/api/practice', practiceRouter);
const server = app.listen(4641, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`http://127.0.0.1:4641${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as any };
};

// The rename is never awaited by the request that triggers it — a page is
// waiting on ours, not on WhatsApp — so give the loop a turn.
const settle = () => new Promise((r) => setTimeout(r, 20));

// --- On the roster, beside the team it is not part of ------------------------
let r = await call('GET', '/api/practice/colleagues');
check('the practice roster carries its general account', r.body.general?.name, 'General');
check('…which is not one of the colleagues', r.body.colleagues.some((c: { general: boolean }) => c.general), false);
// Its stored address is an internal identity nothing is ever sent to, so the
// roster reports it as having no email — and what it DOES answer to is the
// entity's short form standing alone, which does not exist until one is set.
check('it has no mailbox of its own', r.body.general?.email, '');
check('and no address until the entity has a short form', r.body.general?.address, '');
const generalId = r.body.general.id as string;

// --- A group of its own -------------------------------------------------------
r = await call('POST', '/api/whatsapp/channels/user', { userId: generalId, mobile: '6591234567' }, { 'X-Org-Id': 'org_cybm001' });
check('a group can be opened for it', r.status, 200);
const group = r.body.channel.submissionId as string;
// Named after the ENTITY, never after the row. Every entity's general account is
// called "General", so "CYBills - General" would name the row rather than whose
// books it feeds — and two of them would be indistinguishable in a chat list.
check('and is named after the entity, not the row', channelById(group)?.subject, 'CYBills - CY Business Management');

// --- The entity takes a short form -------------------------------------------
// That short form standing alone IS the general account's address, so the group
// follows it the same way a person's does.
r = await call('PUT', '/api/organisations/org_cybm001/email-suffix', { suffix: 'cybm' });
check('the short form is saved', [r.status, r.body.organisation.emailSuffix], [200, 'cybm']);
await settle();
check('the general account now has the entity’s own address', (await call('GET', '/api/practice/colleagues')).body.general.address, 'cybm@cybills.sg');
check('and CYWS was asked to rename its group to match', renames.at(-1), { submission_id: group, subject: 'cybm@cybills.sg' });
check('the row says what the group is now called', channelById(group)?.subject, 'cybm@cybills.sg');

// --- What arrives there belongs to the entity --------------------------------
// The group names the general account, so a bill sent into it is filed under it
// whoever sent it — which is the whole point of a group for the entity's own
// paperwork rather than for one person's.
r = await call(
  'POST',
  '/api/whatsapp/invoice',
  {
    submission_id: group,
    chat_id: channelById(group)?.chatId,
    chat_subject: 'cybm@cybills.sg',
    message_id: 'msg-general-1',
    wa_message_id: 'false_120363000001@g.us_AAA',
    r2_key: 'whatsapp/general.pdf',
    file_url: 'https://cyworkspace.cy-bm.sg/api/invoice-file?k=abc&ct=pdf&s=sig',
    file_name: 'utilities.pdf',
    content_type: 'application/pdf',
    sender_name: 'Somebody',
    sender: '6598765432@c.us', // on nobody's roster
    sent_at: '2026-08-27T08:56:00.000Z',
  },
  { 'X-API-Key': 'inbound-key' }
);
check('a bill sent into it is accepted', r.status, 200);
const filed = listBills('cybm').filter((b) => b.whatsapp).at(-1)!;
check('and is owned by the general account', filed.owner, 'org_cybm001.general@cybills.local');

server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
