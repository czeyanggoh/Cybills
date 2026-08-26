import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';
import { fetchXeroInvoice } from './xero.js';
import { billsByXeroInvoiceId, markBillXeroPayment } from './store.js';

// Xero webhooks, inbound. The other direction from xero.ts: this is Xero
// telling CYBills that something it published has changed.
//
// What it writes is the document's XERO PAYMENT fields — `xeroStatus`,
// `xeroPaidDate`, `xeroPaymentRef` — and deliberately not `paid`. They answer
// two different questions and only one of them is Xero's: `paid` is the
// reviewer's capture-time flag in Dext's sense ("this was already settled, so
// publish it as paid"), defaulted per document type in Extraction settings and
// written by supplier rules; the ledger's own answer is a fact about the bill
// AFTER it was published. Folding the second into the first would overwrite a
// person's setting with a different question's answer.
//
// What Xero sends is deliberately thin — an INVOICE event carries the invoice's
// id and nothing else, not what changed and not what it changed TO. There is no
// "invoice paid" event and no PAYMENT category at all, so an UPDATE is the only
// notice we ever get that a published bill has been paid, and the payload can
// never answer it on its own. Every event therefore ends in a read-back: match
// the id against a document we published, then ask Xero what that invoice looks
// like now.
//
// The receiver runs under three of Xero's rules, and all three shape the code:
//   - Every delivery is signed (x-xero-signature = base64 HMAC-SHA256 of the RAW
//     body with the app's webhook key). The signature is the only proof a POST
//     came from Xero, so an unverified body is never parsed, let alone acted on.
//   - Answer within 5 seconds, with 200 (verified) or 401 (not). Anything else —
//     a 500, a slow reply — counts as a failed delivery, and enough failures
//     disable the webhook at Xero's end. So the reply goes out first and the
//     Xero read-back happens after it, off the request.
//   - Before any event is delivered, the subscription has to pass an "intent to
//     receive" handshake: Xero POSTs an empty-events payload twice, once signed
//     CORRECTLY (must be answered 2xx) and once signed WRONGLY (must be
//     answered 401), and both have to be right or the subscription stays off.
//     Verifying the signature and answering 200/401 on the result is the whole
//     of it — which is why there is no special case for it here. It does mean
//     the handshake cannot pass until XERO_WEBHOOK_KEY is set: without a key
//     the correctly signed half is refused along with everything else.
//   - Xero also requires that the response carry no cookies, which is another
//     reason this route sits ahead of everything that might set one.

export type XeroWebhookEvent = {
  resourceId?: string;
  resourceUrl?: string;
  eventDateUtc?: string;
  eventType?: string;
  eventCategory?: string;
  tenantId?: string;
  tenantType?: string;
};

