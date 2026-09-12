import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { loadCollection, saveCollection } from './jsonStore.js';
import type { Request } from 'express';
import { userByEmailHandle, generalUserByEmailSuffix, setPendingForward, memberForSession } from './users.js';
import { dataScopeForOrg, primaryOrgId } from './organisations.js';
import { accountsForOrg, projectOptionsForOrg, customerOptionsForOrg } from './xero.js';
import { decideTaxRate, splitForPrintedRate, taxContextFor, EMPTY_TAX_CONTEXT } from './taxRules.js';
import { withRememberedGstRegNo } from './supplierGst.js';
import { insertBill, updateBill, settleProcessing, getBillById, setBillEmailLink, attachFetchedFile } from './store.js';
import { readerMediaType, unreadableTypeNote } from './mediaType.js';
import { keepMileageInStep } from './mileage.js';
import { putBillFile } from './storage.js';
import { resolveProvider, type Provider } from './llm.js';
import { runExtraction } from './extract.js';
import { readGotNothing } from './blankRead.js';
import type { CoveringNote } from './extract.js';
import { categoriesForOrg } from './categories.js';
import { recordUsage } from './usage.js';
import { readSetting } from './settings.js';
import { workspaceId } from './workspace.js';
import { visionEnabled, claudeEnabled, openaiEnabled, googleEnabled } from './env.js';
import { fetchDocumentsForLinks, linksIn, n8nEnabled } from './n8n.js';
import { recordMail, recordLinkFetch, mailById, type MailAttachment, type MailDocument, type MailMessage } from './mailThread.js';
import { isTrustedSender, normaliseSender } from './trustedSenders.js';

const norm = (s: string) => String(s ?? '').trim().toLowerCase();

// The standing rule for a supplier NAME from the per-org rules blob, matched
// case-insensitively (same as the client's matchSupplierRule).
function supplierRuleFor(ws: string, orgId: string, supplier: string): Record<string, string> | null {
  if (!supplier) return null;
  const map = readSetting<Record<string, Record<string, string>>>(ws, 'cybills.supplier.rules.v1', orgId) || {};
  const key = Object.keys(map).find((k) => norm(k) === norm(supplier));
  return key ? map[key] : null;
}

