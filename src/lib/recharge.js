// Is this an account a cost is coded to BECAUSE it is being billed back?
//
// A chart that recharges clients usually says so in an account of its own —
// "1354 - RECOVERABLE EXPENSES - PREPAYMENT", "Disbursements recoverable",
// "Reimbursable expenses", or an account whose description reads "costs
// incurred on behalf of client, which we will recharge back to them". A read
// that names the customer AND lands on such an account has already made the
// judgement Rebillable records, and leaving the switch off beside it (as the
// reader sometimes did) meant the cost published without being marked
// billable, so nobody billed it (19 Oct 2026).
//
// So the account is a second signal beside the reader's own `rebillable` — and
// the note the reader followed is a third ("coded for recharge to MERIDIAN"):
// both only ever turn the switch ON, only alongside a customer — the flag means
// "bill this to that client", and with no client it has no object.
//
// Pure: the server's read (extract.ts) loads it by path, and the re-read
// (reRead.js) imports it, so a document is judged the same on every road.

const words = (s) =>
  String(s ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

// Whole words in the account's NAME. Not "reimbursement": "Reimbursements - ST
// Engineering" is staff being paid back, which is nobody's recharge.
const NAME_WORDS = new Set([
  'recoverable', 'recoverables', 'recharge', 'recharges', 'recharged', 'rechargeable',
  'rebill', 'rebillable', 'rebilled', 'reimbursable', 'disbursement', 'disbursements',
]);

// Phrases in its DESCRIPTION. Not "recharge" alone, which is also what a
// prepaid mobile top-up is called.
const DESCRIPTION_PHRASES = [
  /\brecharg(e|ed|ing)\s+(back|to)\b/,
  /\bre-?bill/,
  /\bbill(ed)?\s+back\b/,
  /\bon\s+behalf\s+of\s+(the\s+)?(client|customer)s?\b/,
];

/** Does this account's name or description say it holds costs billed back? */
export function isRechargeAccount(label, description = '') {
  // The code is not part of the name ("1354 - RECOVERABLE…").
  const name = String(label ?? '').replace(/^\s*[\w./-]*\d[\w./-]*\s+-\s+/, '');
  const w = words(name);
  if (w.some((x) => NAME_WORDS.has(x))) return true;
  if (w.some((x, i) => x === 'on' && w[i + 1] === 'behalf')) return true;
  const d = String(description ?? '').toLowerCase();
  return DESCRIPTION_PHRASES.some((re) => re.test(d));
}

// Words that say a cost is being BILLED BACK, in what the reader took from the
// covering message ("The sender marked this as MGH, so it was coded for
// recharge to MERIDIAN GROUP HOLDINGS") or in the reason it gave. Same caution
// as the description: a bare "recharge" could be a mobile top-up, but not
// beside a customer the reader has just named.
const INSTRUCTION = /\b(recharg(e|ed|es|ing)|re-?bill(ed|able|ing)?|bill(ed)?\s+back|on\s+behalf\s+of)\b/i;

/** Does what the reader said about this document say it is billed back? */
export function saysRecharge(...texts) {
  return texts.some((t) => INSTRUCTION.test(String(t ?? '')));
}

/**
 * Whether a document should be Rebillable — only ever with a customer to bill —
 * by any of three signals: the reader said so; it is coded to a recharge
 * account (`accounts` is the chart, for the description); or the note the
 * reader followed, or the reason it gave, says to recharge it.
 */
export function rebillableFor({ customer = '', rebillable = false, category = '', accounts = [], reasons = [] } = {}) {
  if (!String(customer ?? '').trim()) return false;
  if (rebillable === true) return true;
  if (saysRecharge(...(Array.isArray(reasons) ? reasons : [reasons]))) return true;
  const label = String(category ?? '');
  const account = (Array.isArray(accounts) ? accounts : []).find(
    (a) => `${a?.code} - ${a?.name}` === label || String(a?.code ?? '') === label
  );
  return isRechargeAccount(account ? `${account.code} - ${account.name}` : label, account?.description || '');
}
