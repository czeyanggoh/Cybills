// A mobile number, as WhatsApp needs it.
//
// This is not a formatting nicety. The number is how a bill arriving from a
// phone is matched back to the person who sent it, and it is what a WhatsApp
// collection group is opened with — so a number that looks fine in the form and
// turns out to be unusable later doesn't fail loudly, it just quietly files
// everything that person sends onto the entity's General account.
//
// The same rule therefore has to run in the form and at the far end. Its twin
// is `normaliseMobile` in server/src/whatsapp.ts, and a test asserts the two
// agree on a table of cases rather than trusting they still do.

// Bare international format: digits only, no '+', spaces, dashes or brackets,
// 8-15 digits. Returns '' for anything that can't be one.
export function normaliseMobile(raw) {
  const digits = String(raw ?? '').replace(/\D+/g, '');
  // '00' is the other way of writing '+' — international access, not part of
  // the number itself.
  const bare = digits.startsWith('00') ? digits.slice(2) : digits;
  // A leading 0 is refused rather than repaired: no country code begins with
  // one, so "0123 456 789" is somebody's national format and there is no way to
  // know which country to prepend. Guessing would put a stranger in a group
  // holding a client's bills.
  if (bare.startsWith('0')) return '';
  if (bare.length < 8 || bare.length > 15) return '';
  return bare;
}

export const MOBILE_HINT = 'Country code first, digits only — 60123456789, not 0123456789.';

// Why a number was refused, in the words the person typing it needs. Empty when
// it is fine — a BLANK one included: somebody added without a number simply
// isn't collecting over WhatsApp yet, and their number can be filled in later
// (Edit details, or Connect to WhatsApp, which saves it as it opens the group).
// What is refused is a number that has been typed and can't be used. `required`
// is left for a caller that genuinely can't proceed without one.
export function mobileError(raw, { required = false } = {}) {
  const typed = String(raw ?? '').trim();
  if (!typed) return required ? 'A mobile number is required.' : '';
  if (normaliseMobile(typed)) return '';
  const digits = typed.replace(/\D+/g, '');
  if (!digits) return 'That is not a number.';
  if (digits.replace(/^00/, '').startsWith('0')) return 'Start with the country code — 65… or 60…, not 0…';
  return 'That is not the right length — 8 to 15 digits including the country code.';
}
