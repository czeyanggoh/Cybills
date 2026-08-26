import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

// A share link is a signed, expiring capability for ONE document's file.
//
// It exists because an exported CSV's Image column, and the Item ID links in a
// claim PDF, are opened OUTSIDE the app — by an accountant with the CSV in
// Excel, or an approver who was emailed the claim. Those links used to be the
// plain file URL, which worked only because the file route skipped the session
// guard entirely: the id was treated as an unguessable capability token, and a
// numeric Item ID (a timestamp) is nothing of the sort.
//
// So the capability is made explicit instead of assumed. The token names the
// one document it opens, carries its own expiry, and is signed with
// SESSION_SECRET — nothing to guess and nothing to enumerate. Whether the link
// is minted at all is the org's decision (Business settings -> Exports ->
// Image sharing), and that decision is read again on every request, so turning
// the toggle off revokes the links already out there.

export const SHARE_TTL_DAYS = 30;
const TTL_MS = SHARE_TTL_DAYS * 24 * 60 * 60 * 1000;

function sign(id: string, exp: number): string {
  // In mock/dev SESSION_SECRET is empty — so is the auth guard, so the constant
  // only keeps the shape valid; it protects nothing that isn't already open.
  return createHmac('sha256', env.SESSION_SECRET || 'cybills-dev')
    .update(`${id}\n${exp}`)
    .digest('base64url');
}

export function shareToken(id: string, now = Date.now()): string {
  const exp = now + TTL_MS;
  return `${exp}.${sign(id, exp)}`;
}

export function verifyShareToken(id: string, token: string, now = Date.now()): boolean {
  const [expRaw, mac] = String(token || '').split('.');
  const exp = Number(expRaw);
  if (!mac || !Number.isFinite(exp) || exp <= now) return false;
  const want = Buffer.from(sign(id, exp));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got);
}
