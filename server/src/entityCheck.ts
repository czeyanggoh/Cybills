import { readSetting } from './settings.js';
import { listOrganisations, isStandalone, type Organisation } from './organisations.js';

// Is this document in the right client's book?
//
// Same arrangement as taxRules.ts, categories.ts and claimRef.ts: the rules live
// in one pure module the browser already uses (src/lib/billedTo.js) and are
// loaded here by path rather than re-typed in TypeScript. A second copy would
// drift, and the drift would be a row badged as somebody else's paperwork while
// the page it opens says the entity is fine.
//
// The verdict is computed on every listing rather than stored. It is a
// comparison between two things that both change — the document's bill-to party
// and the entity's own registered details — so a stored answer would go stale
// the moment somebody fills in the Business profile the check reads.

type Verdict = {
  status: 'ok' | 'mismatch' | 'unknown' | 'dismissed';
  evidence: string;
  reason: string;
  billedTo: string;
  candidates: Array<{ id: string; name: string }>;
};

type BilledToModule = {
  billedToVerdict: (
    doc: unknown,
    entity: unknown,
    others: unknown[]
  ) => Omit<Verdict, 'status'> & { status: string };
};

const PROFILE_KEY = 'cybills.business-profile.v1';

let cache: BilledToModule | null = null;
let tried = false;

async function load(): Promise<BilledToModule | null> {
  if (tried) return cache;
  tried = true;
  try {
    const url = new URL('../../src/lib/billedTo.js', import.meta.url).href;
    const mod = (await import(url)) as Partial<BilledToModule>;
    cache = typeof mod?.billedToVerdict === 'function' ? (mod as BilledToModule) : null;
  } catch (e) {
    console.error('[entityCheck] billed-to rules unavailable', e);
    cache = null;
  }
  return cache;
}

// One entity as the rules want it: what it is called, and the registered
// details off its own Business profile.
function identify(ws: string, o: Organisation) {
  return {
    id: o.id,
    name: o.name || o.tenantName || '',
    tenantName: o.tenantName || '',
    standalone: isStandalone(o),
    profile: readSetting<Record<string, unknown>>(ws, PROFILE_KEY, o.id) || {},
  };
}

export type BilledToDoc = {
  kind?: string;
  billedTo?: string;
  billedToRegNo?: string;
  entityCheckDismissed?: boolean;
};

// Build a checker for one request. The organisation list and every entity's
// profile are read ONCE here rather than per document — this runs down the whole
// Costs listing, and a settings read per row would be the most expensive thing
// on the page.
//
// `canOpen` decides which OTHER entities may be offered as somewhere to move a
// document to. A destination the caller cannot open is not one they can be shown
// — it would name another client's company on this client's screen.
export async function makeEntityCheck(
  ws: string,
  canOpen: (orgId: string) => boolean
): Promise<(doc: BilledToDoc, entityId: string) => Verdict | null> {
  const mod = await load();
  if (!mod) return () => null;
  const organisations = listOrganisations(ws);
  const byId = new Map(organisations.map((o) => [o.id, identify(ws, o)]));

  return (doc, entityId) => {
    const me = byId.get(entityId);
    if (!me) return null;
    if (doc.entityCheckDismissed) {
      return {
        status: 'dismissed',
        evidence: '',
        reason: 'Somebody has confirmed this document belongs to this entity.',
        billedTo: String(doc.billedTo || ''),
        candidates: [],
      };
    }
    const others = organisations
      .filter((o) => o.id !== entityId && canOpen(o.id))
      .map((o) => byId.get(o.id)!);
    try {
      const v = mod.billedToVerdict(doc, me, others);
      return { ...v, status: (v.status as Verdict['status']) ?? 'unknown' };
    } catch (e) {
      console.error('[entityCheck] could not read the bill-to party', e);
      return null;
    }
  };
}
