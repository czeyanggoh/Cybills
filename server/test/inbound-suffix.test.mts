// An entity's short form in its people's addresses: martin.redalpha@cybills.sg.
//
// One mail domain serves every client, so a handle is unique across the whole
// deployment rather than within an entity — the first Martin took `martin` and
// the next was handed `martin2`, which is an address nobody can be told over
// the phone without explaining it. A short form gives each entity its namespace
// back. What must not happen is two people answering to one address: every bill
// forwarded to it would file under whichever row was found first.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-suffix-'));
process.env.BILLS_DATA_DIR = DATA_DIR;

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
      org('org_red00001', 'Red Alpha'),
      org('org_ste00001', 'ST Engineering'),
    ],
  })
);

const express = (await import('express')).default;
const { organisationsRouter } = await import('../src/organisations.ts');
const users = await import('../src/users.ts');
const { ensure, save, full, userByEmailHandle, generalUserByEmailSuffix, addressForUser, addressClash, normaliseSuffix } =
  users;

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// Two Martins, in two entities. Only one of them could ever have been `martin`.
const items = ensure('cybm');
const add = (name: string, email: string, orgId: string, handle: string) => {
  const u = full({ name, email, organisationId: orgId, emailHandle: handle, login: 'Yes' }, 'cybm');
  items.push(u);
  return u;
};
const martinRed = add('Martin Lim', 'martin@redalpha.sg', 'org_red00001', 'martin');
const martinSte = add('Martin Tan', 'martin@stengg.com', 'org_ste00001', 'martin2');
const cyMartin = add('Martine Goh', 'martine@cy-bm.sg', 'org_cybm001', 'martine');
save(items);

const app = express();
app.use(express.json());
app.use('/api/organisations', organisationsRouter);
const server = app.listen(4627, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const setSuffix = async (id: string, suffix: string) => {
  const res = await fetch(`http://127.0.0.1:4627/api/organisations/${id}/email-suffix`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ suffix }),
  });
  return { status: res.status, body: await res.json() };
};

// --- What a short form is ----------------------------------------------------
check('a short form is lowercased', normaliseSuffix('RedAlpha'), 'redalpha');
// The dot separates the person from the entity, so one inside the short form
// would leave the address reading as three parts with nothing to say where the
// split was meant to be.
check('and carries no dots', normaliseSuffix('red.alpha'), 'redalpha');
check('nothing usable is nothing', normaliseSuffix('...'), '');

// --- Before anybody sets one -------------------------------------------------
check('an address is the bare handle', addressForUser(martinRed), 'martin@cybills.sg');
check('…and that is who mail to it reaches', userByEmailHandle('martin')?.id, martinRed.id);

// --- Setting one -------------------------------------------------------------
let r = await setSuffix('org_red00001', 'RedAlpha');
check('a short form saves', [r.status, r.body.organisation.emailSuffix], [200, 'redalpha']);
check('…and says how many addresses it moved', r.body.addresses, 1);
check('the address now names the entity', addressForUser(martinRed), 'martin.redalpha@cybills.sg');
check('…and mail to it arrives', userByEmailHandle('martin.redalpha')?.id, martinRed.id);
// Setting a suffix ADDS an address rather than swapping one, so the forwarding
// rule somebody set up last month keeps working.
check('the address they already gave out still arrives', userByEmailHandle('martin')?.id, martinRed.id);
check('…including with a +tag on it', userByEmailHandle('martin.redalpha+xero')?.id, martinRed.id);

// --- The second entity gets its own namespace --------------------------------
r = await setSuffix('org_ste00001', 'stengg');
check('a second entity may set its own', r.status, 200);
// This is the whole point: `martin` was spent, and now it is not.
check('a name spent in another entity is free again', addressClash(martinSte, 'martin'), '');
martinSte.emailHandle = 'martin';
save(ensure('cybm').map((u) => (u.id === martinSte.id ? { ...u, emailHandle: 'martin' } : u)));
check('two Martins, two addresses', addressForUser(martinSte), 'martin.stengg@cybills.sg');
check('…each reachable at their own', userByEmailHandle('martin.stengg')?.id, martinSte.id);
check('…and the other one unaffected', userByEmailHandle('martin.redalpha')?.id, martinRed.id);
// Neither of them IS `martin` any more, and the bare address cannot say which
// was meant — so it reaches nobody and the delivery is reported as unknown,
// which is the only honest answer.
check('the bare address no longer names one of them', userByEmailHandle('martin'), null);

// --- One short form per client ----------------------------------------------
r = await setSuffix('org_cybm001', 'stengg');
check('a short form another entity holds is refused', [r.status, r.body.error], [409, 'suffix_taken']);
check('…naming who holds it', r.body.takenBy, 'ST Engineering');

// --- A short form that would collide with a live address ---------------------
{
  const roster = ensure('cybm');
  const twin = full(
    { name: 'Martine Twin', email: 'twin@cy-bm.sg', organisationId: 'org_cybm001', emailHandle: 'martin.acme', login: 'Yes' },
    'cybm'
  );
  roster.push(twin);
  save(roster);
  // "acme" reads as free — no entity holds it — but it would hand Red Alpha's
  // Martin an address somebody else already answers to. Found now rather than
  // later as misfiled paperwork.
  r = await setSuffix('org_red00001', 'acme');
  check('a short form that would collide with a live address is refused', [r.status, r.body.error], [409, 'address_taken']);
  check('…naming the address', r.body.address, 'martin.acme@cybills.sg');
  check('…and who already has it', r.body.takenBy, 'Martine Twin');
  check('the entity keeps the short form it had', addressForUser(martinRed), 'martin.redalpha@cybills.sg');
}

