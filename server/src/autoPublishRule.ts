// A supplier rule that says "publish to Xero after reading", honoured on the
// road where nobody is watching: an emailed, link-fetched or WhatsApp'd
// document read in the background (autoRead in inbound.ts). The upload road
// asks the same question in the browser (src/lib/autoPublish.js).
//
// It is a SUPPLIER's rule rather than an entity's switch because posting
// unchecked paper straight into a live ledger is only safe where the coding is
// already settled — a supplier whose category, tax code and project somebody
// has written down. So only an explicit status on the rule publishes here; a
// rule left on "Follow Extraction settings" does not, since that switch has
// only ever meant uploads.
//
// Declines rather than guesses, exactly as a person's publish would be refused,
// and never throws: the document stays in the inbox and Publish still works by
// hand. On top of what postBillToXero already refuses (incomplete, on a claim,
// a payment proof, already in Xero) it refuses a document that looks like one
// already in the book — approved and unattended, a duplicate is a bill paid
// twice.
import { readSetting } from './settings.js';
import { getOrganisation } from './organisations.js';
import { getBillById, findDuplicate, type Candidate } from './store.js';
import { postingCodesFor, postBillToXero } from './xero.js';

export const RULE_PUBLISH_STATUSES = ['AUTHORISED', 'SUBMITTED'] as const;

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

// The status the supplier's rule publishes at, or '' when it does not ask.
export function rulePublishStatus(ws: string, orgId: string, supplier: string): string {
  if (!norm(supplier)) return '';
  const map = readSetting<Record<string, Record<string, unknown>>>(ws, 'cybills.supplier.rules.v1', orgId) || {};
  const key = Object.keys(map).find((k) => norm(k) === norm(supplier));
  const wanted = String((key ? map[key]?.autoPublish : '') ?? '');
  return (RULE_PUBLISH_STATUSES as readonly string[]).includes(wanted) ? wanted : '';
}

export type RulePublishOutcome =
  | { published: true; status: string; invoiceId: string }
  | { published: false; reason: string };

export async function publishByRule(
  req: unknown,
  ws: string,
  scope: string,
  orgId: string,
  billId: string
): Promise<RulePublishOutcome> {
  try {
    const bill = getBillById(scope, billId);
    if (!bill) return { published: false, reason: 'not_found' };
    if ((bill.kind || 'cost') !== 'cost' || bill.xeroInvoiceId) return { published: false, reason: 'not_a_cost' };
    const status = rulePublishStatus(ws, orgId, bill.supplier);
    if (!status) return { published: false, reason: 'no_rule' };

    // Its own Xero only: a bridge entity's costs reach the parent's ledger as
    // the lines of an expense claim, never as bills of their own.
    const organisation = getOrganisation(ws, orgId);
    if (!organisation?.tenantId) return { published: false, reason: 'no_xero' };

    const candidate: Candidate = {
      fileHash: bill.fileHash,
      supplier: bill.supplier,
      invoiceNumber: bill.invoiceNumber,
      total: bill.total,
      date: bill.date,
      kind: bill.kind,
    };
    if (findDuplicate(scope, candidate, bill.id)) return { published: false, reason: 'possible_duplicate' };

    const posting = await postingCodesFor(ws, orgId, bill);
    if (!posting.ok) return { published: false, reason: posting.error };

    const out = await postBillToXero(req, organisation, scope, bill, {
      accountCode: posting.accountCode,
      taxType: posting.taxType,
      status,
    });
    if (out.status !== 200) return { published: false, reason: String(out.body?.error ?? out.status) };
    return { published: true, status, invoiceId: String(out.body?.invoice?.invoiceId ?? '') };
  } catch (err) {
    return { published: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
