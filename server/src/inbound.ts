import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { loadCollection, saveCollection } from './jsonStore.js';
import type { Request } from 'express';
import { userByEmailHandle, setPendingForward, memberForSession, isAdminRole } from './users.js';
import { dataScopeForOrg } from './organisations.js';
import { insertBill, updateBill, reconcileReadiness } from './store.js';
import { putBillFile } from './storage.js';
import { readDocument, resolveProvider, type Provider } from './llm.js';
import { recordUsage } from './usage.js';
import { readSetting } from './settings.js';
import { workspaceId } from './workspace.js';
import { visionEnabled, claudeEnabled, openaiEnabled } from './env.js';

// The core fields to fill an emailed document's inbox row. Kept simple (no
// per-org account/tax-code guides) so this runs without the client's Xero
// context; the reviewer or a supplier rule sets the account code, exactly as
// happens for an upload the reader couldn't fully classify.
const BASIC_SCHEMA = {
  type: 'object',
  properties: {
    supplier: { type: 'string', description: 'The merchant / supplier / seller name (who was PAID), not the bill-to / customer' },
    date: { type: 'string', description: 'Document date as ISO YYYY-MM-DD when determinable, else empty' },
    total: { type: 'string', description: 'The grand total / amount payable / total paid, as digits only e.g. 41.60. Read it off the document; use the largest final amount if several are shown.' },
    tax: { type: 'string', description: 'GST/tax amount as digits, 0 if none printed' },
    currency: { type: 'string', description: 'ISO currency code, e.g. SGD' },
    invoiceNumber: { type: 'string', description: 'Invoice / receipt / reference number' },
    documentType: { type: 'string', description: 'Invoice or Receipt' },
    description: { type: 'string', description: 'One-line summary of what was purchased' },
  },
} as const;

const norm = (s: string) => String(s ?? '').trim().toLowerCase();

// The standing rule for a supplier NAME from the per-org rules blob, matched
// case-insensitively (same as the client's matchSupplierRule).
function supplierRuleFor(ws: string, orgId: string, supplier: string): Record<string, string> | null {
  if (!supplier) return null;
  const map = readSetting<Record<string, Record<string, string>>>(ws, 'cybills.supplier.rules.v1', orgId) || {};
  const key = Object.keys(map).find((k) => norm(k) === norm(supplier));
  return key ? map[key] : null;
}

const toNum = (v: unknown) => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// Read an emailed document and fill its fields, then re-derive ready vs inbox.
// Best-effort and fire-and-forget: a missing reader key or a failed read simply
// leaves the document unread in the inbox (the reviewer can Re-read by hand).
// Providers to attempt, org's choice first then the other enabled one, so a
// read that a mis-set default or one flaky provider would fail still succeeds.
function readerOrder(preferred: Provider): Provider[] {
  const order: Provider[] = [];
  if (preferred === 'openai' && openaiEnabled) order.push('openai');
  if (preferred === 'claude' && claudeEnabled) order.push('claude');
  if (openaiEnabled && !order.includes('openai')) order.push('openai');
  if (claudeEnabled && !order.includes('claude')) order.push('claude');
  return order;
}

async function autoRead(req: Request, orgId: string, preferred: Provider, billId: string, fileBase64: string, mediaType: string) {
  if (!visionEnabled) return;
  const isPdf = /pdf/i.test(mediaType);
  const prompt = `Extract the purchase/expense details from this ${isPdf ? 'invoice/receipt PDF' : 'receipt or invoice image'}. Today is ${new Date().toISOString().slice(0, 10)}.`;
  let lastNote = 'no reader available';
  for (const provider of readerOrder(preferred)) {
    try {
      const outcome = await readDocument({
        provider,
        fileBase64,
        mediaType,
        maxTokens: 1024,
        schemaName: 'inbound_document',
        schema: BASIC_SCHEMA as unknown as Record<string, unknown>,
        systemPrompt: 'You read receipts and invoices and return the requested fields. Use empty strings and 0 when a field is not present.',
        prompt,
      });
      recordUsage(req, { feature: 'inbound-extract', provider: outcome.provider, model: outcome.model, usage: outcome.usage });
      if (!outcome.ok || !outcome.json || typeof outcome.json !== 'object') {
        lastNote = `${provider}: ${outcome.ok ? 'empty response' : outcome.reason}`;
        continue; // try the next provider
      }
      const j = outcome.json as Record<string, unknown>;
      const supplier = String(j.supplier || '');
      const patch: Record<string, unknown> = {
        supplier,
        date: String(j.date || ''),
        total: toNum(j.total),
        tax: toNum(j.tax),
        currency: String(j.currency || ''),
        invoiceNumber: String(j.invoiceNumber || ''),
        documentType: String(j.documentType || ''),
        description: String(j.description || ''),
      };
      // Apply the supplier's standing rule, exactly as an upload does — a rule is
      // an instruction, so it fills the account code the basic read can't choose.
      const rule = supplierRuleFor(workspaceId(req), orgId, supplier);
      if (rule) {
        if (rule.category) { patch.category = rule.category; patch.categoryReason = `Standing rule: documents from ${supplier} are coded ${rule.category}.`; }
        if (rule.customer) patch.customer = rule.customer;
        if (rule.project) patch.project = rule.project;
        if (rule.taxRate) patch.taxRate = rule.taxRate;
        if (rule.currency && !patch.currency) patch.currency = rule.currency;
      }
      updateBill(orgId, billId, patch);
      reconcileReadiness(orgId, billId);
      return; // success
    } catch (e) {
      console.error('[inbound] auto-read failed', provider, e);
      lastNote = `${provider}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`;
    }
  }
  // Every provider failed — leave a breadcrumb the reviewer (and we) can see,
  // since a background read has nowhere else to report to.
  updateBill(orgId, billId, { categoryReason: `Auto-read didn't complete (${lastNote}). Use Re-read.` });
}

