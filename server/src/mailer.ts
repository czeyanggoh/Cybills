import nodemailer from 'nodemailer';
import { env, mailConfigured, smtpConfigured } from './env.js';
import {
  readRefreshToken,
  updateRefreshToken,
  invalidateMailAccount,
  isMailConnected,
  senderAddress,
} from './mailAccount.js';

// Outbound email via Microsoft Graph, using DELEGATED auth — the app sends as a
// signed-in Microsoft user, never as a daemon with tenant-wide reach. The app
// registration holds `Mail.Send` (Delegated), so the only mailbox it can touch
// is the one whose owner consented, and it cannot read anything in it.
//
// A password reset is requested by someone who can't sign in, so there's no
// live user session to borrow at that moment. An admin therefore connects the
// sending mailbox once (Settings > Email) and we keep the refresh token; every
// send below redeems it for a short-lived access token. See deploy/EMAIL.md.
//
// Everything no-ops with `sent: false` until a mailbox is connected, so the
// invite / password flows degrade to "copy this link yourself" instead of
// failing.

const TOKEN_HOST = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';

// The delegated permissions we ask the connecting admin to consent to.
// `offline_access` is what yields the refresh token; `Mail.Send.Shared` is only
// requested when sending from a shared mailbox is configured.
export function graphScopes(): string[] {
  const scopes = ['offline_access', 'https://graph.microsoft.com/Mail.Send'];
  if (env.GRAPH_SHARED_SENDER) scopes.push('https://graph.microsoft.com/Mail.Send.Shared');
  return scopes;
}

export const tokenEndpoint = () =>
  `${TOKEN_HOST}/${encodeURIComponent(env.GRAPH_TENANT_ID || 'organizations')}/oauth2/v2.0/token`;

export const authorizeEndpoint = () =>
  `${TOKEN_HOST}/${encodeURIComponent(env.GRAPH_TENANT_ID || 'organizations')}/oauth2/v2.0/authorize`;

// A refresh token whose redemption fails for one of these reasons will never
// work again — the user changed their password, consent was revoked, an admin
// killed the sessions. Retrying is pointless; the connection needs redoing.
const DEAD_TOKEN_ERRORS = new Set(['invalid_grant', 'interaction_required', 'unauthorized_client']);

// Exchange an authorization code (Settings > Email connect flow) for tokens.
// Throws with the AAD error text, which is what you need to debug a misconfig.
export async function redeemCode(code: string): Promise<{ accessToken: string; refreshToken: string; scopes: string[] }> {
  const data = await postToken({
    client_id: env.GRAPH_CLIENT_ID,
    client_secret: env.GRAPH_CLIENT_SECRET,
    code,
    redirect_uri: env.GRAPH_REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  if (!data.refresh_token) {
    // No refresh token means offline_access wasn't consented — the connection
    // would work until the first access token expired, then silently die.
    throw new Error('graph_no_refresh_token: the app must request offline_access');
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    scopes: String(data.scope ?? '').split(' ').filter(Boolean),
  };
}

async function postToken(form: Record<string, string>): Promise<any> {
  const res = await fetch(tokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20_000),
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    const err = new Error(`graph_token_failed: ${data?.error_description ?? `HTTP ${res.status}`}`);
    (err as any).aadError = String(data?.error ?? '');
    throw err;
  }
  return data;
}

// Cached delegated access token. Graph tokens last ~60–90 min; we refresh a
// minute early so a send never races the expiry.
let cachedToken: { value: string; expiresAt: number } | null = null;

export function forgetCachedToken() {
  cachedToken = null;
}

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;

  const refresh = readRefreshToken();
  if (!refresh) throw new Error('mail_not_connected');

  let data: any;
  try {
    data = await postToken({
      client_id: env.GRAPH_CLIENT_ID,
      client_secret: env.GRAPH_CLIENT_SECRET,
      refresh_token: refresh,
      scope: graphScopes().join(' '),
      grant_type: 'refresh_token',
    });
  } catch (err) {
    // Distinguish "this connection is dead, ask for a reconnect" from a
    // transient failure we should just retry on the next send.
    if (DEAD_TOKEN_ERRORS.has((err as any)?.aadError)) {
      invalidateMailAccount(err instanceof Error ? err.message : String(err));
    }
    throw err;
  }

  // Azure rotates the refresh token on most redemptions; persist the new one so
  // the connection keeps rolling forward instead of ageing out.
  if (data.refresh_token && data.refresh_token !== refresh) updateRefreshToken(data.refresh_token);

  const ttl = Number(data.expires_in) || 3600;
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (ttl - 60) * 1000 };
  return cachedToken.value;
}

