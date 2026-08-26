import { useEffect, useState } from 'react';

// The inbound-email ("Extract by email") config for the Cloudflare Email Worker:
// the webhook URL to POST to, the shared secret to sign with, and the mail
// domain user addresses live on. Admin-only on the server.
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
