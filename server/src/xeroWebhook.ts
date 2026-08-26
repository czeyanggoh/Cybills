import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';
import { fetchXeroInvoice } from './xero.js';
import { billsByXeroInvoiceId, updateBill, type Bill } from './store.js';

// Xero webhooks, inbound. The other direction from xero.ts: this is Xero
// telling CYBills that something it published has changed.
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
//   - The very first POST is an "intent to receive" validation carrying a
//     deliberately WRONG signature, which we're expected to reject with 401.
//     That falls out of the rule above rather than needing a case of its own.

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

// What an invoice's Xero status means for the document's Paid field.
//   PAID       — settled in full. (Xero uses one status for it whether the money
//                arrived as a payment, a credit note, or a prepayment applied.)
//   DRAFT / SUBMITTED / AUTHORISED — still owed, in full or in part. A partly
//                paid bill is not a paid one, which is why AmountDue isn't
//                consulted: Xero only calls it PAID when nothing is left.
//   VOIDED / DELETED — the bill isn't money any more. Neither true nor false
//                says anything useful, so whatever a person set here is left
//                alone; unpicking a voided publish is its own decision.
function paidFromStatus(status: string): boolean | null {
  const s = String(status ?? '').trim().toUpperCase();
  if (s === 'PAID') return true;
  if (s === 'DRAFT' || s === 'SUBMITTED' || s === 'AUTHORISED') return false;
  return null;
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

    const paid = paidFromStatus(String(invoice.Status ?? ''));
    if (paid === null) continue;

    for (const bill of bills) {
      if (Boolean(bill.paid) === paid) continue;
      if (updateBill(bill.orgId, bill.id, { paid } as Partial<Bill>)) changed += 1;
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
