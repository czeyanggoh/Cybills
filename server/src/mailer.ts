import { env, mailEnabled } from './env.js';

// Outbound email via Microsoft Graph (app-only / client-credentials). CYBills
// sends from a real Microsoft 365 mailbox — no SMTP relay, no third-party mail
// vendor holding our list. The Azure app registration holds the `Mail.Send`
// APPLICATION permission (admin-consented), which is tenant-wide, so the
// mailbox should be locked to one address with an Exchange application access
// policy (see deploy/EMAIL.md).
//
// Everything below no-ops with `sent: false` until the four GRAPH_* vars are
// configured, so the invite / password flows degrade to "copy this link
// yourself" instead of failing.

const TOKEN_HOST = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';

// Cached app-only access token. Graph tokens last ~60–90 min; we refresh a
// minute early so a request never races the expiry.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;

  const body = new URLSearchParams({
    client_id: env.GRAPH_CLIENT_ID,
    client_secret: env.GRAPH_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await fetch(`${TOKEN_HOST}/${encodeURIComponent(env.GRAPH_TENANT_ID)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20_000),
  });

  const data: any = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    // AAD returns error_description with the actual cause (bad secret, wrong
    // tenant, consent not granted) — keep it, it's what you need to debug.
    throw new Error(`graph_token_failed: ${data?.error_description ?? `HTTP ${res.status}`}`);
  }

  const ttl = Number(data.expires_in) || 3600;
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (ttl - 60) * 1000 };
  return cachedToken.value;
}

export type MailResult = { sent: boolean; error?: string };

type Recipient = { email: string; name?: string };

function graphRecipient(r: Recipient) {
  return { emailAddress: { address: r.email, ...(r.name ? { name: r.name } : {}) } };
}

// Send one message. Never throws — a failed invite email must not roll back the
// user record that was just written; callers surface `sent` to the admin and
// fall back to sharing the link by hand.
export async function sendMail(msg: {
  to: Recipient | Recipient[];
  subject: string;
  html: string;
  cc?: Recipient[];
}): Promise<MailResult> {
  if (!mailEnabled) return { sent: false, error: 'mail_not_configured' };

  const to = Array.isArray(msg.to) ? msg.to : [msg.to];
  if (!to.length || !to.every((r) => r.email)) return { sent: false, error: 'no_recipient' };

  try {
    const token = await accessToken();
    const res = await fetch(`${GRAPH}/users/${encodeURIComponent(env.GRAPH_SENDER)}/sendMail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: msg.subject,
          body: { contentType: 'HTML', content: msg.html },
          toRecipients: to.map(graphRecipient),
          ...(msg.cc?.length ? { ccRecipients: msg.cc.map(graphRecipient) } : {}),
          ...(env.MAIL_REPLY_TO
            ? { replyTo: [graphRecipient({ email: env.MAIL_REPLY_TO })] }
            : {}),
        },
        saveToSentItems: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    // Graph answers 202 Accepted with an empty body on success.
    if (res.status === 202 || res.ok) return { sent: true };

    const data: any = await res.json().catch(() => null);
    const detail = data?.error?.message ?? `HTTP ${res.status}`;
    console.error('[mailer] sendMail failed:', detail);
    // A stale token would keep failing; drop it so the next attempt re-auths.
    if (res.status === 401) cachedToken = null;
    return { sent: false, error: detail };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[mailer] sendMail failed:', detail);
    return { sent: false, error: detail };
  }
}

// --- Templates ---------------------------------------------------------------
// Plain, inline-styled HTML — mail clients strip <style> blocks and ignore most
// modern CSS, so the house black-and-white look is done with inline rules only.

const esc = (s: string) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function layout(opts: { heading: string; body: string; cta?: { label: string; url: string }; footnote?: string }) {
  const button = opts.cta
    ? `<p style="margin:28px 0 0"><a href="${esc(opts.cta.url)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-size:14px;font-weight:500;padding:12px 22px;border-radius:6px">${esc(opts.cta.label)}</a></p>
       <p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#6b7280">If the button doesn&rsquo;t work, paste this into your browser:<br><span style="color:#111;word-break:break-all">${esc(opts.cta.url)}</span></p>`
    : '';

  return `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f5">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:1px solid #e5e7eb;border-radius:10px">
        <tr><td style="padding:32px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111">
          <p style="margin:0 0 24px;font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#6b7280">CYBills</p>
          <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;line-height:1.3">${esc(opts.heading)}</h1>
          <div style="font-size:14px;line-height:1.65;color:#374151">${opts.body}</div>
          ${button}
          ${opts.footnote ? `<p style="margin:28px 0 0;padding-top:20px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#6b7280">${opts.footnote}</p>` : ''}
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:11px;color:#9ca3af">CY Business Management &middot; ${esc(env.APP_ORIGIN.replace(/^https?:\/\//, ''))}</p>
    </td></tr>
  </table>
</body></html>`;
}

// Invitation to a brand-new account: the recipient picks their own password on
// the linked page, so no credential ever travels by email.
export function inviteEmail(o: { name: string; url: string; inviterName?: string; expiresInDays: number }) {
  const from = o.inviterName ? `${esc(o.inviterName)} has invited you` : 'You have been invited';
  return {
    subject: 'You have been invited to CYBills',
    html: layout({
      heading: `Hi ${esc(o.name.split(' ')[0] || 'there')},`,
      body: `<p style="margin:0">${from} to join <strong>CYBills</strong>, the billing workspace for CY Business Management.</p>
             <p style="margin:14px 0 0">Set your password to activate your account and sign in.</p>`,
      cta: { label: 'Set your password', url: o.url },
      footnote: `This link expires in ${o.expiresInDays} days and can only be used once. If you weren&rsquo;t expecting this invitation you can ignore this email.`,
    }),
  };
}

// Self-service reset requested from the sign-in page.
export function passwordResetEmail(o: { name: string; url: string; expiresInDays: number }) {
  return {
    subject: 'Reset your CYBills password',
    html: layout({
      heading: `Hi ${esc(o.name.split(' ')[0] || 'there')},`,
      body: `<p style="margin:0">We received a request to reset the password for your CYBills account.</p>
             <p style="margin:14px 0 0">Choose a new password using the link below.</p>`,
      cta: { label: 'Choose a new password', url: o.url },
      footnote: `This link expires in ${o.expiresInDays} days and can only be used once. If you didn&rsquo;t request a reset, ignore this email &mdash; your password is unchanged.`,
    }),
  };
}

// Confirmation after a password actually changes. `by` names the admin when an
// administrator did it, so an unexpected change is obvious to the account owner.
export function passwordChangedEmail(o: { name: string; by?: string }) {
  const who = o.by ? `by <strong>${esc(o.by)}</strong>` : 'from your profile';
  return {
    subject: 'Your CYBills password was changed',
    html: layout({
      heading: `Hi ${esc(o.name.split(' ')[0] || 'there')},`,
      body: `<p style="margin:0">The password on your CYBills account was just changed ${who}.</p>
             <p style="margin:14px 0 0">You can sign in with your new password at any time.</p>`,
      cta: { label: 'Go to CYBills', url: `${env.APP_ORIGIN}/login` },
      footnote: 'If you didn&rsquo;t expect this change, contact your CYBills administrator straight away.',
    }),
  };
}
