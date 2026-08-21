// A server-backed JSON "blob" setting, with an in-memory cache so existing
// SYNCHRONOUS getters keep working. On module load it hydrates the cache from
// /api/settings/:key (calling onHydrate when server data arrives, so subscribed
// views refetch); writes update the cache immediately (optimistic) and PUT to
// the server. Used by the small settings-like stores (lists, custom categories,
// customer/supplier rules).
//
// Scope: workspace-wide by default. Pass { perOrg: true } for anything that
// describes ONE client entity — its registration details, its Xero-derived tax
// rates and categories, its coding rules — so switching organisation switches
// the settings with it. Those keys are suffixed with the active org id.

// Mirrors organisations.js. Read straight from localStorage rather than
// imported, because organisations.js → listsStore.js → blobStore.js would
// cycle (the same reason setActiveOrganisationId dispatches its event by
// literal name).
const ACTIVE_ORG_KEY = 'cybills:active-organisation';
export const ORGANISATION_EVENT = 'cybills:organisation-changed';

function activeOrg() {
  try {
    return localStorage.getItem(ACTIVE_ORG_KEY) || '';
  } catch {
    return ''; // localStorage unavailable — everything lands on 'default'
  }
}

export function blobStore(key, fallback, onHydrate = () => {}, { perOrg = false } = {}) {
  const cache = new Map(); // org id ('' when workspace-wide) -> value
  let org = perOrg ? activeOrg() : '';
  const url = (o) => `/api/settings/${encodeURIComponent(perOrg ? `${key}::${o || 'default'}` : key)}`;

  const hydrate = async (o) => {
    try {
      const res = await fetch(url(o));
      if (!res.ok) return;
      let { value } = await res.json();
      if (value == null && perOrg) {
        // This org has no value of its own yet, so inherit the workspace-wide
        // one this store used to share. Nothing appears to vanish the day a
        // store becomes per-org; the first save writes to the org's own key and
        // the two diverge from there.
        const legacy = await fetch(`/api/settings/${encodeURIComponent(key)}`);
        if (legacy.ok) value = (await legacy.json()).value;
      }
      if (value == null) return;
      cache.set(o, value);
      if (o === org) onHydrate();
    } catch {
      // Server unreachable — keep the fallback; writes will retry the PUT.
    }
  };
  hydrate(org);

  if (perOrg && typeof window !== 'undefined') {
    window.addEventListener(ORGANISATION_EVENT, () => {
      const next = activeOrg();
      if (next === org) return;
      org = next;
      onHydrate(); // re-render now on what we hold (cached value or fallback)
      if (!cache.has(org)) hydrate(org); // …then again once the server answers
    });
  }

  return {
    get: () => (cache.has(org) ? cache.get(org) : fallback),
    set: (next) => {
      cache.set(org, next);
      fetch(url(org), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: next }),
      }).catch(() => {});
    },
  };
}
