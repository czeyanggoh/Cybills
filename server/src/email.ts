import { env } from './env.js';

/**
 * Microsoft 365 / Graph API email sender.
 *
 * Ported from CYWorkspace so both apps behave identically — the Azure/Exchange
 * setup, the env-var names and the troubleshooting runbook all transfer. See
 * docs/transactional-email.md. Do not "improve" the details below; the notes
 * mark the ones that look wrong but aren't.
 *
 * Sends mail as the VA01@cy-bm.sg mailbox (or whatever M365_SENDER_EMAIL is
 * configured to) using the OAuth2 client_credentials flow. The Azure AD app
 * needs:
 *
 *   - API permission: Microsoft Graph -> Application -> Mail.Send (admin consented)
 *   - An Exchange Online role assignment (RBAC for Applications) restricting the
 *     app to only the VA01 mailbox, so a stolen secret can't send as the CEO.
 *
 * Tokens are cached in-memory until ~5 min before expiry so we don't fetch a
 * new token on every send. The cache is per-process — fine for a single-VM
 * deploy. If we ever scale horizontally this should move to Redis.
 */

export interface EmailAttachment {
  filename: string;
  contentBase64: string; // base64 string, no data: prefix
  contentType: string; // e.g. 'application/pdf', 'text/csv'
}

export interface SendMailInput {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  /** HTML body. Plain-text emails are still allowed — pass a <pre>-wrapped string. */
  htmlBody: string;
  attachments?: EmailAttachment[];
  /** Defaults to env.M365_SENDER_EMAIL. Only override if the Exchange role
   *  assignment has been widened to permit sending as the override address. */
  from?: string;
  /** Defaults to `from`. Replies come back to this address. */
  replyTo?: string;
}

export interface SendMailResult {
  success: boolean;
  /** Graph doesn't return a message id from /sendMail, but we surface the
   *  response status for debugging. */
  status?: number;
}

export class EmailNotConfiguredError extends Error {
  code = 'email_not_configured' as const;
  constructor(missing: string[]) {
    super(`Email transport is not configured. Missing env vars: ${missing.join(', ')}.`);
  }
}

export class EmailSendError extends Error {
  code = 'email_send_failed' as const;
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`Microsoft Graph rejected the email (HTTP ${status}): ${body.slice(0, 400)}`);
    this.status = status;
    this.body = body;
  }
}

/** Returns the list of env vars required for email but currently unset. */
export function missingEmailEnvVars(): string[] {
  const missing: string[] = [];
  if (!env.M365_TENANT_ID) missing.push('M365_TENANT_ID');
  if (!env.M365_CLIENT_ID) missing.push('M365_CLIENT_ID');
  if (!env.M365_CLIENT_SECRET) missing.push('M365_CLIENT_SECRET');
  // M365_SENDER_EMAIL has a default ('VA01@cy-bm.sg'), so don't flag it.
  return missing;
}

export function isEmailConfigured(): boolean {
  return missingEmailEnvVars().length === 0;
}

