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
// So the account is a second signal beside the reader's own `rebillable`, and
// it only ever turns the switch ON, only alongside a customer — the flag means
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

/**
 * Whether a document should be Rebillable: the reader said so, or it is coded
 * to a recharge account — either way only with a customer to bill.
 * `accounts` is the chart (code / name / description), for the description.
 */
export function rebillableFor({ customer = '', rebillable = false, category = '', accounts = [] } = {}) {
  if (!String(customer ?? '').trim()) return false;
  if (rebillable === true) return true;
  const label = String(category ?? '');
  const account = (Array.isArray(accounts) ? accounts : []).find(
    (a) => `${a?.code} - ${a?.name}` === label || String(a?.code ?? '') === label
  );
  return isRechargeAccount(account ? `${account.code} - ${account.name}` : label, account?.description || '');
}