// The shared secret the Cloudflare Worker signs its POSTs with. Prefer an env
// override (INBOUND_SECRET); otherwise CYBills generates one on first use and
// persists it to the data dir, so an admin can read it from the app and paste it
// into the Worker WITHOUT any server/VPS access.
type InboundConfig = { id: string; secret: string };
function getInboundSecret(): string {
  const fromEnv = (process.env.INBOUND_SECRET || '').trim();
  if (fromEnv) return fromEnv;
  const items = loadCollection<InboundConfig>('inbound-config');
  const existing = items.find((x) => x.id === 'default');
  if (existing?.secret) return existing.secret;
  const secret = randomBytes(24).toString('hex');
  saveCollection('inbound-config', [{ id: 'default', secret }]);
  return secret;
}

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

// GET /api/inbound/config — the webhook URL + shared secret + mail domain, for an
// admin to copy into the Cloudflare Worker. Business/User Admins only; goes
// through the normal session auth (only /email is allowlisted for the Worker).
inboundRouter.get('/config', (req, res) => {
  const member = memberForSession(req);
  if (!member || !isAdminRole(member.role)) return res.status(403).json({ error: 'forbidden' });
  const origin = (process.env.APP_ORIGIN || '').replace(/\/$/, '');
  res.json({
    url: `${origin}/api/inbound/email`,
    secret: getInboundSecret(),
    domain: process.env.INBOUND_MAIL_DOMAIN || 'cybills.sg',
  });
});

inboundRouter.post('/email', async (req, res) => {
  const secret = getInboundSecret();
  if (!secret) return res.status(503).json({ error: 'inbound_not_configured' });
  if ((req.header('X-Inbound-Secret') || '') !== secret) return res.status(401).json({ error: 'unauthorized' });

  const b = req.body ?? {};
  const to = String(b.to || '');
  let from = String(b.from || '');
  let subject = String(b.subject || '');
  let text = String(b.text || '');
  let html = String(b.html || '');
  // Attachments the caller may pass pre-parsed: { filename, contentType, contentBase64 }.
  let atts: Array<{ filename: string; contentType: string; contentBase64: string }> =
    Array.isArray(b.attachments) ? b.attachments : [];

  // Preferred path: the Worker forwards the RAW MIME (base64). Parse it here with
  // a real library — robust against Gmail's nested multipart and encodings, and
  // testable, unlike an inline Worker parser.
  if (typeof b.raw === 'string' && b.raw) {
    try {
      const parsed = await simpleParser(Buffer.from(b.raw, 'base64'));
      subject = parsed.subject || subject;
      from = parsed.from?.value?.[0]?.address || from;
      text = parsed.text || text;
      html = typeof parsed.html === 'string' ? parsed.html : html;
      atts = (parsed.attachments || []).map((a) => ({
        filename: a.filename || 'document',
        contentType: a.contentType || '',
        contentBase64: a.content ? Buffer.from(a.content).toString('base64') : '',
      }));
    } catch (e) {
      console.error('[inbound] MIME parse failed', e);
    }
  }
  const body = `${text}\n${html}`;

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
  // Map to the same data scope uploads use: the primary org (CYBM) folds to the
  // legacy WORKSPACE_ID scope, so an emailed doc lands in the inbox the user sees.
  const orgId = dataScopeForOrg(user.organisationId || '');
  const madeBills: Array<{ id: string; base64: string; mediaType: string }> = [];
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
    const bill = insertBill({
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
    madeBills.push({ id: bill.id, base64, mediaType: storedType || contentType });
  }

  // Read with the org's chosen reader (Claude / OpenAI), the same one the manual
  // re-read uses — not the deploy default, which may not be the org's working key.
  const settings = readSetting<{ readerProvider?: string }>(workspaceId(req), 'cybills.extraction-settings.v1', orgId);
  const provider = resolveProvider(settings?.readerProvider);

  // Answer the Worker straight away, then read each document in the background —
  // a model call takes 10-30s and the Worker shouldn't wait on it.
  res.json({ ok: true, kind: 'documents', created: madeBills.length, user: user.id });
  for (const b of madeBills) void autoRead(req, orgId, provider, b.id, b.base64, b.mediaType);
});
