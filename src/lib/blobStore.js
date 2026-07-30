// A server-backed JSON "blob" setting, shared across the workspace, with an
// in-memory cache so existing SYNCHRONOUS getters keep working. On module load
// it hydrates the cache from /api/settings/:key (calling onHydrate when server
// data arrives, so subscribed views refetch); writes update the cache
// immediately (optimistic) and PUT to the server. Used by the small
// settings-like stores (lists, custom categories, customer/supplier rules).
export function blobStore(key, fallback, onHydrate = () => {}) {
  let cache = fallback;
  const url = `/api/settings/${encodeURIComponent(key)}`;

  (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const { value } = await res.json();
      if (value != null) {
        cache = value;
        onHydrate();
      }
    } catch {
      // Server unreachable — keep the fallback; writes will retry the PUT.
    }
  })();

  return {
    get: () => cache,
    set: (next) => {
      cache = next;
      fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: next }),
      }).catch(() => {});
    },
  };
}
