import { listBills } from './store.js';
import { dataScopeForOrg } from './organisations.js';
import { readSetting } from './settings.js';
import { supplierNamesForOrg } from './xero.js';

// A freshly read supplier name, filed under the supplier this entity already
// has. The rule is src/lib/supplierCanonical.js (pure, `npm test` at the root),
// loaded by path the way supplierGst.ts loads its own; this is only what it is
// handed:
//   - the entity's live Xero supplier contacts;
//   - the supplier names on its own documents, with how many each has;
//   - the names its supplier rules are written for;
//   - what the Suppliers page removed, and where each merged-away spelling went
//     (`cybills.supplier-list.v1`: `removed`, `merged`).
// Applied on both roads a read returns by (/extract and readIntoBill), BEFORE
// the remembered GST number and the supplier rule are looked up, so both find
// the supplier under the name it is kept as. Costs only: on a sales invoice the
// name is the CUSTOMER, and the suppliers are the wrong list to match it to.
// A failure anywhere leaves the name as read.

type Canonical = (read: unknown, ctx: unknown) => { name: string; from: '' | 'merge' | 'spelling' };
let rule: Canonical | null = null;
let tried = false;

async function loadRule(): Promise<Canonical | null> {
  if (tried) return rule;
  tried = true;
  try {
    const mod = await import(new URL('../../src/lib/supplierCanonical.js', import.meta.url).href);
    rule = typeof mod?.canonicalSupplierName === 'function' ? mod.canonicalSupplierName : null;
  } catch (e) {
    console.error('[supplierName] rule unavailable', e);
    rule = null;
  }
  return rule;
}

type ListBlob = { removed?: unknown; merged?: unknown };

export async function withKnownSupplierName<T extends { supplier?: unknown }>(
  data: T,
  ctx: { ws: string; orgId: string; kind?: string }
): Promise<T & { supplierRenamedFrom?: string }> {
  if (ctx.kind === 'sales') return data;
  const read = String(data.supplier ?? '').trim();
  if (!read) return data;
  try {
    const canonical = await loadRule();
    if (!canonical) return data;
    const candidates: Array<{ name: string; docs?: number; rule?: boolean; xero?: boolean }> = [];
    for (const name of await supplierNamesForOrg(ctx.ws, ctx.orgId)) candidates.push({ name, xero: true });
    const counts = new Map<string, { name: string; n: number }>();
    for (const b of listBills(dataScopeForOrg(ctx.orgId))) {
      if (b.kind === 'sales') continue;
      const name = String(b.supplier ?? '').trim();
      if (!name) continue;
      const k = name.toLowerCase();
      const cur = counts.get(k);
      if (cur) cur.n += 1;
      else counts.set(k, { name, n: 1 });
    }
    for (const { name, n } of counts.values()) candidates.push({ name, docs: n });
    const rules = readSetting<Record<string, unknown>>(ctx.ws, 'cybills.supplier.rules.v1', ctx.orgId) || {};
    for (const name of Object.keys(rules)) candidates.push({ name, rule: true });
    const list = readSetting<ListBlob>(ctx.ws, 'cybills.supplier-list.v1', ctx.orgId) || {};
    const removed = Array.isArray(list.removed) ? list.removed.map(String) : [];
    const merged = list.merged && typeof list.merged === 'object' && !Array.isArray(list.merged) ? (list.merged as Record<string, string>) : {};
    const out = canonical(read, { candidates, removed, merged });
    if (!out.from || !out.name || out.name === read) return data;
    return { ...data, supplier: out.name, supplierRenamedFrom: read };
  } catch (e) {
    console.error('[supplierName] left as read', e);
    return data;
  }
}