export type MailResult = { sent: boolean; error?: string };
// A file to attach. `content` is the raw bytes base64-encoded (works for both
// SMTP/nodemailer and Graph's fileAttachment.contentBytes).
export type MailAttachment = { filename: string; content: string; contentType?: string };

type Recipient = { email: string; name?: string };

// --- SMTP transport (any transactional provider) -----------------------------
// Built once and reused. Sends as env.MAIL_FROM (e.g. no-reply@cybills.sg).
let smtpTransport: nodemailer.Transporter | null = null;
function transporter(): nodemailer.Transporter {
  if (!smtpTransport) {
    smtpTransport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE, // true=465 implicit TLS; false=587 STARTTLS
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }
  return smtpTransport;
}

const addr = (r: Recipient) => (r.name ? `${r.name} <${r.email}>` : r.email);

async function sendViaSmtp(
  msg: { subject: string; html: string; cc?: Recipient[]; attachments?: MailAttachment[] },
  to: Recipient[]
): Promise<MailResult> {
  try {
    await transporter().sendMail({
      from: env.MAIL_FROM_NAME ? `${env.MAIL_FROM_NAME} <${env.MAIL_FROM}>` : env.MAIL_FROM,
      to: to.map(addr),
      ...(msg.cc?.length ? { cc: msg.cc.map(addr) } : {}),
      ...(env.MAIL_REPLY_TO ? { replyTo: env.MAIL_REPLY_TO } : {}),
      subject: msg.subject,
      html: msg.html,
      ...(msg.attachments?.length
        ? { attachments: msg.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content, 'base64'), contentType: a.contentType })) }
        : {}),
    });
    return { sent: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[mailer] SMTP send failed:', detail);
    return { sent: false, error: detail };
  }
}

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
  attachments?: MailAttachment[];
}): Promise<MailResult> {
  const to = Array.isArray(msg.to) ? msg.to : [msg.to];
  if (!to.length || !to.every((r) => r.email)) return { sent: false, error: 'no_recipient' };

  // SMTP takes priority when configured — no interactive connect step needed.
  if (smtpConfigured) return sendViaSmtp(msg, to);

  if (!mailConfigured) return { sent: false, error: 'mail_not_configured' };
  if (!isMailConnected()) return { sent: false, error: 'mail_not_connected' };

  try {
    const token = await accessToken();
    // Delegated auth sends as the connected user (/me). A shared sender is
    // addressed explicitly, which Mail.Send.Shared + "Send As" allows.
    const endpoint = env.GRAPH_SHARED_SENDER
      ? `${GRAPH}/users/${encodeURIComponent(env.GRAPH_SHARED_SENDER)}/sendMail`
      : `${GRAPH}/me/sendMail`;
    const res = await fetch(endpoint, {
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
          ...(msg.attachments?.length
            ? {
                attachments: msg.attachments.map((a) => ({
                  '@odata.type': '#microsoft.graph.fileAttachment',
                  name: a.filename,
                  contentType: a.contentType || 'application/octet-stream',
                  contentBytes: a.content,
                })),
              }
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
    // 403 on a delegated send means the consented scopes don't cover this
    // mailbox — typically a shared sender without Mail.Send.Shared or Send As.
    if (res.status === 403 && env.GRAPH_SHARED_SENDER) {
      return { sent: false, error: `${detail} (check Send As rights on ${env.GRAPH_SHARED_SENDER} and the Mail.Send.Shared consent)` };
    }
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
export function inviteEmail(o: {
  name: string;
  url: string;
  inviterName?: string;
  expiresInDays: number;
  orgName?: string;
  message?: string;
}) {
  const org = esc(o.orgName || 'CY Business Management');
  const from = o.inviterName ? `${esc(o.inviterName)} has invited you` : 'You have been invited';
  // Use the admin's custom message when provided (different orgs word it their
  // own way); otherwise the default, addressed to the actual organisation.
  const body = o.message
    ? `<p style="margin:0">${esc(o.message)}</p>`
    : `<p style="margin:0">${from} to join <strong>CYBills</strong>, the billing workspace for ${org}.</p>
       <p style="margin:14px 0 0">Set your password to activate your account and sign in.</p>`;
  return {
    subject: 'You have been invited to CYBills',
    html: layout({
      heading: `Hi ${esc(o.name.split(' ')[0] || 'there')},`,
      body,
      cta: { label: 'Set your password', url: o.url },
      footnote: `This link expires in ${o.expiresInDays} days and can only be used once. If you weren&rsquo;t expecting this invitation you can ignore this email.`,
    }),
  };
}

// Sent to a claimant's direct manager when their claim is submitted for approval
// or updated with a new item (so the total changed and needs a re-review).
export function approvalRequestEmail(o: {
  approverName: string;
  claimantName: string;
  claimName: string;
  total: string;
  currency: string;
  url: string;
  updated: boolean;
}) {
  const action = o.updated
    ? 'was updated with a new item and needs your review'
    : 'has been submitted for your approval';
  return {
    subject: o.updated
      ? `Expense claim updated — ${o.claimantName}`
      : `Expense claim to approve — ${o.claimantName}`,
    html: layout({
      heading: `Hi ${esc(o.approverName.split(' ')[0] || 'there')},`,
      body: `<p style="margin:0"><strong>${esc(o.claimantName)}</strong>&rsquo;s expense claim${o.claimName ? ` &ldquo;${esc(o.claimName)}&rdquo;` : ''} ${action}.</p>
             <p style="margin:14px 0 0">Total: <strong>${esc(o.currency)} ${esc(o.total)}</strong>. Open it in CYBills to approve or reject.</p>`,
      cta: { label: 'Review the claim', url: o.url },
      footnote: 'You are the direct manager for this claimant, so their claims come to you for approval.',
    }),
  };
}

// Sent to the claimant when their direct manager approves or rejects the claim.
export function claimDecisionEmail(o: {
  claimantName: string;
  claimName: string;
  decision: 'approved' | 'rejected' | 'reopened';
  deciderName: string;
  reason?: string;
  url: string;
}) {
  const approved = o.decision === 'approved';
  const label = o.decision;
  const claim = o.claimName ? ` &ldquo;${esc(o.claimName)}&rdquo;` : '';
  const reasonBlock =
    !approved && o.reason
      ? `<p style="margin:14px 0 0"><strong>Reason:</strong> ${esc(o.reason)}</p>`
      : '';
  // A reopened claim is back with its approver: nothing was rejected, and
  // nothing is asked of the claimant — but they were told it was approved, and
  // would otherwise be waiting on money that has stopped moving.
  const next = approved
    ? '<p style="margin:14px 0 0">No action needed — it moves on for payment.</p>'
    : o.decision === 'reopened'
      ? '<p style="margin:14px 0 0">It is back awaiting approval while the items are corrected, and will be approved again once they are.</p>'
      : '<p style="margin:14px 0 0">You can edit the items and re-submit it for approval.</p>';
  return {
    subject: `Expense claim ${label} — ${o.claimantName}`,
    html: layout({
      heading: `Hi ${esc(o.claimantName.split(' ')[0] || 'there')},`,
      body: `<p style="margin:0">Your expense claim${claim} was <strong>${label}</strong> by ${esc(o.deciderName)}.</p>${reasonBlock}${next}`,
      cta: { label: 'Open the claim', url: o.url },
      footnote: 'You are receiving this because you are the claimant on this expense claim.',
    }),
  };
}

// Sends a copy of an expense claim (CSV + PDF attached) to any recipient the
// user names — e.g. mailing the claim to a bookkeeper or approver outside CYBills.
export function claimShareEmail(o: {
  fromName: string;
  toName: string;
  claimName: string;
  claimFor: string;
  currency: string;
  total: string;
  message?: string;
}) {
  const claim = o.claimName ? ` &ldquo;${esc(o.claimName)}&rdquo;` : '';
  const note = o.message ? `<p style="margin:18px 0 0;white-space:pre-wrap">${esc(o.message)}</p>` : '';
  return {
    subject: `Expense claim — ${o.claimFor || o.claimName || 'CYBills'}`,
    html: layout({
      heading: `Hi ${esc(o.toName.split(' ')[0] || 'there')},`,
      body: `<p style="margin:0"><strong>${esc(o.fromName)}</strong> shared an expense claim${claim} with you${o.claimFor ? ` for <strong>${esc(o.claimFor)}</strong>` : ''}.</p>
             <p style="margin:14px 0 0">Total: <strong>${esc(o.currency)} ${esc(o.total)}</strong>. The CSV and PDF are attached to this email.</p>${note}`,
      footnote: 'The attached files were generated by CYBills at the time this email was sent.',
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

// Sent by Settings > Email → "Send test email". Proves consent, scopes and (for
// a shared sender) Send As all line up, without waiting for a real invitation.
export function testEmail(o: { name: string; sender: string }) {
  return {
    subject: 'CYBills test email',
    html: layout({
      heading: 'Email is working',
      body: `<p style="margin:0">This is a test message from CYBills, sent as <strong>${esc(o.sender)}</strong>.</p>
             <p style="margin:14px 0 0">Invitations, password resets and password-changed notices will arrive from this address.</p>`,
      footnote: 'Sent from Settings &rarr; Email. Nobody else received this message.',
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
