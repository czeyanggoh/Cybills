import { Router } from 'express';
import { createHash } from 'node:crypto';
import { userByEmailHandle, setPendingForward } from './users.js';
import { insertBill } from './store.js';
import { putBillFile } from './storage.js';

// Inbound email ("Extract by email"). A Cloudflare Email Worker (catch-all on
// the mail domain) POSTs each received message here — one general pipe for every
// user address, so no per-user mailbox is created. The recipient's local-part is
// the user handle; the message is either a Gmail forwarding confirmation (held
// for the user to click) or a bill to file under that user.
//
// Protected by a shared secret (X-Inbound-Secret == INBOUND_SECRET); until that
// env is set the endpoint 503s, so deploys are safe before the Worker exists.
export const inboundRouter = Router();

const IMAGE_OR_PDF = /pdf|png|jpe?g|gif|webp|tiff?|heic/i;

// Pull the Gmail forwarding-confirmation link (and numeric code, if any) out of
// a Google confirmation email. Returns null when this isn't one.
function parseForwardConfirmation(from: string, subject: string, body: string) {
  const isGoogle =
    /forwarding-noreply@google\.com/i.test(from) ||
    (/confirm/i.test(subject) && /forward/i.test(subject));
  const urlMatch = body.match(/https:\/\/mail-settings\.google\.com\/mail\/[^\s"'<>]+/i);
  const codeMatch = body.match(/\b(\d{6,})\b/); // Gmail's numeric confirmation code
  if (!isGoogle && !urlMatch) return null;
  return { url: urlMatch ? urlMatch[0] : '', code: codeMatch ? codeMatch[1] : '' };
}

inboundRouter.post('/email', async (req, res) => {
  const secret = process.env.INBOUND_SECRET || '';
  if (!secret) return res.status(503).json({ error: 'inbound_not_configured' });
  if ((req.header('X-Inbound-Secret') || '') !== secret) return res.status(401).json({ error: 'unauthorized' });

  const b = req.body ?? {};
  const to = String(b.to || '');
  const from = String(b.from || '');
  const subject = String(b.subject || '');
  const body = `${String(b.text || '')}\n${String(b.html || '')}`;

  // Local-part of the recipient = the user handle (minus any +suffix).
  const local = (to.split('@')[0] || to).trim();
  const user = userByEmailHandle(local);
  if (!user) return res.status(404).json({ error: 'unknown_recipient', to });

  // A Gmail forwarding confirmation: hold the link for the user to click in the
  // app rather than filing it as a bill.
  const conf = parseForwardConfirmation(from, subject, body);
  if (conf && (conf.url || conf.code)) {
    setPendingForward(user.id, { url: conf.url, code: conf.code, from });
    return res.json({ ok: true, kind: 'forwarding_confirmation', user: user.id });
  }

  // Otherwise file each PDF/image attachment as a cost document owned by the user.
  const atts = Array.isArray(b.attachments) ? b.attachments : [];
  const orgId = user.organisationId || '';
  let created = 0;
  for (const a of atts) {
    const filename = String(a?.filename || 'document');
    const contentType = String(a?.contentType || '');
    const base64 = typeof a?.contentBase64 === 'string' ? a.contentBase64 : '';
    if (!base64) continue;
    if (!IMAGE_OR_PDF.test(contentType) && !IMAGE_OR_PDF.test(filename)) continue;
    const bytes = Buffer.from(base64, 'base64');
    const fileHash = createHash('sha256').update(bytes).digest('hex');
    let storageKey = '';
    let storedType = '';
    try {
      const stored = await putBillFile(orgId, fileHash, contentType, bytes);
      storageKey = stored.storageKey;
      storedType = stored.contentType;
    } catch {
      // Keep the metadata record even if the file store fails.
    }
    insertBill({
      orgId,
      fileHash,
      fileName: filename,
      supplier: '',
      invoiceNumber: '',
      documentType: '',
      currency: '',
      total: 0,
      tax: 0,
      date: '',
      category: '',
      createdBy: user.email,
      owner: user.email,
      storageKey,
      contentType: storedType,
      status: 'new',
      kind: 'cost',
    });
    created += 1;
  }
  return res.json({ ok: true, kind: 'documents', created, user: user.id });
});
