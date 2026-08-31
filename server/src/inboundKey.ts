import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';

// The key CYWorkspace sends BACK when it calls us.
//
// One key, one trust boundary. CYWS proves itself with `X-API-Key` on every
// machine-to-machine call it makes here — a WhatsApp bill, the collection
// directory, the message mirror, and now the payables hand-off — and all of
// them are the same two parties on the same box under the same operator, so
// they share one secret rather than accumulating a key per feature. What that
// key opens is deliberately narrow either way: each route is named in the
// session guard's allowlist, and nothing else in the app answers to it.
//
// Prefer an env override; otherwise generate one on first use and keep it, so a
// practice admin can read it out of the app and hand it to the CYWS operator
// without anybody having shell access to the VPS. Same arrangement as the
// inbound-email secret, and for the same reason.
//
// A leaf on purpose: the payables router has to check this key, and reaching it
// through whatsapp.ts would drag the WhatsApp router — and through it users.ts
// and the Xero routes — into a module those routes import back. Same reason
// waChannels.ts and waThread.ts were split out.
type InboundKeyRow = { id: string; key: string };

export function inboundKey(): string {
  const fromEnv = (process.env.WHATSAPP_INBOUND_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const items = loadCollection<InboundKeyRow>('whatsapp-inbound-key');
  const existing = items.find((x) => x.id === 'default');
  if (existing?.key) return existing.key;
  const key = randomBytes(24).toString('hex');
  saveCollection('whatsapp-inbound-key', [{ id: 'default', key }]);
  return key;
}

// Constant-time compare, so the key can't be recovered a byte at a time.
export function keyMatches(given: string): boolean {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(inboundKey());
  return a.length === b.length && timingSafeEqual(a, b);
}
