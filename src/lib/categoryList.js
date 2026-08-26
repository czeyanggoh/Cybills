// The category list for an entity that has no chart of accounts.
//
// A bridge entity ("Red Alpha - ST Engineering") is not a real company: the
// people claiming through it are ST Engineering staff who have never seen a
// Xero chart and would not know what "493 - Travel - National" means. They pick
// the plain names their own expense policy uses — "Transport - Taxi", "Meal
// Weekday (after 9pm)" — and the mapping to an account code happens once, at
// publish time, in the entity whose ledger actually receives the money.
//
// Pure and dependency-free on purpose: the browser reads it through
// listsStore.js, and the server loads it by path (server/src/categories.ts) so
// an EMAILED document is classified into the same list an uploaded one is.
// Two copies of this list would mean the reader and the dropdown disagreeing
// about what the categories are.

// Seeded from the client's own ST Eng claim form.
export const SEED_CATEGORY_NAMES = [
  'Offshore L.H (overnight)', 'Meal Weekday (after 9pm)', 'Transport -Claim by mileage',
  'Standby Allowance', 'Offshore H.S per trip', 'Offshore L.S (overnight)', 'Meal Weekend & PH',
  'Offshore L.H per trip', 'Transport - Taxi', 'Parking', 'Recall Allowance - Weekday',
  'Transport - Train', 'Transport - Bus', 'ERP - Cashcard', 'Recall Allowance - Weekend Crossover',
  'Recall Allowance - Weekend/PH', 'Transport - Ferry', 'Recall Allowance - weekday over cross midnight',
  "Contractor's pass fee", 'PPE Safety', 'Courses/Workshop/Training Fees', 'Transport - Flights', 'Others',
];

export const SEED_CATEGORIES = SEED_CATEGORY_NAMES.map((name) => ({ name, code: '' }));

// Stable id for a seed row — the same key listsStore.js hides rows by.
export const seedCategoryId = (name) => `categories:${name}`;

const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const asArray = (v) => (Array.isArray(v) ? v : []);

// The rows this entity's Lists → Categories shows: the seed, plus anything
// added, minus nothing — each row carrying whether it is switched on. `blob` is
// the stored `cybills.lists.v1` value (shape: { added, hidden, meta }), which is
// what the client holds in localStorage and the server reads as a setting.
export function categoryRowsFrom(blob) {
  const state = asObject(blob);
  const hidden = new Set(asArray(asObject(state.hidden).categories).map(String));
  const seed = SEED_CATEGORIES.map((row) => ({ ...row, id: seedCategoryId(row.name), seed: true }));
  const added = asArray(asObject(state.added).categories).map((row) => ({
    name: String(row?.name ?? ''),
    code: String(row?.code ?? ''),
    id: String(row?.id ?? ''),
    seed: false,
  }));
  return [...seed, ...added]
    .filter((row) => row.name)
    .map((row) => ({ ...row, visible: !hidden.has(row.id) }));
}

// Just the names that are switched on — what a dropdown offers and what the
// document reader is allowed to classify into.
export function visibleCategoryNamesFrom(blob) {
  return categoryRowsFrom(blob).filter((r) => r.visible).map((r) => r.name);
}

// --- What counts as an account code -----------------------------------------
// A category label is "<code> - <name>" when it comes from a chart of accounts
// ("412 - Consulting & Accounting") and a plain name otherwise. " - " alone
// cannot tell them apart: a claim policy is full of names like "Transport -
// Taxi", which split into the code "Transport" — a code no chart has. What
// separates them is that an account code always contains a digit.
//
// Both halves of the app ask this question — the dropdowns (how to display and
// sort a label) and the publish path (which Xero account a line posts to) — so
// it is answered once, here.

// Where the code ends, or -1 when the label carries no code.
export function categoryCodeEnd(label) {
  const s = String(label ?? '');
  const i = s.indexOf(' - ');
  if (i === -1) return -1;
  const head = s.slice(0, i).trim();
  // Xero codes are short alphanumerics with internal hyphens ("200-10"), and
  // always have a digit in them.
  return /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9-]{0,14}$/.test(head) ? i : -1;
}

// The account code in a category label, or '' when it has none.
export function categoryCode(label) {
  const s = String(label ?? '');
  const i = categoryCodeEnd(s);
  return i === -1 ? '' : s.slice(0, i).trim();
}

// The name half of a category label — the whole thing when it carries no code.
export function categoryName(label) {
  const s = String(label ?? '');
  const i = categoryCodeEnd(s);
  return i === -1 ? s : s.slice(i + 3);
}
