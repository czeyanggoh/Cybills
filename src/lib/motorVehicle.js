// A motor vehicle expense incurred in Singapore is No Tax. Always, in every
// Singapore client's book.
//
// It is SINGAPORE's rule, and that is not a detail: Australia claims the GST on
// fuel, parking and running costs like any other expense, so whether this rule
// applies at all is the jurisdiction's answer (gstJurisdiction.js —
// `blocksMotorVehicle`), asked by taxRateOutcome and by the server's writes and
// sweeps before either reaches for what is below. Applied to an Australian book
// it would quietly strip a real credit off every petrol receipt in it, which is
// the same silent damage it exists to prevent here.
//
// The practice's rule, and one CYBills was quietly breaking. Nearly every
// client's chart already says it: "449 - Motor Vehicle Expenses" defaults to
// NONE in Xero. But the tax decision only follows an account's default when the
// GST PRINTED on the paper agrees with it, and a No Tax default never agrees with
// a petrol receipt that prints "TOTAL GST 8.56" — so the decision fell through
// to the arithmetic, found 9%, and coded the receipt Standard-Rated Purchases,
// claiming input tax the practice never claims. And four charts (Sensu,
// Sunstream, TYA, Wow Studio) default their motor accounts to INPUTY24 anyway,
// so following the chart would not have been consistent either.
//
// So it is decided HERE, once, by two signals, and the chart is not consulted:
//   - the ACCOUNT the document is coded to, by the words its name uses —
//     "Motor Vehicle Expenses", "T&E Motor Vehicle Expenses", "Motor Vehicle -
//     Petrol", "MAINTENANCE PETROL", "CAR MAINT", a bridge entity's "Parking";
//   - the PAPER, where the reader says the document is the cost of owning or
//     running a vehicle (`motorVehicle`), which catches the petrol receipt coded
//     to "Transport" or "General Expenses".
// Either one is enough.
//
// Pure, and shared: taxRateOutcome (taxRateRules.js) applies it on the upload
// and the re-read, and the server loads it by path (server/src/motorVehicle.ts)
// for every write, the background read and the sweep over what is already
// stored — so the page, the list and the stored document cannot disagree.
//
// A person can still pick a code by hand on one document (a goods van, whose
// GST is claimable), and nothing that runs by itself overrules that pick; a
// re-read, which is asked to decide the document again, applies the rule again.

// Matched as whole words against the label, with its account code taken off, so
// "Card fees" is not "car", "Scarf" is nothing, and "Transport - Taxi" — paying
// somebody else to carry you — is not a vehicle of the business's own.
const VEHICLE_WORDS = new Set([
  'motor', 'vehicle', 'vehicles', 'car', 'cars', 'carpark', 'carparks',
  'petrol', 'diesel', 'fuel', 'parking', 'erp', 'coe', 'tyre', 'tyres',
]);

const words = (label) =>
  String(label ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Is this account (or bridge category) one for a motor vehicle expense? */
export function isMotorVehicleCategory(label) {
  const w = words(label);
  if (w.some((x) => VEHICLE_WORDS.has(x))) return true;
  // "Road tax" is two ordinary words that only mean this together.
  return w.some((x, i) => x === 'road' && w[i + 1] === 'tax');
}

/** Does this document fall under the rule, by either signal? */
export function isMotorVehicleExpense({ category = '', motorVehicle = false, kind = 'cost' } = {}) {
  if (kind === 'sales') return false; // a sale is not an expense of anybody's
  return motorVehicle === true || isMotorVehicleCategory(category);
}

export const MOTOR_VEHICLE_TAX_RATE = 'No Tax';

/**
 * The sentence that says why. It names which signal decided, because "coded to
 * a motor vehicle account" sends a reviewer to the category and "the document
 * is a motor vehicle expense" sends them to the paper — and it says how to make
 * the exception, since a goods vehicle is the real one.
 */
export function motorVehicleReason({ category = '', motorVehicle = false, country = 'Singapore' } = {}) {
  const why = isMotorVehicleCategory(category)
    ? `Coded to ${String(category).trim()}, a motor vehicle account`
    : 'The document is a motor vehicle expense';
  return (
    `${why}: motor vehicle expenses incurred in ${country || 'Singapore'} are always No Tax, with any GST left in the cost. ` +
    'For a goods vehicle whose GST is claimable, pick the code by hand.'
  );
}
