import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { loadCollection, saveCollection } from './jsonStore.js';
import type { Request } from 'express';
import { userByEmailHandle, setPendingForward, memberForSession } from './users.js';
import { dataScopeForOrg, primaryOrgId } from './organisations.js';
import { accountsForOrg, projectOptionsForOrg, customerOptionsForOrg } from './xero.js';
import { decideTaxRate, taxContextFor, EMPTY_TAX_CONTEXT } from './taxRules.js';
import { insertBill, updateBill, reconcileReadiness } from './store.js';
import { putBillFile } from './storage.js';
import { resolveProvider, type Provider } from './llm.js';
import { runExtraction, emailInstruction } from './extract.js';
import { categoriesForOrg } from './categories.js';
import { recordUsage } from './usage.js';
import { readSetting } from './settings.js';
import { workspaceId } from './workspace.js';
import { visionEnabled, claudeEnabled, openaiEnabled, googleEnabled } from './env.js';

const norm = (s: string) => String(s ?? '').trim().toLowerCase();

// The standing rule for a supplier NAME from the per-org rules blob, matched
// case-insensitively (same as the client's matchSupplierRule).
function supplierRuleFor(ws: string, orgId: string, supplier: string): Record<string, string> | null {
  if (!supplier) return null;
  const map = readSetting<Record<string, Record<string, string>>>(ws, 'cybills.supplier.rules.v1', orgId) || {};
  const key = Object.keys(map).find((k) => norm(k) === norm(supplier));
  return key ? map[key] : null;
}

// The Xero chart of accounts, tax-code rules, project list and review
// instructions for one org — the SAME inputs the browser assembles and sends
// on an upload (src/lib/bills.js → fetchExtract), gathered here server-side so
// an emailed document is read exactly the way an uploaded one is. Never throws:
// a missing Xero key or an unreachable relay yields empty lists, so the read
// still runs (just without account classification) rather than failing.
type ListsBlob = {
  hidden?: Record<string, unknown>;
  added?: Record<string, unknown>;
  meta?: Record<string, Record<string, { rules?: string }>>;
};
const asStrArray = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)) : []);
const EXPENSE_TYPES = new Set(['EXPENSE', 'OVERHEADS', 'DIRECTCOSTS']);

async function extractionInputsFor(ws: string, realOrgId: string) {
  const lists = (readSetting<ListsBlob>(ws, 'cybills.lists.v1', realOrgId) || {}) as ListsBlob;

  // Chart of accounts: expense accounts first, honouring any category hidden in
  // Lists — exactly what getExtractionAccounts does for an upload.
  const hiddenCats = new Set(asStrArray(lists?.hidden?.categories));
  const accountsRaw = await accountsForOrg(ws, realOrgId);
  const shown = accountsRaw.filter((a) => !hiddenCats.has(a.code || a.name));
  const expense = shown.filter((a) => EXPENSE_TYPES.has(String(a.type).toUpperCase()));
  const usable = expense.length ? expense : shown;
  const accounts = usable.map((a) => ({ code: a.code, name: a.name, description: a.description || '' }));

  // A bridge entity has no chart at all, so the reader is given the plain names
  // its people actually claim against instead ("Transport - Taxi"). Empty for a
  // linked entity, whose accounts above are the list.
  const categories = await categoriesForOrg(ws, realOrgId);

  // The rates, chart and registration the tax decision needs — assembled in one
  // shared place so the emailed document is coded exactly as an uploaded one is.
  const taxCtx = await taxContextFor(ws, realOrgId);

  // Tax codes the org wrote a "when to use" rule for (Lists → Tax rates); a rate
  // with no rule is the arithmetic fallback's job, not the reader's.
  const taxMeta = (lists?.meta?.taxRates || {}) as Record<string, { rules?: string }>;
  const taxRates = Object.entries(taxMeta)
    .filter(([, v]) => String(v?.rules || '').trim())
    .map(([name, v]) => ({ name, code: '', rate: 0, rules: String(v.rules).trim() }));

  // The org's project (first Xero tracking category) options, each with whatever
  // rule the org wrote — the list getExtractionProjects builds for an upload.
  const projMeta = (lists?.meta?.projects || {}) as Record<string, { rules?: string }>;
  const projectNames = await projectOptionsForOrg(ws, realOrgId);
  const projects = projectNames.map((name) => ({ name, rules: String(projMeta[name]?.rules || '').trim() }));

  // Who a cost can be recharged to. Mostly used by the covering message — a
  // taxi receipt says nothing about who it is billed back to, and "recharge
  // this to CY-Biz" says everything.
  const customers = await customerOptionsForOrg(ws, realOrgId);

  // Review instructions (business overview + GST/coding rules). Keyed
  // `cybills.review-instructions.<orgId>`; readSetting's exact-key fallback finds it.
  const instructions = readSetting<string>(ws, `cybills.review-instructions.${realOrgId || 'default'}`) || '';

  return { accounts, categories, customers, taxCtx, taxRates, projects, instructions };
}

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