interface TokenCacheEntry {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let tokenCache: TokenCacheEntry | null = null;

async function getGraphAccessToken(): Promise<string> {
  const missing = missingEmailEnvVars();
  if (missing.length > 0) throw new EmailNotConfiguredError(missing);

  // Reuse cached token if it's still good for >= 5 minutes.
  if (tokenCache && tokenCache.expiresAt - Date.now() > 5 * 60_000) {
    return tokenCache.accessToken;
  }

  const tokenUrl = `https://login.microsoftonline.com/${env.M365_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: env.M365_CLIENT_ID,
    client_secret: env.M365_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    // Clear cache on auth failure so we don't keep handing out a stale token.
    tokenCache = null;
    throw new EmailSendError(res.status, `token endpoint: ${text}`);
  }

  let parsed: { access_token?: string; expires_in?: number };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EmailSendError(500, `token endpoint returned non-JSON: ${text}`);
  }
  if (!parsed.access_token) {
    throw new EmailSendError(500, `token endpoint returned no access_token: ${text}`);
  }

  const ttlMs = (parsed.expires_in ?? 3600) * 1000;
  tokenCache = { accessToken: parsed.access_token, expiresAt: Date.now() + ttlMs };
  return parsed.access_token;
}

function normaliseRecipients(
  value: string | string[] | undefined
): Array<{ emailAddress: { address: string } }> {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0)
    .map((address) => ({ emailAddress: { address } }));
}

/**
 * Send an email via Microsoft Graph. Throws EmailNotConfiguredError if env
 * vars are missing, or EmailSendError on auth/HTTP/Graph failures. Callers
 * should catch and degrade gracefully.
 */
export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  const from = (input.from ?? env.M365_SENDER_EMAIL).trim();
  if (!from) throw new EmailNotConfiguredError(['M365_SENDER_EMAIL']);

  const toList = normaliseRecipients(input.to);
  if (toList.length === 0) {
    throw new EmailSendError(400, 'sendMail called with no "to" recipients');
  }

  const message: Record<string, unknown> = {
    subject: input.subject,
    body: { contentType: 'HTML', content: input.htmlBody },
    toRecipients: toList,
  };

  const ccList = normaliseRecipients(input.cc);
  if (ccList.length > 0) message.ccRecipients = ccList;
  const bccList = normaliseRecipients(input.bcc);
  if (bccList.length > 0) message.bccRecipients = bccList;
  if (input.replyTo) message.replyTo = normaliseRecipients(input.replyTo);

  if (input.attachments && input.attachments.length > 0) {
    message.attachments = input.attachments.map((a) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.filename,
      contentType: a.contentType,
      contentBytes: a.contentBase64,
    }));
  }

  const token = await getGraphAccessToken();
  const sendUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`;

  const res = await fetch(sendUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    // saveToSentItems is deliberate — a copy lands in VA01's Sent Items, which
    // is how delivery problems get diagnosed ("did Graph accept it, or did the
    // recipient's filter eat it?").
    body: JSON.stringify({ message, saveToSentItems: true }),
  });

  // Graph returns 202 Accepted with no body on success. There is no message id
  // to capture; anything other than 202 is a failure.
  if (res.status === 202) return { success: true, status: 202 };

  const text = await res.text();
  // If the token was rejected (e.g. cached past server-side revocation),
  // drop the cache so the next call re-fetches. Without this, a revoked secret
  // produces a permanent failure loop until restart.
  if (res.status === 401) tokenCache = null;
  throw new EmailSendError(res.status, text);
}

/**
 * Lightweight HTML escaper — use when interpolating user-supplied or
 * third-party strings into htmlBody so a vendor name containing `<` doesn't
 * break the layout (or inject markup).
 */
export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Attachment size guard (CYBills addition — see the "Attachment size" note in
// docs/transactional-email.md).
//
// Graph's /sendMail caps the WHOLE message at ~4 MB and base64 inflates bytes
// by ~33%, so budget ~3 MB of real bytes across all attachments. Anything
// larger needs a draft + upload-session flow, which this transport does not
// implement. Call `assertAttachmentsFit()` at the call site BEFORE sendMail so
// the caller can return a clear error instead of letting Graph reject it.
// ---------------------------------------------------------------------------

/** Real (pre-base64) bytes we allow across all attachments on one message. */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

export class EmailAttachmentTooLargeError extends Error {
  code = 'email_attachment_too_large' as const;
  bytes: number;
  limit = MAX_ATTACHMENT_BYTES;
  constructor(bytes: number) {
    super(
      `Attachments total ${(bytes / 1024 / 1024).toFixed(1)} MB, over the ` +
        `${(MAX_ATTACHMENT_BYTES / 1024 / 1024).toFixed(0)} MB limit for a single email. ` +
        `Send fewer documents, or share a link instead.`
    );
    this.bytes = bytes;
  }
}

/** Decoded byte count of a base64 string (no data: prefix), without decoding it. */
export function base64Bytes(contentBase64: string): number {
  const s = (contentBase64 ?? '').replace(/[\r\n]/g, '');
  if (!s) return 0;
  const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - padding;
}

/** Total real bytes across a set of attachments. */
export function attachmentsTotalBytes(attachments: EmailAttachment[] | undefined): number {
  return (attachments ?? []).reduce((n, a) => n + base64Bytes(a.contentBase64), 0);
}

/**
 * Throws EmailAttachmentTooLargeError when the attachments exceed what Graph's
 * /sendMail will accept. Call before sendMail on any path that attaches files.
 */
export function assertAttachmentsFit(attachments: EmailAttachment[] | undefined): void {
  const bytes = attachmentsTotalBytes(attachments);
  if (bytes > MAX_ATTACHMENT_BYTES) throw new EmailAttachmentTooLargeError(bytes);
}
