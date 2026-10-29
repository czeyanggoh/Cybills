// A person who works in two entities has an address in each.
//
// Nas Aritao runs Lalco Holdings and Lalco Trading. Her row is filed under
// Trading, Holdings is access on top of it (extraAccess), and her one address
// took Trading's short form — so Holdings' Extract by Email card promised her
// `<handle>.lalcoholdings` while she was `nas@cybills.sg`, and everything she
// emailed in landed in Trading's book whichever company the bill was for. Each
// entity's short form now gives her an address of her own there, and mail to it
// files into THAT entity's book.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-entity-addr-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.INBOUND_SECRET = 'test-inbound-secret';

const org = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  orgId: 'cybm',
  name,
  tenantId: `t-${id}`,
  tenantName: name,
  createdAt: new Date(0).toISOString(),
  createdBy: '',
  ...extra,
});

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      org('org_cybm001', 'CY Business Management'),
      org('org_hold0001', 'Lalco Holdings Pte Ltd', { emailSuffix: 'lalcoholdings' }),
      org('org_trad0001', 'Lalco Trading Pte Ltd'),
    ],
  })
);

const express = (await import('express')).default;
const { inboundRouter } = await import('../src/inbound.ts');
const { dataScopeForOrg } = await import('../src/organisations.ts');
const { listBills } = await import('../src/store.ts');
const { ensure, save, full, userByEmailHandle, recipientByEmailHandle, addressForUser, addressInOrg, addressClash } =
  await import('../src/users.ts');

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const items = ensure('cybm');
const add = (fields: Record<string, unknown>) => {
  const u = full({ login: 'Yes', ...fields }, 'cybm');
  items.push(u);
  return u;
};
const nas = add({
  name: 'Nas Aritao',
  email: 'nas.aritao@lalco.la',
  organisationId: 'org_trad0001',
  emailHandle: 'nas',
  role: 'Business Admin',
  extraAccess: [{ orgId: 'org_hold0001', role: 'Business Admin' }],
});
// Holdings' own Amy, and a Trading Amy who also works in Holdings: the same
// handle under one short form is two people, and the one whose entity it is
// keeps it.
const amyHere = add({ name: 'Amy Holdings', email: 'amy@lalcoholdings.sg', organisationId: 'org_hold0001', emailHandle: 'amy' });
const amyVisiting = add({
  name: 'Amy Trading',
  email: 'amy@lalco.la',
  organisationId: 'org_trad0001',
  emailHandle: 'amy',
  extraAccess: [{ orgId: 'org_hold0001', role: 'Standard' }],
});
const ben = add({ name: 'Ben Holdings', email: 'ben@lalcoholdings.sg', organisationId: 'org_hold0001', emailHandle: 'ben' });
save(items);

// --- The addresses -----------------------------------------------------------
check('her home address is still the bare handle', addressForUser(nas), 'nas@cybills.sg');
check('…and that is what Trading prints for her', addressInOrg(nas, 'org_trad0001'), 'nas@cybills.sg');
check('Holdings prints its own short form for her', addressInOrg(nas, 'org_hold0001'), 'nas.lalcoholdings@cybills.sg');

// --- Where mail to each one goes ---------------------------------------------
check('mail to the Holdings address reaches her', userByEmailHandle('nas.lalcoholdings')?.id, nas.id);
check('…and names Holdings as the book', recipientByEmailHandle('nas.lalcoholdings')?.orgId, 'org_hold0001');
check('…a +tag changes nothing', recipientByEmailHandle('nas.lalcoholdings+xero')?.orgId, 'org_hold0001');
check('mail to her home address still goes to Trading', recipientByEmailHandle('nas')?.orgId, 'org_trad0001');

// --- A home address wins -----------------------------------------------------
check("Holdings' own Amy keeps amy.lalcoholdings", recipientByEmailHandle('amy.lalcoholdings')?.user.id, amyHere.id);
check('…so the visiting Amy is shown her home address there', addressInOrg(amyVisiting, 'org_hold0001'), 'amy@cybills.sg');

// --- Nobody new may take a visitor's address ---------------------------------
check("a Holdings handle that is Nas's Holdings address is refused", addressClash(ben, 'nas'), 'Nas Aritao');
check('…while another name is free', addressClash(ben, 'benny'), '');

// --- A practice colleague holds no such addresses ----------------------------
const colleague = add({
  name: 'Cze Yang',
  email: 'czeyang@cy-bm.sg',
  organisationId: 'org_cybm001',
  emailHandle: 'czeyang',
  practice: true,
  extraAccess: [{ orgId: 'org_hold0001', role: 'Business Admin' }],
});
save(items);
check('a colleague is not given every client’s address', recipientByEmailHandle('czeyang.lalcoholdings'), null);
check('…and is shown their own', addressInOrg(colleague, 'org_hold0001'), 'czeyang@cybills.sg');

// --- Over the wire: the document lands in Holdings' book ---------------------
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/inbound', inboundRouter);
const server = app.listen(4631, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const post = async (to: string, filename: string) => {
  const res = await fetch('http://127.0.0.1:4631/api/inbound/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inbound-Secret': 'test-inbound-secret' },
    body: JSON.stringify({
      to,
      from: 'nas.aritao@lalco.la',
      subject: 'bill',
      text: '',
      attachments: [{ filename, contentType: 'application/pdf', contentBase64: Buffer.from(`%PDF-1.4 ${filename}`).toString('base64') }],
    }),
  });
  return { status: res.status, body: await res.json() };
};

let r = await post('nas.lalcoholdings@cybills.sg', 'holdings-bill.pdf');
check('a bill emailed to her Holdings address is filed', [r.status, r.body.created], [200, 1]);
const inHoldings = listBills(dataScopeForOrg('org_hold0001')).filter((b) => b.fileName === 'holdings-bill.pdf');
const inTrading = listBills(dataScopeForOrg('org_trad0001')).filter((b) => b.fileName === 'holdings-bill.pdf');
check("…into Holdings' book", inHoldings.length, 1);
check("…and not Trading's", inTrading.length, 0);
check('…owned by her', inHoldings[0]?.owner, 'nas.aritao@lalco.la');

r = await post('nas@cybills.sg', 'trading-bill.pdf');
check('a bill emailed to her home address is filed', [r.status, r.body.created], [200, 1]);
check("…into Trading's book, as before",
  listBills(dataScopeForOrg('org_trad0001')).filter((b) => b.fileName === 'trading-bill.pdf').length, 1);

console.log(failures ? `\n${failures} failing` : '\nAll passing');
await finish(failures, server);