// Read an emailed document through the FULL extraction pipeline (the same
// runExtraction an upload uses — chart of accounts, tax-code rules, projects,
// review instructions), then re-derive ready vs inbox. Best-effort and
// fire-and-forget: a failed read leaves a breadcrumb the reviewer can act on.
//   scope     — the bills-store scope the document was filed under.
//   realOrgId — the organisation record id, for its settings + Xero context.
// Lay the supplier's standing rule over what the read produced.
//
// A rule normally wins: it is an explicit instruction, where the read is the
// model's best answer. EXCEPT where the person who emailed the document said
// otherwise — a rule is a policy about every document from that supplier
// ("everything from Grab is travel"), a covering note is one person's
// instruction about THIS one ("recharge this to CY-Biz"), and the specific,
// deliberate, just-written instruction has to win or writing it was pointless.
//
// `noteFollowed` is empty unless the reader actually took something from the
// note, so an emailed document whose message says nothing about coding still
// follows the rule. The money is never up for negotiation: a note cannot
// restate a total, and the tax code follows the account either way.
export function overlaySupplierRule(
  patch: Record<string, unknown>,
  rule: Record<string, string> | null,
  ctx: { supplier?: string; noteFollowed?: string; via?: string }
): void {
  const noteDecided = Boolean(String(ctx.noteFollowed || '').trim());
  if (rule) {
    if (rule.category && !(noteDecided && patch.category)) {
      patch.category = rule.category;
      patch.categoryReason = `Standing rule: documents from ${ctx.supplier || 'this supplier'} are coded ${rule.category}.`;
    }
    if (rule.customer && !(noteDecided && patch.customer)) patch.customer = rule.customer;
    if (rule.project && !(noteDecided && patch.project)) patch.project = rule.project;
    if (rule.taxRate) patch.taxRate = rule.taxRate;
    if (rule.currency && !patch.currency) patch.currency = rule.currency;
  }
  if (noteDecided) {
    // Name the thing the reviewer can go and read. A covering note arrives by
    // email or in a WhatsApp collection group, and "the email that sent this"
    // sends somebody looking through a mailbox for a message that was never
    // there.
    const where = ctx.via === 'whatsapp' ? 'the WhatsApp message' : 'the email';
    patch.categoryReason = `From ${where} that sent this: ${String(ctx.noteFollowed).trim()}`;
  }
}

