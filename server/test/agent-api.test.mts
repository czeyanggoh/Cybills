// The agent API (agentApi.ts): the machine key, the named person, the entity
// from the Xero tenant, and every answer through the routes the pages use —
// over real HTTP, because the point is that a loopback call is judged exactly
// as a click is.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const PORT = 4653;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-agent-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.PORT = String(PORT);
process.env.WHATSAPP_INBOUND_KEY = 'agent-test-key';
process.env.SESSION_SECRET = 'agent-test-secret';
writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CYBM', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-gcy', orgId: 'cybm', name: 'GCY AUS', tenantId: 't-gcy', tenantName: 'GCY AUS', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { ensure, save } = await import('../src/users.ts');
const { claimsRouter } = await import('../src/claims.ts');
const { billsRouter } = await import('../src/bills.ts');
const { agentRouter } = await import('../src/agentApi.ts');
const { insertBill, getBillByIdAny } = await import('../src/store.ts');

const ORG = 'org-gcy';
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/costs', billsRouter);
app.use('/api/claims', claimsRouter);
app.use('/api/agent', agentRouter);
const server = app.listen(PORT, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const people = ensure('cybm');
const seed = people.find((u) => u.practice)!;
people.unshift({
  ...seed, id: 'emp_gcy', name: 'GCY AUS', email: 'gcy@example.com', role: 'Business Admin', practice: false,
  practiceRole: 'Standard', general: false, allClients: false, clientAccess: [], extraAccess: [],
  organisationId: ORG, deactivated: false, pending: false, removed: false, managerId: '',
} as never);
save(people);

const bill = (supplier: string, date: string, description = '') =>
  insertBill({
    orgId: ORG, fileHash: `${supplier}-${date}`, fileName: `${supplier}.pdf`, supplier, invoiceNumber: '',
    documentType: '', currency: 'SGD', total: 193.6, tax: 0, date, category: '493 - Travel', description,
    createdBy: 'gcy@example.com', owner: 'gcy@example.com', storageKey: '', contentType: 'application/pdf',
    status: 'ready', kind: 'cost',
  } as never);
const tanda = bill('EPI Capital Pty Ltd', '2026-10-28', 'Tanda workforce subscription');
const deputy = bill('Deputec Pty Ltd', '2026-10-31', 'Deputy rostering');

const agent = async (action: string, body: Record<string, unknown>, key = 'agent-test-key') => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/agent/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const as = { tenant_id: 't-gcy', acting_email: 'gcy@example.com' };

let r = await agent('list_costs', as, 'wrong');
check('a wrong key is refused', [r.status, r.body.error], [401, 'bad_key']);
r = await agent('list_costs', { tenant_id: 't-gcy' });
check('the person must be named', [r.status, r.body.error], [400, 'acting_email_required']);
r = await agent('list_costs', { ...as, acting_email: 'nobody@example.com' });
check('an address that is not a user is refused', [r.status, r.body.error], [403, 'not_a_member']);
r = await agent('list_costs', { ...as, tenant_id: 't-nowhere' });
check('a tenant with no entity is said', [r.status, r.body.error], [404, 'no_entity']);

r = await agent('list_costs', { ...as, supplier: 'tanda' });
check('list_costs finds Tanda by what the document says', r.body.costs.map((c: any) => c.supplier), ['EPI Capital Pty Ltd']);
check('…with its item id and state', [r.body.costs[0].item_id, r.body.costs[0].state], [tanda.displayId, 'ready']);

r = await agent('search_suppliers', { ...as, q: 'tanda' });
check('search_suppliers names the supplier Tanda is billed under', r.body.suppliers.map((s: any) => [s.supplier, s.matched_on]), [['EPI Capital Pty Ltd', ['description']]]);

r = await agent('add_items_to_claim', { ...as, new_claim: { claim_for: 'GCY AUS', name: 'GCY AUS Oct', date: '2026-10-31' }, item_ids: [tanda.displayId, deputy.displayId] });
check('a new claim is made with both items', [r.status, r.body.claims[0].name, r.body.claims[0].item_count], [200, 'GCY AUS Oct', 2]);
check('…and its total comes back', r.body.claims[0].total, 387.2);
check('…and before says they were on no claim', r.body.before.map((b: any) => b.claim_id), [null, null]);
const oct = r.body.claims[0].id as string;

r = await agent('create_claim', { ...as, name: 'GCY AUS Nov', claim_for: 'GCY AUS', date: '2026-11-30' });
const nov = r.body.claims[0].id as string;
r = await agent('move_items', { ...as, from_claim: nov, to_claim: oct, item_ids: [tanda.displayId] });
check('moving from a claim the item is not on is refused', [r.status, r.body.error], [409, 'not_on_from_claim']);
r = await agent('add_items_to_claim', { ...as, claim_id: nov, item_ids: [tanda.displayId] });
check('adding it to November moves it off October', r.body.moved_from.map((m: any) => m.claimId), [oct]);
check('…and both claims come back with their totals', r.body.claims.map((c: any) => [c.name, c.item_count]).sort(), [['GCY AUS Nov', 1], ['GCY AUS Oct', 1]]);

r = await agent('list_costs', { ...as, status: 'in expense claim' });
check('the list says which claim each is on', r.body.costs.map((c: any) => c.claim_name).sort(), ['GCY AUS Nov', 'GCY AUS Oct']);

r = await agent('archive_cost', { ...as, item_id: tanda.displayId });
check('a claimed document cannot be archived here', [r.status, r.body.error], [409, 'on_a_claim']);

r = await agent('remove_items_from_claim', { ...as, claim_id: nov, item_ids: [tanda.displayId] });
check('removing it frees it', r.body.after.map((b: any) => b.claim_id), [null]);
check('…and it is back in Costs', getBillByIdAny(tanda.id)?.status, 'ready');

r = await agent('rename_claim', { ...as, claim_id: oct, name: 'GCY AUS October' });
check('rename answers before and after', [r.body.before.name, r.body.claims[0].name], ['GCY AUS Oct', 'GCY AUS October']);

r = await agent('get_expense_claim', { ...as, claim_id: oct });
check('get_expense_claim carries the items and history', [r.body.claim.items.map((i: any) => i.item_id), r.body.claim.history.length > 0], [[deputy.displayId], true]);

r = await agent('submit_claim', { ...as, claim_id: oct });
check('a Xero-group action is a dry run without confirm', [r.body.dry_run, r.body.claim.status], [true, 'draft']);
r = await agent('get_expense_claim', { ...as, claim_id: oct });
check('…and changed nothing', r.body.claim.status, 'draft');

r = await agent('no_such_thing', as);
check('an unknown action lists the real ones', [r.status, Array.isArray(r.body.actions?.read)], [404, true]);

await finish(failures, server);
