// Who a document belongs to. `createdBy` used to hold EITHER an email or a
// display name — the Add-documents drawer and the detail page's owner field
// both wrote a name over it — while the name lookup only knew the client
// entity's own employees. A practice colleague therefore reached the User
// column two ways at once ("Cze Yang Goh" on the documents whose owner had been
// set, "czeyang.goh" on the rest), as if they were two people. This covers the
// split that fixed it: createdBy is the uploader, `owner` is the owner, and
// both are always emails.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-owner-'));
process.env.BILLS_DATA_DIR = DATA_DIR;

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha Cybersecurity', tenantId: 't-red', tenantName: 'Red Alpha', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const { billsRouter } = await import('../src/bills.ts');
const { usersRouter, emailForPerson, peopleForOrg, ownerForOrg } = await import('../src/users.ts');
const { insertBill } = await import('../src/store.ts');

// A document written the old way: the owner's DISPLAY NAME sitting in the field
// that is meant to hold the uploader's email.
const legacy = insertBill({
  orgId: 'cybm', kind: 'cost', status: 'ready', supplier: 'Singtel', invoiceNumber: 'S-1',
  documentType: 'Invoice', currency: 'SGD', date: '2026-07-31', category: '489 - Telephone',
  description: 'Broadband', total: '100', tax: '0', createdBy: 'Cze Yang Goh',
} as any);
// One whose stored name matches nobody — a person since removed, or a typo.
const stranger = insertBill({
  orgId: 'cybm', kind: 'cost', status: 'ready', supplier: 'AWS', invoiceNumber: 'A-1',
  documentType: 'Invoice', currency: 'SGD', date: '2026-07-31', category: '470 - IT Services',
  description: 'Hosting', total: '250', tax: '0', createdBy: 'Someone Else',
} as any);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/costs', billsRouter);
app.use('/api/users', usersRouter);
const server = app.listen(4607, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const base = 'http://127.0.0.1:4607';
const asOrg = (orgId: string) => (orgId ? { 'X-Org-Id': orgId } : {});
const bills = async (orgId = 'org-cybm') => {
  const res = await fetch(`${base}/api/costs/bills`, { headers: asOrg(orgId) as any });
  return (await res.json()).bills as any[];
};
const byId = async (id: string, orgId = 'org-cybm') => (await bills(orgId)).find((b) => b.id === id);
const send = async (method: string, path: string, body: unknown, orgId = 'org-cybm') => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...asOrg(orgId) } as any,
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// 1) The directory is wider than the roster: a colleague belongs to no client
// entity, but can own documents in every one they work on.
const people = peopleForOrg('cybm', 'org-red');
check('a colleague is in Red Alpha’s directory', people.some((p) => p.email === 'czeyang.goh@cy-bm.sg'), true);
const roster = await (await fetch(`${base}/api/users`, { headers: asOrg('org-red') as any })).json();
check('…and not on Red Alpha’s roster', roster.users.some((u: any) => u.email === 'czeyang.goh@cy-bm.sg'), false);
const dir = await (await fetch(`${base}/api/users/directory`, { headers: asOrg('org-red') as any })).json();
check('the directory endpoint serves them', dir.people.some((p: any) => p.email === 'czeyang.goh@cy-bm.sg'), true);

// 2) A person is resolved from either spelling, and never guessed.
check('by email', emailForPerson('cybm', 'org-cybm', 'CZEYANG.GOH@cy-bm.sg'), 'czeyang.goh@cy-bm.sg');
check('by display name', emailForPerson('cybm', 'org-cybm', 'cze yang goh'), 'czeyang.goh@cy-bm.sg');
check('an unknown name resolves to nothing', emailForPerson('cybm', 'org-cybm', 'Someone Else'), '');

// 3) The backfill, on the next listing: a stored name becomes that person's
// email, in both fields — the true uploader was lost when the name overwrote it.
check('the legacy name became an email', (await byId(legacy.id))?.owner, 'czeyang.goh@cy-bm.sg');
check('…in createdBy too', (await byId(legacy.id))?.createdBy, 'czeyang.goh@cy-bm.sg');
check('a name matching nobody is left exactly as it was', (await byId(stranger.id))?.createdBy, 'Someone Else');
check('…and gets no owner', (await byId(stranger.id))?.owner || '', '');
check('the repair is written back to disk',
  JSON.parse(readFileSync(join(DATA_DIR, 'bills.json'), 'utf8')).bills.find((b: any) => b.id === legacy.id).owner,
  'czeyang.goh@cy-bm.sg');

// 4) A new upload: the drawer still sends a display name, and it lands in
// `owner` as an email. createdBy is the uploader — never the owner's name.
// This is CYBM's own entity, and the colleagues belong to it, so their own
// company's paperwork still carries their name (section 7 covers the case that
// doesn't: the same colleague working on a CLIENT).
const made = await send('POST', '/api/costs/bills', {
  fileHash: 'h1', fileName: 'r.pdf', supplier: 'Grab', total: '20', tax: '0',
  date: '2026-08-01', category: '429 - General Expenses', owner: 'Astrid Yang',
});
check('upload accepted', made.status, 200);
check('the owner is stored as an email', made.body.bill.owner, 'astridy2004@gmail.com');
check('createdBy is not the owner’s name', made.body.bill.createdBy, '');