// Exported because a document can arrive by more than one road and they all end
// here: the email pipe below, and the WhatsApp collection groups
// (whatsapp.ts). Both file a document and then have it read with the covering
// note it came with, and running two copies of that would be running two sets
// of coding rules.
export async function autoRead(req: Request, scope: string, realOrgId: string, preferred: Provider, billId: string, fileBase64: string, mediaType: string, envelope: { from?: string; subject?: string; text?: string; via?: string } | null = null) {
  if (!visionEnabled) return;
  const ws = workspaceId(req);
  let inputs: Awaited<ReturnType<typeof extractionInputsFor>>;
  try {
    inputs = await extractionInputsFor(ws, realOrgId);
  } catch (e) {
    console.error('[inbound] could not assemble extraction inputs', e);
    inputs = { accounts: [], categories: [], customers: [], taxCtx: EMPTY_TAX_CONTEXT, taxRates: [], projects: [], instructions: '' };
  }

  let lastNote = 'no reader available';
  for (const provider of readerOrder(preferred)) {
    const result = await runExtraction({
      provider,
      imageBase64: fileBase64,
      mediaType,
      accounts: inputs.accounts,
      categories: inputs.categories,
      customers: inputs.customers,
      taxRates: inputs.taxRates,
      projects: inputs.projects,
      instructions: `${inputs.instructions}${emailInstruction(envelope)}`,
    });
    if (result.outcome) {
      recordUsage(req, { feature: 'inbound-extract', provider: result.outcome.provider, model: result.outcome.model, usage: result.outcome.usage });
    }
    if (!result.ok) {
      lastNote = `${provider}: ${result.error}`;
      if (result.error === 'refused') break; // the reader saw it and declined — another won't differ
      continue; // try the next provider
    }
    const d = result.data;
    const patch: Record<string, unknown> = {
      supplier: d.supplier,
      date: d.date,
      documentType: d.documentType,
      invoiceNumber: d.invoiceNumber,
      currency: d.currency,
      total: d.total,
      tax: d.tax,
      category: d.category,
      categoryReason: d.categoryReason,
      description: d.description,
      dueDate: d.dueDate,
      period: d.period,
      cardLast4: d.cardLast4,
      // Who the document is made out to — read for one purpose: whether it was
      // filed under the right client entity. See server/src/tenantMatch.ts.
      billedTo: d.billedTo,
      supplierGstRegNo: d.supplierGstRegNo,
      taxLabel: d.taxLabel,
      // Only when the reader picked one from the org's own list — an empty
      // string here would blank a customer somebody had set by hand.
      ...(d.customer ? { customer: d.customer, rebillable: Boolean(d.rebillable) } : {}),
      // Only when the reader actually picked one, from a rule the org wrote.
      // Writing an empty string here would look exactly like a person choosing
      // "no code", and the tax decision below (or the listing's backfill) would
      // then leave the document blank for good.
      ...(d.taxRate ? { taxRate: d.taxRate, taxRateReason: d.taxRateReason } : {}),
      project: d.project,
      projectReason: d.projectReason,
      lineItems: d.lineItems,
    };
    // The tax code, decided by the same rules an upload runs — the reader only
    // names one when a written "when to use" rule plainly matched, and every
    // other case (including the ordinary "no GST printed" receipt, which is most
    // emailed ones) is settled here. Without this an emailed document reached
    // the inbox with its Tax rate cell simply blank.
    const outcome = await decideTaxRate(inputs.taxCtx, d);
    if (outcome) {
      // Only ever a REAL code. An empty string is indistinguishable from a
      // person choosing "no code", and would freeze the document blank for
      // good — the whole reason the emailed documents stayed unset. Everything
      // below still applies: not being able to NAME the code doesn't change
      // whether the tax on the document may be claimed.
      if (outcome.name) patch.taxRate = outcome.name;
      // The reader writes its own reason when ITS rule matched; otherwise the
      // decision explains itself, including when the answer is "none" — a blank
      // field with no explanation is indistinguishable from a bug.
      if (outcome.reason) patch.taxRateReason = outcome.reason;
      // Tax that isn't claimable Singapore GST stays inside the cost: the amount
      // is not recorded as GST, and the total never changes.
      if (!outcome.claimsTax) patch.tax = 0;
    }

    // The supplier's standing rule overlays the read — a rule is an explicit
    // instruction, so it wins over the reader's guess (same precedence the
    // re-read path applies, src/lib/reRead.js).
    //
    // EXCEPT where the person who sent the document said otherwise. A rule is a
    // policy about every document from that supplier ("everything from Grab is
    // travel"); a covering note is one person's instruction about THIS one
    // ("recharge this to CY-Biz"). The specific, deliberate, just-written
    // instruction has to win, or writing it is pointless — and the reason says
    // which of the two was followed, so nobody has to guess.
    //
    // Only for the fields the note actually decided (`noteFollowed` is empty
    // unless the reader took something from it), and never for the money: a
    // note cannot restate a total.
    overlaySupplierRule(patch, supplierRuleFor(ws, realOrgId, d.supplier), {
      supplier: d.supplier,
      noteFollowed: d.noteFollowed,
      via: envelope?.via,
    });
    updateBill(scope, billId, patch);
    reconcileReadiness(scope, billId);
    return; // success
  }
  // Every provider failed — leave a breadcrumb the reviewer (and we) can see,
  // since a background read has nowhere else to report to.
  updateBill(scope, billId, { categoryReason: `Auto-read didn't complete (${lastNote}). Use Re-read.` });
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

// GET /api/inbound/config — the webhook URL + shared secret + mail domain, for
// whoever sets up the Cloudflare Worker.
//
// PRACTICE TEAM ONLY. This secret is not a per-entity setting: it authorises
// posting documents to the inbound endpoint for ANY user handle in ANY client
// entity, so a client's own Business Admin reading it could file documents into
// another client's books. It belongs to the deployment, and the deployment is
// the practice's. (Goes through the normal session auth — only /email is
// allowlisted, for the Worker itself.)
inboundRouter.get('/config', (req, res) => {
  const member = memberForSession(req);
  if (member && (!member.practice || member.deactivated)) {
    return res.status(403).json({ error: 'not_practice_team' });
  }
  if (!member && googleEnabled) return res.status(403).json({ error: 'forbidden' });
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
  let to = String(b.to || '');
  let from = String(b.from || '');
  let subject = String(b.subject || '');
  let text = String(b.text || '');
  let html = String(b.html || '');
  let sentAt = String(b.date || '');
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
      // The Worker's envelope recipient is the authority — it is who the mail
      // was actually delivered to. But a Worker that forwards only the raw MIME
      // sends no `to` at all, and the local-part IS how a document is filed, so
      // an empty one meant every such delivery answered "unknown recipient".
      if (!to) {
        const recipients = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
        to = recipients?.value?.[0]?.address || '';
      }
      sentAt = parsed.date ? parsed.date.toISOString() : sentAt;
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
  // Two org ids in play, and they differ for the primary entity:
  //   realOrgId — the organisation RECORD id, which its per-org settings and Xero
  //               tenant are keyed on (a colleague on no single entity files into
  //               the practice's own primary org).
  //   scope     — the bills-store scope. The primary org (CYBM) folds to the
  //               legacy WORKSPACE_ID scope, so an emailed doc lands in the inbox
  //               the user actually sees.
  const realOrgId = user.organisationId || primaryOrgId();
  const scope = dataScopeForOrg(realOrgId);
  // Attribute this document's API spend to its client entity on the Clients page
  // (recordUsage reads the X-Org-Id header; the Worker sends none).
  (req.headers as Record<string, string>)['x-org-id'] = realOrgId;
  // The covering message, stored on every document it delivered. The body is
  // capped: a forwarded thread can run to hundreds of lines, and what matters is
  // what the sender wrote at the top of it.
  const envelope = {
    from,
    to,
    subject,
    date: sentAt,
    text: String(text || '').trim().slice(0, 4000),
  };
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
      const stored = await putBillFile(scope, fileHash, contentType, bytes);
      storageKey = stored.storageKey;
      storedType = stored.contentType;
    } catch {
      // Keep the metadata record even if the file store fails.
    }
    const bill = insertBill({
      orgId: scope,
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
      email: envelope,
      storageKey,
      contentType: storedType,
      status: 'new',
      kind: 'cost',
    });
    madeBills.push({ id: bill.id, base64, mediaType: storedType || contentType });
  }

  // Read with the org's chosen reader (Claude / OpenAI), the same one the manual
  // re-read uses — not the deploy default, which may not be the org's working key.
  const settings = readSetting<{ readerProvider?: string }>(workspaceId(req), 'cybills.extraction-settings.v1', realOrgId);
  const provider = resolveProvider(settings?.readerProvider);

  // Answer the Worker straight away, then read each document in the background —
  // a model call takes 10-30s and the Worker shouldn't wait on it.
  res.json({ ok: true, kind: 'documents', created: madeBills.length, user: user.id });
  for (const b of madeBills) void autoRead(req, scope, realOrgId, provider, b.id, b.base64, b.mediaType, envelope);
});
