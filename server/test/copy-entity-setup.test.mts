// A new bridge entity set up the way an existing one already is.
//
// "Red Alpha - SMRT" works exactly as "Red Alpha - ST Engineering" does, and
// that working is the per-entity settings blobs plus the auto-claims schedule.
// Adding the entity with `copySettingsFrom` copies those, and nothing that
// identifies the COMPANY (its Business profile, its bank accounts) or its people.
//
// Driven over real HTTP against the create route.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-copy-setup-'));
process.env.BILLS_DATA_DIR = DATA_DIR;

const STE = 'org_ste00001';
writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_cybm001', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org_red00001', orgId: 'cybm', name: 'Red Alpha', tenantId: 't-red', tenantName: 'Red Alpha', createdAt: new Date(1).toISOString(), createdBy: '' },
      { id: STE, orgId: 'cybm', name: 'Red Alpha - ST Engineering', tenantId: '', tenantName: '', kind: 'standalone', parentOrgId: 'org_red00001', createdAt: new Date(2).toISOString(), createdBy: '' },
    ],
  })
);
const lists = { added: { categories: [{ id: 'c1', name: 'Overtime Meal', code: '' }] }, hidden: { categories: ['categories:Parking'] } };
const accounts = { 'Transport - Taxi': '493', 'Overtime Meal': '420' };
writeFileSync(
  join(DATA_DIR, 'settings.json'),
  JSON.stringify({
    items: [
      { workspaceId: 'cybm', key: `cybills.lists.v1::${STE}`, value: lists },
      { workspaceId: 'cybm', key: `cybills.category-accounts.v1::${STE}`, value: accounts },
      { workspaceId: 'cybm', key: `cybills.extraction-settings.v1::${STE}`, value: { reviewInstructions: 'ST Eng claim policy' } },
      { workspaceId: 'cybm', key: `cybills.business-profile.v1::${STE}`, value: { name: 'ST Engineering', crn: '199706274H' } },
      { workspaceId: 'cybm', key: `cybills.bank.accounts.v1::${STE}`, value: [{ name: 'DBS' }] },
      { workspaceId: 'cybm', key: 'cybills.lists.v1::org_red00001', value: { other: true } },
    ],
  })
);
writeFileSync(
  join(DATA_DIR, 'autoClaims.json'),
  JSON.stringify({
    items: [
      { workspaceId: 'cybm', orgId: STE, endDate: '2026-11-30', endOfMonth: true, frequency: 'monthly', includeInbox: true, userIds: ['u_ste1'], enrolledAt: { u_ste1: '2026-10-01' }, lastRunAt: '' },
    ],
  })
);

const express = (await import('express')).default;
const { organisationsRouter } = await import('../src/organisations.ts');
const { readSetting } = await import('../src/settings.ts');
const { getSettings } = await import('../src/autoClaims.ts');

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const app = express();
app.use(express.json());
app.use('/api/organisations', organisationsRouter);
const server = app.listen(4631, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const create = async (body: Record<string, unknown>) => {
  const res = await fetch('http://127.0.0.1:4631/api/organisations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const r = await create({ name: 'Red Alpha - SMRT', kind: 'standalone', parentOrgId: 'org_red00001', copySettingsFrom: STE });
check('the bridge is created', r.status, 200);
const SMRT = r.body.organisation.id;
check('it posts into the same parent', r.body.organisation.parentOrgId, 'org_red00001');
check('its category list is copied', readSetting('cybm', 'cybills.lists.v1', SMRT), lists);
check('what each category posts to is copied', readSetting('cybm', 'cybills.category-accounts.v1', SMRT), accounts);
check('extraction settings are copied', readSetting('cybm', 'cybills.extraction-settings.v1', SMRT), { reviewInstructions: 'ST Eng claim policy' });
check('the Business profile is NOT copied', readSetting('cybm', 'cybills.business-profile.v1', SMRT), null);
check('bank accounts are NOT copied', readSetting('cybm', 'cybills.bank.accounts.v1', SMRT), null);
check('the source keeps its own', readSetting('cybm', 'cybills.category-accounts.v1', STE), accounts);

const sched = getSettings('cybm', SMRT);
check('the auto-claims schedule is copied', [sched?.endDate, sched?.endOfMonth, sched?.frequency, sched?.includeInbox], ['2026-11-30', true, 'monthly', true]);
check('but nobody is enrolled on it', [sched?.userIds, sched?.enrolledAt], [[], {}]);
check('the reply names what was copied', r.body.copied.includes('cybills.category-accounts.v1') && r.body.copied.includes('auto-claims schedule'), true);

// A copy is independent: changing the new one never touches the old.
const stored = JSON.parse(readFileSync(join(DATA_DIR, 'settings.json'), 'utf8'));
const rows = stored.items.filter((s: { key: string }) => s.key.endsWith(SMRT));
check('three blobs copied, no more', rows.length, 3);

const bad = await create({ name: 'Red Alpha - Other', kind: 'standalone', parentOrgId: 'org_red00001', copySettingsFrom: 'org_nope' });
check('an unknown source is refused', [bad.status, bad.body.error], [400, 'copy_source_not_found']);

const plain = await create({ name: 'Red Alpha - Plain', kind: 'standalone', parentOrgId: 'org_red00001' });
check('without a source nothing is copied', readSetting('cybm', 'cybills.category-accounts.v1', plain.body.organisation.id), null);

await finish(failures, server);