// 5) Reassigning the owner moves `owner` and leaves the uploader alone.
const patched = await send('PATCH', `/api/costs/bills/${legacy.id}`, { owner: 'Astrid Yang' });
check('reassigned', patched.status, 200);
check('owner follows the new person', (await byId(legacy.id))?.owner, 'astridy2004@gmail.com');
check('the uploader is untouched', (await byId(legacy.id))?.createdBy, 'czeyang.goh@cy-bm.sg');
check('createdBy can no longer be written directly',
  (await send('PATCH', `/api/costs/bills/${legacy.id}`, { createdBy: 'Someone Else' })).body.bill?.createdBy,
  'czeyang.goh@cy-bm.sg');

// 6) An owner nobody can place: an address is kept (a real person outside this
// entity's directory), a bare name is not (that is the ambiguity being removed).
const odd = await send('POST', '/api/costs/bills', {
  fileHash: 'h2', fileName: 'r2.pdf', supplier: 'Grab', total: '21', tax: '0',
  date: '2026-08-01', category: '429 - General Expenses', owner: 'someone@elsewhere.com',
});
check('an unknown address is kept', odd.body.bill.owner, 'someone@elsewhere.com');
const odd2 = await send('POST', '/api/costs/bills', {
  fileHash: 'h3', fileName: 'r3.pdf', supplier: 'Grab', total: '22', tax: '0',
  date: '2026-08-01', category: '429 - General Expenses', owner: 'Nobody At All',
});
check('an unknown name is dropped', odd2.body.bill.owner, '');

// 7) The general account. Linking an organisation creates it, so a client
// entity always has somewhere for unclaimed paperwork to go, and the Users list
// is never empty.
const redRoster = await (await fetch(`${base}/api/users`, { headers: asOrg('org-red') as any })).json();
const general = redRoster.users.find((u: any) => u.general);
check('a linked entity starts with its general account', general?.name, 'General');
check('…which the roster reports as having no mailbox', general?.email, '');
check('…and which can’t sign in', general?.login, 'No');
const redDir = await (await fetch(`${base}/api/users/directory`, { headers: asOrg('org-red') as any })).json();
const dir2 = await (await fetch(`${base}/api/users/directory`, { headers: asOrg('org-cybm') as any })).json();
const dirGeneral = redDir.people.find((p: any) => p.general);
check('the directory carries it as an owner one can pick', dirGeneral?.email, 'org-red.general@cybills.local');
check('…flagged as the client’s own, not an outsider', dirGeneral?.external, false);
check('a colleague working here from outside is flagged as one',
  redDir.people.find((p: any) => p.email === 'czeyang.goh@cy-bm.sg')?.external, true);
check('…and is not an outsider in the practice’s own entity',
  dir2.people.find((p: any) => p.email === 'czeyang.goh@cy-bm.sg')?.external, false);

// The client's OWN people still own what is theirs.
await send('POST', '/api/users', { name: 'Martin Lim', email: 'martin@redalphacyber.com', notify: false }, 'org-red');
const redBill = await send('POST', '/api/costs/bills', {
  fileHash: 'h4', fileName: 'r4.pdf', supplier: 'Grab', total: '30', tax: '0',
  date: '2026-08-02', category: '429 - General Expenses', owner: 'Martin Lim',
}, 'org-red');
check('one of the client’s own people keeps the document', redBill.body.bill.owner, 'martin@redalphacyber.com');

// A colleague named as the owner of a CLIENT's document doesn't stick: doing
// the books is not owning the paperwork.
const redToColleague = await send('POST', '/api/costs/bills', {
  fileHash: 'h5', fileName: 'r5.pdf', supplier: 'Grab', total: '31', tax: '0',
  date: '2026-08-02', category: '429 - General Expenses', owner: 'Cze Yang Goh',
}, 'org-red');
check('a colleague as a client’s owner becomes the general account',
  redToColleague.body.bill.owner, 'org-red.general@cybills.local');

// And who UPLOADED it decides where an unnamed document goes: a colleague's
// falls to the general account, a client employee's keeps following them —
// as does a colleague's in the practice's own entity.
check('a colleague uploading, naming nobody — the general account',
  ownerForOrg('cybm', 'org-red', '', 'czeyang.goh@cy-bm.sg'), 'org-red.general@cybills.local');
check('the client’s own person uploading, naming nobody — left to follow them',
  ownerForOrg('cybm', 'org-red', '', 'martin@redalphacyber.com'), '');
check('a colleague in their OWN entity, naming nobody — left to follow them',
  ownerForOrg('cybm', 'org-cybm', '', 'czeyang.goh@cy-bm.sg'), '');

server.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