// --- Clearing it -------------------------------------------------------------
r = await setSuffix('org_red00001', '');
check('a short form clears', [r.status, r.body.organisation.emailSuffix], [200, '']);
check('…putting the address back', addressForUser(martinRed), 'martin@cybills.sg');
check('…and the bare address names him again', userByEmailHandle('martin')?.id, martinRed.id);

// Typed something that leaves nothing usable: storing '' would read as "no
// short form", which is the opposite of what was asked for.
r = await setSuffix('org_red00001', '...');
check('an unusable short form is refused rather than read as none', [r.status, r.body.error], [400, 'invalid_suffix']);

// --- A new person in a suffixed entity keeps their own name ------------------
r = await setSuffix('org_red00001', 'redalpha');
check('the short form goes back on', r.status, 200);
{
  const roster = ensure('cybm');
  roster.push(
    full({ firstName: 'Martine', name: 'Martine Ng', email: 'martine@redalpha.sg', organisationId: 'org_red00001', login: 'Yes' }, 'cybm')
  );
  save(roster);
  const assigned = ensure('cybm').find((u) => u.email === 'martine@redalpha.sg');
  // `martine` is spent in CY Business Management, but `martine.redalpha` is
  // nobody's address — so uniqueness is measured on the ADDRESS, and she keeps
  // her own name instead of being handed "martine2".
  check('a handle is only numbered when the ADDRESS is taken', assigned?.emailHandle, 'martine');
  check('…and hers is her name and her entity', addressForUser(assigned!), 'martine.redalpha@cybills.sg');
  check('…while the Martine who had the bare one keeps it', userByEmailHandle('martine')?.id, cyMartin.id);
}

// --- The entity's own address ------------------------------------------------
// The short form standing where a handle would be is the COMPANY's address, not
// anybody's: what to put on a supplier's file, or to point a shared mailbox at,
// where naming an employee would be wrong the day they leave. It resolves to the
// general account — the row that already owns what nobody claimed.
{
  const general = generalUserByEmailSuffix('cybm', 'redalpha');
  check("an entity's short form on its own reaches its general account", general?.organisationId, 'org_red00001');
  check('…which is the general row, not a person', general?.general, true);
  check('…and a +tag on it changes nothing', generalUserByEmailSuffix('cybm', 'redalpha+xero')?.id, general?.id);
  // Only a local part that IS a short form. A person's address carries the dot
  // that separates the two halves, so it can never be read as one.
  check("a person's address is not an entity address", generalUserByEmailSuffix('cybm', 'martin.redalpha'), null);
  check('a short form nobody holds reaches nobody', generalUserByEmailSuffix('cybm', 'acme'), null);
  check("…and each entity that has one gets its own", generalUserByEmailSuffix('cybm', 'stengg')?.organisationId, 'org_ste00001');
  // CY Business Management never set one, so it has no address of its own —
  // inventing one from its name would print an address that reaches nobody.
  check('an entity with no short form has no address', generalUserByEmailSuffix('cybm', 'cybm'), null);
}

// --- A person may not take the entity's address ------------------------------
// Mail resolves a PERSON first, so a handle equal to a live short form would not
// clash loudly — Red Alpha's own address would just stop arriving, with nothing
// on either page to say why.
{
  // Martine Goh is in CY Business Management, which has set no short form, so
  // `redalpha` would be her whole address.
  check("a handle that is another entity's short form is refused", addressClash(cyMartin, 'redalpha'), 'Red Alpha');
  // In an entity that HAS one her address would be `redalpha.redalpha`, which is
  // nobody else's — the two only ever collide where there is no short form.
  check('…while inside a suffixed entity it is free', addressClash(martinRed, 'redalpha'), '');
  const roster = ensure('cybm');
  roster.push(full({ firstName: 'Redalpha', name: 'Redalpha Ong', email: 'ro@cy-bm.sg', organisationId: 'org_cybm001', login: 'Yes' }, 'cybm'));
  save(roster);
  const assigned = ensure('cybm').find((u) => u.email === 'ro@cy-bm.sg');
  // Nobody chooses an auto-assigned handle — it is made from a name — so the
  // same rule has to hold on the road where no one is asked.
  check('an auto-assigned handle steps over it too', assigned?.emailHandle, 'redalpha2');
  check('…leaving the entity address where it was', generalUserByEmailSuffix('cybm', 'redalpha')?.organisationId, 'org_red00001');
}

// --- A short form may not take a person's address ----------------------------
{
  // `ro` is Martine's colleague's bare handle in a suffixless entity, so an
  // entity taking `ro` as its short form would shadow a live address.
  const roster = ensure('cybm');
  const ro = roster.find((u) => u.email === 'ro@cy-bm.sg')!;
  ro.emailHandle = 'ro';
  save(roster);
  r = await setSuffix('org_ste00001', 'ro');
  check('a short form somebody already answers to is refused', [r.status, r.body.error], [409, 'address_taken']);
  check('…naming the address it would have taken', r.body.address, 'ro@cybills.sg');
  check('…and who already has it', r.body.takenBy, 'Redalpha Ong');
}

server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
