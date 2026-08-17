import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';
import { env, mailConfigured } from './env.js';

// The connected sending mailbox: one record, holding the OAuth refresh token an
// admin granted from Settings > Email. Delegated Graph auth has no credential
// of its own — it borrows a user's — so this token is what lets CYBills send
// account email at moments when nobody is signed in (a password reset, above
// all).
//
// The refresh token is encrypted at rest with AES-256-GCM. On its own it is
// already not redeemable — Azure requires client_id + client_secret from the
// confidential client too — but the data dir and the env file have different
// exposure, so there's no reason to leave it in the clear.

const COLLECTION = 'mailAccount';

export type MailAccount = {
  id: 'default';
  account: string; // UPN of the mailbox that consented
  displayName: string;
  refreshToken: string; // encrypted; see seal()/open()
  scopes: string[];
  connectedBy: string; // the CYBills admin who authorised it
  connectedAt: string; // ISO
  // Set when Azure rejects the refresh token (password change, revoked consent,
  // conditional access). Sending stops and the UI asks for a reconnect rather
  // than retrying a token that will never work again.
  invalidatedAt?: string;
  invalidReason?: string;
};

// Key derived from the session secret: it's already the app's root secret, and
// rotating it (which logs everyone out anyway) is a sensible time to reconnect.
// Deliberately NOT the Graph client secret — rotating that is routine and must
// not cost a reconnect, since the refresh token itself survives it.
function key(): Buffer | null {
  if (!env.SESSION_SECRET) return null; // dev/mock: no secret to derive from
  return scryptSync(env.SESSION_SECRET, 'cybills-mail-token', 32);
}

function seal(plain: string): string {
  const k = key();
  if (!k) return `plain:${plain}`; // local dev only — prod always has a secret
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${enc.toString('base64url')}`;
}

function open(sealed: string): string | null {
  if (sealed.startsWith('plain:')) return sealed.slice(6);
  const [version, iv, tag, payload] = sealed.split(':');
  if (version !== 'v1' || !iv || !tag || !payload) return null;
  const k = key();
  if (!k) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(payload, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key (SESSION_SECRET rotated) or tampered file — treat as no
    // connection, which surfaces in the UI as "reconnect the mailbox".
    return null;
  }
}

const rows = () => loadCollection<MailAccount>(COLLECTION);

export function getMailAccount(): MailAccount | null {
  return rows().find((r) => r.id === 'default') ?? null;
}

export function saveMailAccount(a: {
  account: string;
  displayName: string;
  refreshToken: string;
  scopes: string[];
  connectedBy: string;
}): MailAccount {
  const record: MailAccount = {
    id: 'default',
    account: a.account,
    displayName: a.displayName,
    refreshToken: seal(a.refreshToken),
    scopes: a.scopes,
    connectedBy: a.connectedBy,
    connectedAt: new Date().toISOString(),
  };
  saveCollection(COLLECTION, [record]);
  return record;
}

// Azure hands back a fresh refresh token on most redemptions; persisting it
// keeps the connection rolling forward instead of ageing out.
export function updateRefreshToken(next: string): void {
  const current = getMailAccount();
  if (!current) return;
  saveCollection(COLLECTION, [{ ...current, refreshToken: seal(next) }]);
}

export function readRefreshToken(): string | null {
  const current = getMailAccount();
  if (!current || current.invalidatedAt) return null;
  return open(current.refreshToken);
}

// Park the connection as unusable. Keeps the record (so the UI can name the
// mailbox and say why) but stops every further send until someone reconnects.
export function invalidateMailAccount(reason: string): void {
  const current = getMailAccount();
  if (!current || current.invalidatedAt) return;
  console.error('[mail] connection invalidated:', reason);
  saveCollection(COLLECTION, [{ ...current, invalidatedAt: new Date().toISOString(), invalidReason: reason }]);
}

export function clearMailAccount(): void {
  saveCollection(COLLECTION, []);
}

// Can we actually send right now? Needs the app registration AND a live
// connection whose token we can still decrypt.
export function isMailConnected(): boolean {
  return mailConfigured && Boolean(readRefreshToken());
}

// The mailbox we send as: the shared mailbox when configured (needs
// Mail.Send.Shared + Send As), otherwise the connected user's own.
export function senderAddress(): string {
  return env.GRAPH_SHARED_SENDER || getMailAccount()?.account || '';
}

// Shape for the Settings UI — never leaks the token itself.
export function mailStatus() {
  const a = getMailAccount();
  return {
    configured: mailConfigured,
    connected: isMailConnected(),
    account: a?.account ?? '',
    displayName: a?.displayName ?? '',
    connectedBy: a?.connectedBy ?? '',
    connectedAt: a?.connectedAt ?? '',
    sharedSender: env.GRAPH_SHARED_SENDER,
    sendingAs: senderAddress(),
    needsReconnect: Boolean(a && !isMailConnected()),
    invalidReason: a?.invalidReason ?? '',
  };
}
