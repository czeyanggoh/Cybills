import { useEffect, useState } from 'react';

// The inbound-email ("Extract by email") config: the mail domain user addresses
// live on. Practice team only on the server, and it carries no Worker URL or
// secret — those are kept in server/.env on the VPS and shown to nobody.
export function useInboundConfig() {
  const [config, setConfig] = useState(null);
  useEffect(() => {
    let live = true;
    fetch('/api/inbound/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live) setConfig(d); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return config;
}
