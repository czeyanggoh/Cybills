import {
  createHmac,
  randomBytes,
  timingSafeEqual,
  createHash,
  createCipheriv,
  createDecipheriv,
  scryptSync,
} from 'node:crypto';
import { env } from './env.js';

// Time-based one-time passwords (RFC 6238), for the people who sign in with an
// email and a password.
//
// Google accounts already carry their own second factor, so this is not for
// them: it is for ST Engineering's staff and anyone else who reaches CYBills
// through the password form, which is otherwise a single secret between an
// outsider and a client's whole book of paperwork.
//
// Written out rather than pulled in, because it is thirty lines of HMAC and the
// RFC ships its own test vectors — so it can be checked against the standard
// itself instead of against a library's behaviour.

const DIGITS = 6;
const STEP_SECONDS = 30;
// One step either side. A phone's clock drifts and a person takes a moment to
// type, so refusing a code that was correct four seconds ago fails honest
// people far more often than it stops anybody.
const WINDOW_STEPS = 1;

// --- Base32 (RFC 4648, no padding) -------------------------------------------
// The alphabet authenticator apps expect. Lowercase and stray spaces are
// tolerated on the way in, because people retype these by hand off a screen.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = String(text ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// --- The code itself ----------------------------------------------------------
// HOTP (RFC 4226): HMAC-SHA1 over the counter, then the dynamic-truncation
// offset picked from the last nibble.
function hotp(secret: Buffer, counter: number, digits: number): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac('sha1', secret).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code =
    ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) | ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

// The code for a moment in time. `atMs` is a parameter so the tests can stand
// at the instants the RFC names.
export function totpCode(secretBase32: string, atMs = Date.now(), digits = DIGITS): string {
  return hotp(base32Decode(secretBase32), Math.floor(atMs / 1000 / STEP_SECONDS), digits);
}

// Whether a typed code is right for now, or for one step either side.
//
// Compared byte-for-byte in constant time: the comparison is against a
// six-digit number an attacker is already guessing at, so this is belt and
// braces rather than the thing that matters — but it costs nothing.
export function totpMatches(secretBase32: string, typed: string, atMs = Date.now()): boolean {
  const clean = String(typed ?? '').replace(/\D+/g, '');
  if (clean.length !== DIGITS) return false;
  const given = Buffer.from(clean);
  for (let step = -WINDOW_STEPS; step <= WINDOW_STEPS; step += 1) {
    const candidate = Buffer.from(totpCode(secretBase32, atMs + step * STEP_SECONDS * 1000));
    if (candidate.length === given.length && timingSafeEqual(candidate, given)) return true;
  }
  return false;
}

// 20 bytes, which is what RFC 4226 recommends and what every authenticator
// expects.
export const newSecret = (): string => base32Encode(randomBytes(20));

// The line an authenticator app reads. The issuer appears twice on purpose:
// once as the label prefix, which is what older apps show, and once as the
// parameter, which is what current ones read.
export function otpauthUri(secretBase32: string, account: string, issuer = 'CYBills'): string {
  // Issuer and account are encoded separately so the colon between them stays
  // a literal separator. Encoded whole, the label becomes "CYBills%3Adean@…",
  // which older apps read as one long account name with no issuer at all.
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// The secret as a person retypes it off a screen: five-character groups, which
// is how authenticator apps print it too.
export const readableSecret = (s: string): string => (s.match(/.{1,5}/g) ?? []).join(' ');

// --- Recovery codes -----------------------------------------------------------
// A phone gets lost, and without these the only way back in is an admin reset —
// which needs an admin who is awake. Ten of them, each usable once.
//
// Stored as SHA-256 like the password-reset tokens: the row keeps something
// that proves a code was right, never the code itself, so a copy of the data
// file is not a way in.
export const RECOVERY_COUNT = 10;

export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_COUNT }, () => {
    const raw = randomBytes(5).toString('hex'); // 10 hex characters
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export const hashRecovery = (code: string): string =>
  createHash('sha256').update(String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');

// Spend one recovery code. Returns the remaining hashes when it matched, or
// null when it did not — a used code is gone, which is the whole point of a
// one-time code.
export function spendRecovery(hashes: string[], typed: string): string[] | null {
  const want = hashRecovery(typed);
  const list = Array.isArray(hashes) ? hashes : [];
  if (!list.includes(want)) return null;
  return list.filter((h) => h !== want);
}

// --- The secret at rest -------------------------------------------------------
// Encrypted with a key derived from SESSION_SECRET, the same arrangement the
// mail refresh token uses. A TOTP secret is a password-equivalent: anybody
// holding it can mint that person's codes forever, so a copy of the data file
// must not be a copy of everyone's second factor.
//
// The trade is the same one mailAccount.ts makes and says out loud: changing
// SESSION_SECRET makes the sealed secrets unreadable, and everybody re-enrols.
function sealKey(): Buffer | null {
  if (!env.SESSION_SECRET) return null; // dev/mock: nothing to derive from
  return scryptSync(env.SESSION_SECRET, 'cybills-totp-secret', 32);
}

export function sealSecret(plain: string): string {
  const k = sealKey();
  if (!k) return `plain:${plain}`; // local dev only — prod always has a secret
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${enc.toString('base64url')}`;
}

export function openSecret(sealed: string): string {
  const text = String(sealed ?? '');
  if (!text) return '';
  if (text.startsWith('plain:')) return text.slice(6);
  const [version, iv, tag, payload] = text.split(':');
  const k = sealKey();
  if (version !== 'v1' || !iv || !tag || !payload || !k) return '';
  try {
    const d = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(payload, 'base64url')), d.final()]).toString('utf8');
  } catch {
    // A secret sealed under a different SESSION_SECRET. Unreadable is the
    // honest answer; the person re-enrols.
    return '';
  }
}