// Whether this body really came from Xero. Compared in constant time, and only
// ever true when a webhook key is actually configured: with none, CYBills can
// verify nothing, and "can't verify" must read as "refuse" rather than as
// "allow" — an unauthenticated POST to this route can otherwise flip a
// document's paid flag by naming an invoice id.
export function verifyXeroSignature(raw: Buffer, signature: string): boolean {
  const key = env.XERO_WEBHOOK_KEY;
  if (!key || !signature) return false;
  const expected = Buffer.from(createHmac('sha256', key).update(raw).digest('base64'));
  const given = Buffer.from(String(signature));
  // timingSafeEqual throws on a length mismatch, which is itself a mismatch.
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

// What Xero says about this invoice, in the three fields the document keeps.
// Recorded as Xero words it — PAID, AUTHORISED, VOIDED — rather than reduced to
// a boolean here: "not paid" covers a bill awaiting payment and a bill that was
// voided, and a reviewer looking at the paperwork needs those told apart. The
// UI does the wording (src/lib/xeroPaidStatus.js).
//
// `Status`, not `AmountDue`: Xero only calls a bill PAID when nothing is left
// on it, so a PARTLY paid bill correctly stays AUTHORISED here.
function paymentFromInvoice(invoice: Record<string, any>): {
  xeroStatus: string;
  xeroPaidDate: string;
  xeroPaymentRef: string;
} {
  // Payments carry the reference somebody typed when the money was recorded —
  // a cheque number, a transfer id, "PayNow 26 Aug". Several can settle one
  // bill (a part payment, then the rest), so they're joined; blank ones and
  // repeats are dropped rather than printed as empty commas.
  const payments = Array.isArray(invoice?.Payments) ? invoice.Payments : [];
  const refs: string[] = [];
  for (const p of payments) {
    const ref = String(p?.Reference ?? '').trim();
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
  // Xero's dates come as YYYY-MM-DDT00:00:00 (or /Date(…)/ on some endpoints);
  // the day is all that's meaningful for a payment date.
  const fullyPaid = String(invoice?.FullyPaidOnDate ?? '').trim();
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(fullyPaid);
  return {
    xeroStatus: String(invoice?.Status ?? '').trim().toUpperCase(),
    xeroPaidDate: day ? day[1] : '',
    xeroPaymentRef: refs.join(', '),
  };
}

// Apply a batch of webhook events to the documents they name. Exported (and
// returning a count) so the behaviour can be tested without a live Xero.
export async function applyInvoiceEvents(
  events: XeroWebhookEvent[]
): Promise<{ matched: number; changed: number }> {
  // One read per invoice, however many times the batch names it. Xero coalesces
  // events by the second, so an invoice edited and then paid arrives twice —
  // and both events would ask the same question of the same live record.
  const wanted = new Map<string, string>(); // invoiceId -> tenantId from the event
  for (const ev of events ?? []) {
    if (String(ev?.eventCategory ?? '').toUpperCase() !== 'INVOICE') continue;
    // UPDATE only. A CREATE naming an invoice we hold can only be the echo of
    // our own publish a second earlier — nothing is ever paid in the same
    // breath as it is posted — so reading it back can only confirm what we
    // just wrote. A CREATE naming anything else is another app's or a person's
    // invoice, which we drop at the match anyway. Either way the read is
    // wasted, and a read is the only thing here that spends Xero's rate limit.
    if (String(ev?.eventType ?? '').toUpperCase() !== 'UPDATE') continue;
    const id = String(ev?.resourceId ?? '').trim();
    if (!id) continue;
    wanted.set(id, String(ev?.tenantId ?? '').trim());
  }

  let matched = 0;
  let changed = 0;
  for (const [invoiceId, eventTenantId] of wanted) {
    // Match locally FIRST. The webhook is configured per Xero app, so it fires
    // for every invoice in every organisation the app is connected to — the
    // whole client list, sales invoices included — and CYBills published a
    // vanishing fraction of them. An event naming an invoice we don't hold is
    // not an error and must not cost a Xero call.
    const bills = billsByXeroInvoiceId(invoiceId);
    if (!bills.length) continue;
    matched += bills.length;

    // The tenant the document was posted into is what the document itself
    // records — which is the one that survives a bridge entity, whose bills
    // live in its own book but post into the parent's Xero. The event's own
    // tenantId is the fallback for a row published before that was stored.
    const tenantId = bills.find((b) => b.xeroTenantId)?.xeroTenantId || eventTenantId;
    const invoice = await fetchXeroInvoice(tenantId, invoiceId);
    if (!invoice) continue;

    const payment = paymentFromInvoice(invoice);
    if (!payment.xeroStatus) continue;

    for (const bill of bills) {
      if (markBillXeroPayment(bill.orgId, bill.id, payment)) changed += 1;
    }
  }
  return { matched, changed };
}

// Deliveries are processed one batch at a time, after their reply has gone out.
// Serial rather than parallel because each batch means relay calls, and a burst
// of events (a client reconciling a morning's bank feed in one go) would
// otherwise fan out into as many concurrent Xero reads as Xero cares to send.
let queue: Promise<void> = Promise.resolve();

function enqueue(events: XeroWebhookEvent[]): void {
  queue = queue
    .then(() => applyInvoiceEvents(events))
    .then(({ matched, changed }) => {
      if (matched) console.log(`[xero-webhook] ${events.length} event(s), ${matched} matched, ${changed} updated`);
    })
    .catch((err) => console.error('[xero-webhook] processing failed', err));
}

// Wait for everything queued so far. For tests, and for a graceful shutdown.
export function flushXeroWebhooks(): Promise<void> {
  return queue;
}

export const xeroWebhookRouter = Router();

// POST /api/webhooks/xero — the Delivery URL configured in the Xero app.
// Mounted with express.raw (see index.ts) because the signature is over the
// exact bytes Xero sent: re-serialising a parsed body changes them.
xeroWebhookRouter.post('/xero', (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
  if (!verifyXeroSignature(raw, req.header('x-xero-signature') ?? '')) {
    return res.status(401).end();
  }
  // Reply first, work after: the 5-second budget is Xero's, and a Xero read-back
  // of our own can take longer than that on a bad afternoon.
  res.status(200).end();

  let payload: { events?: XeroWebhookEvent[] } | null = null;
  try {
    payload = JSON.parse(raw.toString('utf8') || '{}');
  } catch (err) {
    console.error('[xero-webhook] signed body was not JSON', err);
    return;
  }
  const events = Array.isArray(payload?.events) ? payload.events : [];
  if (events.length) enqueue(events);
});
