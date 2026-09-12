// Gmail's forwarding confirmation, and the link the panel offers to click.
//
// Nobody has a mailbox at cybills.sg — that is the whole point of the catch-all
// — so when a client points a Gmail forward here, Google's confirmation has
// nowhere to be read. CYBills catches it and holds the link on the person's own
// page, which is what makes the forward completable without a mailbox.
//
// The link was matched with a pattern naming ONE host,
// `mail-settings.google.com`. Google sends the same verification from others,
// and a confirmation arriving from one of those stored its code and no link at
// all: a panel saying "open the link" with no link in it. The code alone still
// works — Gmail has a Verify box — but nothing on the page says so, so it reads
// as broken.
//
// Driven over real HTTP, the way the Worker calls it, so what is asserted is
// what the endpoint actually stores.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-forward-confirm-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.INBOUND_SECRET = 'test-inbound-secret';
process.env.N8N_FETCH_URL = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-1', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const { inboundRouter } = await import('../src/inbound.ts');
const { ensure, save } = await import('../src/users.ts');

const users = ensure('cybm');
const me = users.find((u) => u.email === 'astridy2004@gmail.com')!;
me.emailHandle = 'astrid4';
me.organisationId = 'org_one0001';
save(users);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/inbound', inboundRouter);
const server = app.listen(4653, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const post = async (over: Record<string, unknown>) => {
  const res = await fetch('http://127.0.0.1:4653/api/inbound/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inbound-Secret': 'test-inbound-secret' },
    body: JSON.stringify({ to: 'astrid4@cybills.sg', from: 'forwarding-noreply@google.com', subject: '(#184973) Gmail Forwarding Confirmation', text: '', html: '', ...over }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

// What the panel is holding afterwards. Read off the row, because that is where
// the page reads it from.
const held = () => {
  const u = ensure('cybm').find((x) => x.id === me.id)!;
  return u.pendingForward ?? null;
};
const clear = () => {
  const rows = ensure('cybm');
  rows.find((x) => x.id === me.id)!.pendingForward = null;
  save(rows);
};

// --- The classic link, which always worked -----------------------------------
let r = await post({
  text: 'Confirm request to forward mail to astrid4@cybills.sg\nhttps://mail-settings.google.com/mail/vf-%5BANGjdJ8abc%5D-nQ\nCode: 184973',
});
check('a confirmation is held rather than filed', r.body.kind, 'forwarding_confirmation');
check('…with its link', held()?.url, 'https://mail-settings.google.com/mail/vf-%5BANGjdJ8abc%5D-nQ');
check('…and its code', held()?.code, '184973');
clear();

// --- The regression: the same verification, another Google host ---------------
// This is what left a panel saying "open the link" with no link in it.
r = await post({
  text: 'Confirm request to forward mail\nhttps://mail.google.com/mail/u/0/vf-%5BANGjdJ9xyz%5D-kP\nCode: 184973',
});
check('another Google host is a link too', held()?.url, 'https://mail.google.com/mail/u/0/vf-%5BANGjdJ9xyz%5D-kP');
check('…and the code is still there', held()?.code, '184973');
clear();

// --- An HTML-only confirmation ------------------------------------------------
// The half that would have been wrong even where the old pattern matched: a
// confirmation URL is all query parameters, and scraped raw out of the HTML its
// ampersands are still `&amp;`, so the link fails when clicked.
r = await post({
  text: '',
  html: '<p>Confirm the request</p><a href="https://mail-settings.google.com/mail/vf-%5BANGjdJ7%5D&amp;ik=9a&amp;view=cv">Confirm</a><p>184973</p>',
});
check('an href is decoded, not stored as written', held()?.url, 'https://mail-settings.google.com/mail/vf-%5BANGjdJ7%5D&ik=9a&view=cv');
clear();

// --- A confirmation carrying nothing but footer links -------------------------
// Every Google mail ends with help and policy links. Offering one of those as
// the confirmation button would be worse than offering none: it goes somewhere
// real, and somewhere useless.
r = await post({
  text: 'Confirm request to forward mail. Code: 184973\nhttps://support.google.com/mail/answer/10957\nhttps://policies.google.com/terms',
});
check('a footer link is not the confirmation', held()?.url, '');
check('…and the code is held on its own', held()?.code, '184973');
clear();

// --- And a mail that is not a confirmation is left alone ----------------------
// The loose host match is reached ONLY once the sender has said this is a
// confirmation. A stranger's mail carrying a Google link is judged as strictly
// as it ever was, or an invoice with a Maps link in the signature would stop
// being filed as a bill.
r = await post({
  from: 'accounts@supplier.com',
  subject: 'Invoice 7822201',
  text: 'Our office is at https://mail.google.com/mail/u/0/ and the invoice is attached. Ref 7822201',
});
check('a stranger with a Google link is not a confirmation', r.body.kind === 'forwarding_confirmation', false);
check('…and nothing is held for them', held(), null);

await finish(failures, server);