// The reader's line rows as the document stores them — the same shape
// lineItemRows in src/lib/bills.js writes on an upload, so a row that arrived
// by email carries a net, a tax and a total the grid and the publish path can
// read. Stored raw ({description, amount}) they were rows worth nothing.
function lineItemRows(
  rows: Array<{ description?: string; amount?: number; net?: number; tax?: number; category?: string }>,
  fallbackCategory = ''
) {
  return rows.map((li) => {
    const total = li.amount != null ? Number(li.amount) : Number(li.net ?? 0) + Number(li.tax ?? 0);
    const tax = li.tax != null ? Number(li.tax) : 0;
    const net = li.net != null ? Number(li.net) : total - tax;
    return {
      description: li.description || '',
      category: li.category || fallbackCategory || 'Uncategorised',
      project: '',
      project2: '',
      net: net.toFixed(2),
      tax: tax.toFixed(2),
      total: total.toFixed(2),
    };
  });
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
type ReadEnd = 'read' | 'blank' | 'failed';

// Between the two attempts a thrown read gets. Short: the document is marked
// Processing for the whole of it.
const RETRY_DELAY_MS = Number(process.env.INBOUND_READ_RETRY_MS ?? 2000);

async function readIntoBill(req: Request, scope: string, realOrgId: string, preferred: Provider, billId: string, fileBase64: string, mediaType: string, envelope: CoveringNote | null = null): Promise<ReadEnd> {
  if (!visionEnabled) return 'failed';
  const ws = workspaceId(req);
  let inputs: Awaited<ReturnType<typeof extractionInputsFor>>;
  try {
    inputs = await extractionInputsFor(ws, realOrgId);
  } catch (e) {
    console.error('[inbound] could not assemble extraction inputs', e);
    inputs = { accounts: [], categories: [], customers: [], taxCtx: EMPTY_TAX_CONTEXT, taxRates: [], projects: [], instructions: '' };
  }

  // The type the reader is given is the one worked out from the bytes (see
  // mediaType.ts), and a file that is none of the five it takes is said so
  // HERE — a HEIC off an iPhone sent to the API as an image is refused with an
  // error that names the wrong cause.
  if (!readerMediaType(mediaType, envelope?.fileName)) {
    updateBill(scope, billId, { categoryReason: `Auto-read didn't complete (${unreadableTypeNote(mediaType, envelope?.fileName)}). Use Re-read.` });
    return 'failed';
  }

  let lastNote = 'no reader available';
  for (const provider of readerOrder(preferred)) {
    const read = () =>
      runExtraction({
        provider,
        imageBase64: fileBase64,
        mediaType,
        accounts: inputs.accounts,
        categories: inputs.categories,
        customers: inputs.customers,
        taxRates: inputs.taxRates,
        projects: inputs.projects,
        instructions: inputs.instructions,
        // The envelope itself, not a paragraph made from it: runExtraction adds
        // the note AND the file name, and has to be able to tell them apart.
        note: envelope,
      });
    let result = await read();
    // A read that THREW — the call never got an answer, as against one the
    // reader answered badly — is tried once more after a moment. The SDKs
    // retry a 429 or a 5xx of their own accord, so this only catches what
    // outlasted that: a dropped connection, a timeout. Nobody is watching this
    // road, so the second attempt here is the only one the document gets
    // until a person presses Re-read.
    if (!result.ok && result.error === 'extraction_failed') {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      result = await read();
    }
    if (result.outcome) {
      recordUsage(req, { feature: 'inbound-extract', provider: result.outcome.provider, model: result.outcome.model, usage: result.outcome.usage });
    }
    if (!result.ok) {
      lastNote = `${provider}: ${result.error}`;
      if (result.error === 'refused') break; // the reader saw it and declined — another won't differ
      continue; // try the next provider
    }
    // With the supplier's GST number filled in where this read missed it and an
    // earlier one didn't — the same as an upload gets (supplierGst.ts).
    const d = await withRememberedGstRegNo(result.data, { ws, orgId: realOrgId });
    // The supplier's standing rule, looked up once: it decides below whether the
    // reader's rows are kept at all, and is laid over the read at the end.
    const vendorRule = supplierRuleFor(ws, realOrgId, d.supplier);
    // Line items are the supplier's OPT-IN ("Extract line items" on its rule),
    // exactly as they are on an upload and a re-read: a document is otherwise a
    // single coded total, and the printed rows are pulled on demand from the
    // document page. The general read returns its own summary of the table as
    // an aid to the description, and this road used to store that summary on
    // every emailed or WhatsApp'd document — rows nobody asked for, never
    // reconciled against the document's total, which is the set the publish
    // path refuses. Nothing is stored unless a person switched it on.
    const wantsLines = Boolean(vendorRule?.extractLineItems);
    const readerLines =
      wantsLines && Array.isArray(d.lineItems) && d.lineItems.length
        ? lineItemRows(d.lineItems, vendorRule?.category || d.category)
        : undefined;
    const patch: Record<string, unknown> = {
      supplier: d.supplier,
      date: d.date,
      documentType: d.documentType,
      invoiceNumber: d.invoiceNumber,
      currency: d.currency,
      total: d.total,
      tax: d.tax,
      // What a foreign-currency document says the same money is worth in SGD.
      // Written as one thing: the tax decision reads the pair, and the Xero
      // publish reads the rate.
      baseCurrency: d.baseCurrency,
      baseTotal: d.baseTotal,
      baseTax: d.baseTax,
      exchangeRate: d.exchangeRate,
      category: d.category,
      categoryReason: d.categoryReason,
      description: d.description,
      dueDate: d.dueDate,
      period: d.period,
      cardLast4: d.cardLast4,
      // The distance off a mileage record. Priced below, at the entity's own
      // rate per km, the same way the browser's finalize prices an upload.
      distanceKm: d.distanceKm,
      // What the tax code below is decided on — kept, so the decision can be
      // explained afterwards. Both used to sit in this patch and be dropped by
      // updateBill, which stores only EDITABLE fields.
      supplierGstRegNo: d.supplierGstRegNo,
      supplierGstRegNoRemembered: Boolean(d.supplierGstRegNoRemembered),
      supplierGstRegNoFrom: d.supplierGstRegNoFrom || '',
      taxLabel: d.taxLabel,
      // Who the paper says it is FOR, so a document that arrived by email or
      // WhatsApp is checked against the entity it landed in like any other. It
      // was only ever written by the browser's own read paths, which is every
      // road except the two where nobody is watching.
      billedTo: d.billedTo,
      billedToRegNo: d.billedToRegNo,
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
      // Only when the supplier's rule asks for them (see above); otherwise the
      // key is absent, so whatever the document already holds is left alone.
      ...(readerLines ? { lineItems: readerLines } : {}),
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
      // The printed rate and the arithmetic disagree — a discount taken off
      // after tax, a part of the bill outside GST — so the document gets the
      // two lines that each carry their own rate, exactly as an upload or a
      // re-read gives them. The reader's own summary of the table is replaced
      // only when it does not add up to the document, which is the case the
      // publish path would refuse anyway.
      const split = await splitForPrintedRate(inputs.taxCtx, outcome, {
        total: d.total,
        tax: patch.tax ?? d.tax,
        category: d.category,
        // The rows the document will actually carry — none, unless the supplier
        // opted in — so a summary that is not being stored cannot stand in the
        // split's way either.
        lineItems: readerLines,
      });
      if (split) {
        patch.lineItems = split.rows;
        patch.taxRateReason = `${String(patch.taxRateReason ?? '')}${split.note}`;
      }
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
    overlaySupplierRule(patch, vendorRule, {
      supplier: d.supplier,
      noteFollowed: d.noteFollowed,
      via: envelope?.via,
    });
    // A mileage record is priced at the entity's rate per km — its total is
    // distance × rate, never a figure the reader found on the paper.
    await keepMileageInStep(ws, realOrgId, getBillById(scope, billId), patch);
    const saved = updateBill(scope, billId, patch);
    // The read ran. Whether it came back with anything is what decides where
    // the document lands, and it is asked of the SAVED document rather than of
    // the patch — a supplier rule laid over the read a moment ago is part of
    // what this document now says.
    return (await readGotNothing(saved)) ? 'blank' : 'read';
  }
  // Every provider failed — leave a breadcrumb the reviewer (and we) can see,
  // since a background read has nowhere else to report to. NOT 'blank': the
  // reader never gave an answer, so this document has still to be looked at by
  // somebody, and it belongs in the inbox where it will be.
  updateBill(scope, billId, { categoryReason: `Auto-read didn't complete (${lastNote}). Use Re-read.` });
  return 'failed';
}

// The document is marked as being read BEFORE this is called and stops being
// marked when it returns, so "Processing" means what it says on the road where
// nobody is watching. A read takes ten to thirty seconds and the browser is not
// involved in either of these, so without it an emailed bill sat in the inbox
// wearing "New" and "Nothing read" for the whole read — which is what a document
// the reader could get nothing off looks like when it is finished.
//
// In a finally, and never skipped: a reader that is switched off returns at the
// first line, and a document left saying "Processing" for ever is worse than one
// that was never marked at all. (sweepStuckProcessing is the backstop for the
// process dying mid-read, not for an ordinary return.)
export async function autoRead(
  req: Request,
  scope: string,
  realOrgId: string,
  preferred: Provider,
  billId: string,
  fileBase64: string,
  mediaType: string,
  envelope: CoveringNote | null = null
): Promise<void> {
  let end: ReadEnd = 'failed';
  try {
    end = await readIntoBill(req, scope, realOrgId, preferred, billId, fileBase64, mediaType, envelope);
  } finally {
    // Into the inbox whatever the read found — a blank read included. A
    // document the reader got nothing off used to be SET ASIDE to Archived on
    // the spot, and Cze asked for that to stop: whether a photo is a document
    // is a person's call, and a file archived by nobody is a file nobody
    // looks at. It lands as New wearing the "Nothing read" badge, which is what
    // sends a reviewer to it; on the WhatsApp road its message is still left
    // without a tick, which is how the sender is asked for a better photo.
    // `end` is still reported, so the reaction and the caller can tell a blank
    // read from a failed one.
    void end;
    settleProcessing(scope, billId, 'new');
  }
}

// The covering message as it is stored on a document and given to the reader —
// the email's own five fields. Wider than CoveringNote, which is only what the
// READ is told; `to` and `date` belong to the document's record of the mail.
type MailEnvelope = { from: string; to: string; subject: string; date: string; text: string };

// Put the fetched bytes in the file store. Split from the two things that can
// then be done with them — INSERT a document, or fill the one already standing
// in the inbox waiting for this very file — because the placeholder is the cost
// and a second row beside it would be the same cost twice.
async function storeFetched(
  scope: string,
  doc: { bytes: Buffer; fileName: string; mediaType: string }
): Promise<{ fileHash: string; fileName: string; storageKey: string; contentType: string }> {
  const fileHash = createHash('sha256').update(doc.bytes).digest('hex');
  let storageKey = '';
  let storedType = '';
  try {
    const stored = await putBillFile(scope, fileHash, doc.mediaType, doc.bytes);
    storageKey = stored.storageKey;
    storedType = stored.contentType;
  } catch {
    // Keep the metadata record even if the file store fails, as the attachment
    // road does — a document with no retrievable file is still a document.
  }
  return { fileHash, fileName: doc.fileName, storageKey, contentType: storedType || doc.mediaType };
}

// File one document that arrived as BYTES rather than as an attachment — what
// n8n hands back from behind a link — exactly as the attachment road files one:
// same storage, same owner, same covering envelope, same "Processing" status
// while the read runs. Shared so a document that came by link is
// indistinguishable from one that came as a file the moment it lands.
async function fileFetchedDocument(
  scope: string,
  user: { email: string },
  envelope: MailEnvelope,
  doc: { bytes: Buffer; fileName: string; mediaType: string }
): Promise<{ id: string; displayId: string }> {
  const file = await storeFetched(scope, doc);
  const bill = insertBill({
    orgId: scope,
    fileHash: file.fileHash,
    fileName: file.fileName,
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
    email: { from: envelope.from, to: envelope.to, subject: envelope.subject, date: envelope.date, text: envelope.text },
    storageKey: file.storageKey,
    contentType: file.contentType,
    status: 'processing',
    kind: 'cost',
  });
  return { id: bill.id, displayId: bill.displayId };
}

/**
 * The document a LINK mail is, before anybody has said whether its sender may
 * be followed.
 *
 * It is a real row in the Costs inbox from the moment the mail lands, and that
 * is the point: the inbox is where somebody is already looking, so it is where
 * the question gets asked. It carries the covering message, the links and the
 * sender — everything needed to decide — and no file, because fetching one is
 * the decision. Trusting the sender (or fetching this once) fills THIS row.
 */
export function placeholderForLinks(
  scope: string,
  user: { email: string },
  envelope: MailEnvelope,
  message: { id: string; links: string[] },
  note: string
): { id: string; displayId: string } {
  const bill = insertBill({
    orgId: scope,
    // Named for the MESSAGE, not for bytes it does not have. A blank hash is
    // shared by every other placeholder, which the exact-file duplicate check
    // would read as the same document arriving again and again.
    fileHash: createHash('sha256').update(`emaillink:${message.id}`).digest('hex'),
    // What a reviewer scanning the list will recognise: what the sender called
    // it. A document with no name at all reads as a row nothing happened to.
    fileName: (envelope.subject || 'Emailed link').slice(0, 200),
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
    email: { from: envelope.from, to: envelope.to, subject: envelope.subject, date: envelope.date, text: envelope.text },
    storageKey: '',
    contentType: '',
    // NEW, not 'processing': nothing is being read, and a row that says
    // "Processing" for as long as nobody answers a question is a lie about who
    // is waiting for whom.
    status: 'new',
    kind: 'cost',
    emailLink: {
      messageId: message.id,
      from: normaliseSender(envelope.from),
      links: message.links,
      status: 'awaiting_trust',
      note,
      at: new Date().toISOString(),
    },
  });
  return { id: bill.id, displayId: bill.displayId };
}

// Ask n8n what is behind this message's links, and file whatever comes back.
//
// Only ever called for a delivery that filed NOTHING of its own: an attachment
// is the document when there is one, and a mail carrying both an invoice and a
// link to the same invoice must not produce it twice. The result is written
// onto the mirrored message either way — a note saying what n8n said is what
// the Email tab shows when the answer was "nothing", and a reviewer with a
// reason can act where one staring at an empty inbox cannot.
//
// `fillBillId` is the placeholder that has been standing in the inbox asking
// about this sender: the FIRST document lands on that row rather than beside
// it, so the cost somebody has already seen (and may have coded, or reassigned)
// becomes the document instead of being joined by a twin. Anything further in
// the same answer — a mail linking to two invoices — is inserted.
//
// Best-effort throughout, and never allowed to throw into a background caller:
// the delivery has already been answered by the time this runs.
export async function followMessageLinks(
  req: Request,
  message: MailMessage,
  user: { email: string },
  provider: Provider,
  fillBillId = ''
): Promise<{ note: string; documents: MailDocument[] }> {
  const envelope: MailEnvelope = {
    from: message.from,
    to: message.to,
    subject: message.subject,
    date: message.sentAt,
    text: message.text,
  };
  let result: { documents: Array<{ bytes: Buffer; fileName: string; mediaType: string }>; note: string };
  try {
    result = await fetchDocumentsForLinks(message.links, envelope);
  } catch (err) {
    result = { documents: [], note: `n8n could not be reached (${err instanceof Error ? err.message : String(err)})` };
  }

  const linkRecord = {
    messageId: message.id,
    from: normaliseSender(message.from),
    links: message.links,
    note: result.note,
  };

  const made: MailDocument[] = [];
  const reads: Array<{ id: string; bytes: Buffer; mediaType: string; fileName: string }> = [];
  let fill = fillBillId;
  for (const doc of result.documents) {
    try {
      let id = '';
      let displayId = '';
      if (fill) {
        const file = await storeFetched(message.scope, doc);
        const filled = attachFetchedFile(message.scope, fill, file);
        if (!filled) {
          fill = '';
          continue;
        }
        id = filled.id;
        displayId = filled.displayId;
        fill = '';
      } else {
        const bill = await fileFetchedDocument(message.scope, user, envelope, doc);
        id = bill.id;
        displayId = bill.displayId;
      }
      setBillEmailLink(message.scope, id, { ...linkRecord, status: 'fetched' });
      made.push({ billId: id, displayId, fileName: doc.fileName, via: 'link' });
      reads.push({ id, bytes: doc.bytes, mediaType: doc.mediaType, fileName: doc.fileName });
    } catch (err) {
      console.error('[inbound] could not file a linked document', err);
    }
  }
  // Nothing came back, and the row that asked is still standing there: it says
  // what n8n answered, so the next person to open it is looking at a reason
  // rather than at an empty document. Still `awaiting_trust` where the sender
  // was never trusted at all — the question has not been answered, only the
  // fetch has failed.
  if (fill) {
    setBillEmailLink(message.scope, fill, {
      ...linkRecord,
      status: 'failed',
    });
  }
  recordLinkFetch(message.id, result.note, made);

  // Read each one the way an emailed attachment is read — with the covering
  // message, and under its own file name.
  for (const r of reads) {
    void autoRead(req, message.scope, message.orgId, provider, r.id, r.bytes.toString('base64'), r.mediaType, {
      ...envelope,
      fileName: r.fileName,
    });
  }
  return { note: result.note, documents: made };
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

// A verification link: Google's mail host, the /mail/ path, and the `vf-` token
// that marks it as one. mail-settings.google.com is the classic spelling and was
// the only one the old pattern took, which is how a confirmation arrived with
// its code stored and no link at all — a panel offering a button that isn't
// there. The host is read loosely and the `vf-` token strictly, because the
// token is what says "verification" and the host is the part that moves.
const CONFIRM_LINK = /^https:\/\/(?:[a-z0-9-]+\.)*google\.com\/mail\/\S*vf-/i;
// The fallback, used only once the SENDER says this is a confirmation: Google's
// own mail path, minus the pages every Google mail carries at the foot of it.
const GOOGLE_MAIL_LINK = /^https:\/\/(?:[a-z0-9-]+\.)*google\.com\/mail\//i;
const GOOGLE_FOOTER_LINK = /^https:\/\/(?:support|policies|myaccount|accounts)\.google\.com\//i;

// Pull the Gmail forwarding-confirmation link (and numeric code, if any) out of
// a Google confirmation email. Returns null when this isn't one.
//
// The link is picked from the ones `linksIn` already pulled out of the message
// rather than matched again here, and that is the point rather than a tidy-up:
// it decodes `&amp;`, and a confirmation URL is all query parameters, so a link
// scraped straight out of the HTML part arrives with its ampersands still
// encoded and fails when clicked.
function parseForwardConfirmation(from: string, subject: string, body: string, links: string[] = []) {
  const isGoogle =
    /forwarding-noreply@google\.com/i.test(from) ||
    (/confirm/i.test(subject) && /forward/i.test(subject));
  const confirm = links.find((u) => CONFIRM_LINK.test(u)) || '';
  // A verification link on its own still identifies a confirmation, so a mail
  // whose sender we don't recognise is judged exactly as strictly as before —
  // the loose fallback is reached only when the sender has already said.
  if (!isGoogle && !confirm) return null;
  const url =
    confirm ||
    links.find((u) => GOOGLE_MAIL_LINK.test(u) && !GOOGLE_FOOTER_LINK.test(u)) ||
    '';
  const codeMatch = body.match(/\b(\d{6,})\b/); // Gmail's numeric confirmation code
  return { url, code: codeMatch ? codeMatch[1] : '' };
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
  // The Message-ID header, where the raw MIME is forwarded. It is the one
  // identifier a mail carries of its own, so it is what the Email tab's rows
  // are keyed on when it is there.
  let messageIdFromMime = '';
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
      messageIdFromMime = String(parsed.messageId || '');
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
  // A person first, then the entity itself. An entity's short form standing
  // alone — `redalpha@cybills.sg`, where a person's handle would normally be —
  // is the company's own address rather than anybody's, so what arrives there
  // belongs to its GENERAL account: the row that already owns the paperwork
  // nobody claimed. Second, never first, so a person whose bare handle happens
  // to be that word keeps their own mail.
  const user = userByEmailHandle(local) || generalUserByEmailSuffix(workspaceId(req), local);
  if (!user) return res.status(404).json({ error: 'unknown_recipient', to });

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
  const envelope: MailEnvelope = {
    from,
    to,
    subject,
    date: sentAt,
    text: String(text || '').trim().slice(0, 4000),
  };

  // The message's own identity, and the key the mirror is upserted on. The MIME
  // carries one; a Worker that posts pre-parsed fields does not, so the message
  // is named by what it IS instead — a delivery retried after a timeout must
  // leave one row in the Email tab rather than two, and must not ask n8n to
  // fetch the same invoice a second time.
  const messageId =
    String(b.messageId || b.message_id || messageIdFromMime).trim() ||
    `mail_${createHash('sha256').update(`${to}|${from}|${subject}|${sentAt}|${body.slice(0, 2000)}`).digest('hex').slice(0, 24)}`;
  const received = new Date().toISOString();

  // Every http(s) link in the message. Read here rather than at the point of
  // use so the Email tab can SHOW them even where n8n is switched off or found
  // nothing: a link somebody can click themselves is better than a dead end.
  const links = linksIn(text, html);

  const mirror = (over: Partial<MailMessage>): MailMessage =>
    recordMail({
      id: messageId,
      workspaceId: workspaceId(req),
      orgId: realOrgId,
      scope,
      userId: user.id,
      to,
      from,
      subject,
      text: envelope.text,
      sentAt: sentAt || received,
      receivedAt: received,
      attachments: [],
      documents: [],
      links,
      linkNote: '',
      linkFetchedAt: '',
      outcome: 'nothing',
      ...over,
    });

  // A Gmail forwarding confirmation: hold the link for the user to click in the
  // app rather than filing it as a bill. Mirrored all the same — it arrived, and
  // a tab that shows only the mail that became a document is a tab that cannot
  // answer why something didn't.
  const conf = parseForwardConfirmation(from, subject, body, links);
  if (conf && (conf.url || conf.code)) {
    setPendingForward(user.id, { url: conf.url, code: conf.code, from });
    mirror({ outcome: 'forwarding_confirmation' });
    return res.json({ ok: true, kind: 'forwarding_confirmation', user: user.id });
  }

  // Otherwise file each PDF/image attachment as a cost document owned by the user.
  const madeBills: Array<{ id: string; displayId: string; base64: string; mediaType: string; fileName: string }> = [];
  const attachmentRows: MailAttachment[] = [];
  for (const a of atts) {
    const filename = String(a?.filename || 'document');
    const contentType = String(a?.contentType || '');
    const base64 = typeof a?.contentBase64 === 'string' ? a.contentBase64 : '';
    if (!base64) continue;
    const bytes = Buffer.from(base64, 'base64');
    if (!IMAGE_OR_PDF.test(contentType) && !IMAGE_OR_PDF.test(filename)) {
      // Kept in the mirror rather than dropped silently: a .docx invoice is the
      // commonest reason a mail "arrived and nothing happened", and the row
      // saying so is the only place anybody would ever see it.
      attachmentRows.push({ fileName: filename, contentType, bytes: bytes.length, skipped: 'not a PDF or image' });
      continue;
    }
    const fileHash = createHash('sha256').update(bytes).digest('hex');
    // What the file IS, off its bytes — not what the mail client labelled it.
    // The label was passed straight through to the reader, which is how a PDF
    // arriving as `application/octet-stream` failed every first read and read
    // fine when uploaded by hand. Stored under the real type too, so the
    // browser previews it as a PDF rather than offering a download.
    const readType = readerMediaType(contentType, filename, bytes);
    let storageKey = '';
    let storedType = '';
    try {
      const stored = await putBillFile(scope, fileHash, readType || contentType, bytes);
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
      // Being read, and saying so. The reply to the Worker goes out before the
      // read starts (a model call takes far longer than the delivery may), so
      // the document is visible in the inbox for the whole of it.
      status: 'processing',
      kind: 'cost',
    });
    attachmentRows.push({ fileName: filename, contentType: storedType || contentType, bytes: bytes.length, skipped: '' });
    madeBills.push({ id: bill.id, displayId: bill.displayId, base64, mediaType: readType || storedType || contentType, fileName: filename });
  }

  // Whether this delivery's links may be followed at all.
  //
  // `<handle>@cybills.sg` is a public catch-all, so the sender of a mail with a
  // link is an untrusted party until somebody here says otherwise: handing a
  // stranger's URL to a workflow that holds portal credentials is the shape of
  // a phishing attack, and a robot does not hesitate over a login page that
  // looks nearly right. A trusted sender's links are followed on arrival, as
  // before; anybody else's arrive as a document in the inbox that ASKS.
  //
  // Already handled means already handled: a delivery the Worker retries must
  // not stand a second copy of the same question in the inbox, nor re-fetch a
  // document it already has.
  //
  // And only where there IS a road: with no n8n webhook configured, the answer
  // to the question leads nowhere, so asking it would put a document in the
  // inbox for every newsletter that ever reached a CYBills address. The mail is
  // still mirrored in the Email tab, links and all.
  const prior = mailById(messageId);
  const settledAlready = Boolean(prior?.pendingBillId || prior?.documents.length || prior?.linkFetchedAt);
  const followable = !madeBills.length && links.length > 0 && !settledAlready && n8nEnabled();
  const trusted = followable && isTrustedSender(workspaceId(req), realOrgId, scope, from);
  const pending =
    followable && !trusted
      ? placeholderForLinks(
          scope,
          user,
          envelope,
          { id: messageId, links },
          `Not fetched yet — ${normaliseSender(from) || 'this sender'} has not been trusted here.`
        )
      : null;

  const message = mirror({
    attachments: attachmentRows,
    documents: madeBills.map((b) => ({ billId: b.id, displayId: b.displayId, fileName: b.fileName, via: 'attachment' as const })),
    outcome: madeBills.length ? 'documents' : pending ? 'awaiting_trust' : 'nothing',
    pendingBillId: pending?.id || prior?.pendingBillId || '',
    pendingDisplayId: pending?.displayId || prior?.pendingDisplayId || '',
    linkNote: pending ? `Waiting — is ${normaliseSender(from)} trusted?` : '',
  });

  // Read with the org's chosen reader (Claude / OpenAI), the same one the manual
  // re-read uses — not the deploy default, which may not be the org's working key.
  const settings = readSetting<{ readerProvider?: string }>(workspaceId(req), 'cybills.extraction-settings.v1', realOrgId);
  const provider = resolveProvider(settings?.readerProvider);

  // Answer the Worker straight away, then read each document in the background —
  // a model call takes 10-30s and the Worker shouldn't wait on it. A link fetch
  // is slower still (a portal login), which is the other reason nothing after
  // this line is waited on.
  res.json({
    ok: true,
    kind: 'documents',
    created: madeBills.length,
    user: user.id,
    message: message.id,
    // The document standing in the inbox asking whether this sender may be
    // followed, where there is one. Named in the reply so the Worker's own log
    // says what became of a delivery that filed nothing.
    awaiting: pending?.displayId || '',
  });
  // The covering message belongs to the EMAIL, the file name to the
  // attachment — one forward can carry three invoices, and reading all three
  // under the name of the first would tell the reader something untrue about
  // two of them.
  for (const b of madeBills) {
    void autoRead(req, scope, realOrgId, provider, b.id, b.base64, b.mediaType, {
      ...envelope,
      fileName: b.fileName,
    });
  }

  // Nothing came as a file, but something was written: a Xero subscription
  // invoice is a link and a sentence, and until now that mail filed nothing at
  // all. A sender somebody has already trusted has their links followed here
  // and now — which is what trusting them bought. Everybody else's document is
  // sitting in the inbox asking, and waits for an answer.
  if (trusted) {
    void followMessageLinks(req, message, user, provider).catch((err) =>
      console.error('[inbound] link fetch failed', err)
    );
  }
});
