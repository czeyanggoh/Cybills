import { Router } from 'express';
import { workspaceId, actor } from './workspace.js';
import { getClaimById } from './claims.js';
import {
  sendMail,
  isEmailConfigured,
  missingEmailEnvVars,
  assertAttachmentsFit,
  EmailNotConfiguredError,
  EmailSendError,
  EmailAttachmentTooLargeError,
  type EmailAttachment,
} from './email.js';
import {
  buildClaimSummaryHtml,
  claimSummarySubject,
  claimCsvAttachment,
  type ClaimDetailLevel,
} from './claimEmail.js';

// Outbound transactional email, mounted at /api/email. Sends as the shared
// VA01@cy-bm.sg mailbox via Microsoft Graph (see email.ts + the runbook in
// docs/transactional-email.md).
//
// These routes accept STRUCTURED input only — a claim id, a recipient, a
// detail level. The HTML body is rendered server-side by claimEmail.ts with
// every value escaped. There is deliberately no endpoint that accepts an
// htmlBody from the client: VA01 is a trusted internal sender, and an open
// relay on it would be a phishing vector.

export const emailRouter = Router();

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const isEmail = (v: unknown): v is string => typeof v === 'string' && EMAIL_RE.test(v.trim());

/** Parse a cc field that may arrive as a string, a comma-separated list, or an array. */
function parseRecipients(value: unknown): { valid: string[]; invalid: string[] } {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,;]/)
      : [];
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const entry of raw) {
    const s = String(entry ?? '').trim();
    if (!s) continue;
    if (isEmail(s)) valid.push(s);
    else invalid.push(s);
  }
  return { valid, invalid };
}

// GET /api/email/status — lets the client decide up front whether to offer
// "Send" or fall straight to the Copy fallback. Never leaks secret VALUES,
// only the NAMES of vars that still need setting.
emailRouter.get('/status', (_req, res) => {
  res.json({ enabled: isEmailConfigured(), missing: missingEmailEnvVars() });
});

// POST /api/email/claim/:id — email an expense-claim summary (call-site
// convention B: mail is the deliverable, so configuration is checked up front
// and the typed errors map to distinct HTTP statuses).
//
// Body: { toName, toEmail, cc?, message?, detailLevel?: 'summary'|'items',
//         attachCsv?: boolean }
emailRouter.post('/claim/:id', async (req, res) => {
  if (!isEmailConfigured()) {
    return res.status(503).json({
      error: 'email_not_configured',
      message: `Email is not configured on the server (missing ${missingEmailEnvVars().join(
        ', '
      )}). Use the Copy button to draft it in Outlook instead.`,
    });
  }

  const body = req.body ?? {};
  const toEmail = String(body.toEmail ?? '').trim();
  if (!isEmail(toEmail)) {
    return res.status(400).json({ error: 'invalid_recipient', message: 'A valid recipient email is required.' });
  }

  const cc = parseRecipients(body.cc);
  if (cc.invalid.length > 0) {
    return res.status(400).json({
      error: 'invalid_recipient',
      message: `Not a valid email address: ${cc.invalid.join(', ')}.`,
    });
  }

  // The claim comes from the store, not the request — the client sends an id,
  // never the rows to render.
  const ws = workspaceId(req);
  const claim = getClaimById(ws, req.params.id);
  if (!claim) return res.status(404).json({ error: 'not_found' });

  const detailLevel: ClaimDetailLevel = body.detailLevel === 'items' ? 'items' : 'summary';
  const me = actor(req);
  const senderName = String(body.senderName ?? '').trim() || me.name || 'CYBills';
  // Cap the free-text note so one request can't push a multi-megabyte body at
  // Graph. It is escaped at render time either way.
  const message = String(body.message ?? '').slice(0, 4000);

  const attachments: EmailAttachment[] = body.attachCsv === false ? [] : [claimCsvAttachment(claim, detailLevel)];

  // Graph caps the whole message at ~4 MB; check before calling so the user
  // gets a clear error rather than an opaque Graph rejection.
  try {
    assertAttachmentsFit(attachments);
  } catch (err) {
    if (err instanceof EmailAttachmentTooLargeError) {
      return res.status(413).json({ error: err.code, message: err.message });
    }
    throw err;
  }

  const htmlBody = buildClaimSummaryHtml({ claim, toName: String(body.toName ?? '').trim(), message, detailLevel, senderName });

  try {
    const result = await sendMail({
      to: toEmail,
      cc: cc.valid.length > 0 ? cc.valid : undefined,
      subject: claimSummarySubject(claim),
      htmlBody,
      attachments,
      // Replies go back to the person who pressed Send, not the shared mailbox.
      replyTo: isEmail(me.email) ? me.email : undefined,
    });
    return res.json({ data: { sent: true, status: result.status, to: toEmail } });
  } catch (err) {
    if (err instanceof EmailNotConfiguredError) {
      return res.status(503).json({ error: 'email_not_configured', message: err.message });
    }
    if (err instanceof EmailSendError) {
      // Loud in the logs (full Graph status + body), short sentence in the UI.
      console.error('[cybills/email] graph send failed:', err.status, err.body);
      return res.status(502).json({ error: 'email_send_failed', status: err.status, message: err.message });
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cybills/email] unexpected error:', msg);
    return res.status(500).json({ error: 'unexpected_error', message: msg });
  }
});
