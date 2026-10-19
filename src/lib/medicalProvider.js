// A bill from a hospital or clinic is No Tax. Always, in every client's book.
//
// The practice's rule (19 Oct 2026). GST on medical expenses is disallowed
// input tax in Singapore, so the practice never claims it — and CYBills was
// claiming it: a Novena Heart Centre invoice prints "GST and Co Reg No" and
// "GST 9%", passes the evidence gate exactly as any registered supplier's does,
// and was coded Standard-Rated Purchases.
//
// Decided by the SUPPLIER, not the account, because the supplier is the half
// that is certain: a clinic's bill is coded to Staff Medical, Staff Welfare,
// Entertainment or a recharge to a client, and it is disallowed on every one of
// them. Two signals, either enough:
//   - the supplier's NAME, by the words a hospital or clinic calls itself —
//     "Mount Elizabeth Hospital", "Raffles Medical Clinic", "Q&M Dental Centre";
//   - the PAPER, where the reader says the supplier is a hospital or clinic
//     (`medicalProvider`) — which catches "TCI Cardiology Pte Ltd" or
//     "Tamarind Health", whose names say neither.
//
// Pure, and shared the way motorVehicle.js is: taxRateOutcome (taxRateRules.js)
// applies it on the upload and the re-read, and the server loads it by path
// (server/src/practiceNoTax.ts, which holds both practice No Tax rules) on every
// write, the background read and the sweep over what is already stored.
//
// A person can still pick a code by hand on one document (a work-injury claim
// whose GST is claimable), and nothing that runs by itself overrules that pick;
// a re-read, which is asked to decide the document again, applies it again.

const words = (s) =>
  String(s ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

// Whole words, so "Hospitality" is not a hospital and "Clinical Supplies" is
// not a clinic.
const PROVIDER_WORDS = new Set(['hospital', 'hospitals', 'clinic', 'clinics', 'polyclinic', 'polyclinics']);
// A "centre" alone is a shopping centre; these say which kind.
const CENTRE_KINDS = new Set(['medical', 'specialist', 'specialists', 'dental', 'health', 'heart', 'eye', 'skin', 'cancer', 'surgical', 'surgery']);
// An animal's clinic is not a staff medical expense.
const NOT_HUMAN = new Set(['vet', 'vets', 'veterinary', 'animal', 'pet', 'pets']);

/** Does this supplier's name say it is a hospital or clinic? */
export function isMedicalProviderName(supplier) {
  const w = words(supplier);
  if (w.some((x) => NOT_HUMAN.has(x))) return false;
  if (w.some((x) => PROVIDER_WORDS.has(x))) return true;
  return w.some((x, i) => (x === 'centre' || x === 'center') && i > 0 && CENTRE_KINDS.has(w[i - 1]));
}

/** Does this document fall under the rule, by either signal? */
export function isMedicalProviderExpense({ supplier = '', medicalProvider = false, kind = 'cost' } = {}) {
  if (kind === 'sales') return false; // a sale is not an expense of anybody's
  return medicalProvider === true || isMedicalProviderName(supplier);
}

export const MEDICAL_TAX_RATE = 'No Tax';

/** The sentence that says why, naming the supplier where it has a name. */
export function medicalProviderReason({ supplier = '' } = {}) {
  const who = String(supplier ?? '').trim();
  return (
    `${who ? `${who} is a hospital or clinic` : 'The supplier is a hospital or clinic'}: ` +
    'GST on medical expenses is not claimed, so it is No Tax with the GST left in the cost. ' +
    'Where the GST is claimable (a work-injury claim), pick the code by hand.'
  );
}
