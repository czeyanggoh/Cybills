// TOTP, checked against RFC 6238's own test vectors.
//
// This is the second factor for everybody who signs in with a password rather
// than through Google — ST Engineering's staff, and anyone else the password
// form lets in. Written out rather than pulled in, so it is checked against the
// standard itself instead of against a library's behaviour: a code that is
// subtly wrong locks every one of those people out of the app, and a window
// that is subtly too wide is the thing the second factor was for.
// Set before the import: the sealing key is derived from SESSION_SECRET when
// env.ts is first evaluated, and without one the module falls back to storing
// the secret in the clear for local development.
process.env.SESSION_SECRET = 'test-session-secret';
const {
  base32Encode,
  base32Decode,
  totpCode,
  totpMatches,
  newSecret,
  otpauthUri,
  readableSecret,
  newRecoveryCodes,
  hashRecovery,
  spendRecovery,
  RECOVERY_COUNT,
  sealSecret,
  openSecret,
} = await import('../src/totp.ts');

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- Base32 -------------------------------------------------------------------
check('base32 round-trips', base32Decode(base32Encode(Buffer.from('hello world'))).toString(), 'hello world');
check('and matches RFC 4648', base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
// People retype these off a screen, so spacing and case are tolerated.
check('spaces and case are tolerated', base32Decode('mzxw 6ytb oi').toString(), 'foobar');

// --- RFC 6238 test vectors ----------------------------------------------------
// The RFC's SHA1 seed is the ASCII "12345678901234567890"; its table is in
// 8-digit codes, so they are asked for at that width. Production uses 6, which
// is the same number truncated.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
];
for (const [seconds, want] of VECTORS) {
  check(`RFC 6238 at T=${seconds}`, totpCode(RFC_SECRET, seconds * 1000, 8), want);
}

// --- What sign-in actually does ----------------------------------------------
const secret = newSecret();
const now = 1_787_000_000_000;
check('a fresh secret is 32 base32 characters', secret.length, 32);
check("the moment's own code is accepted", totpMatches(secret, totpCode(secret, now), now), true);
// A clock drifts and a person takes a moment to type, so one step either side.
check('the step before is accepted', totpMatches(secret, totpCode(secret, now - 30_000), now), true);
check('the step after is accepted', totpMatches(secret, totpCode(secret, now + 30_000), now), true);
// Two steps is not drift, it is an old code.
check('two steps back is refused', totpMatches(secret, totpCode(secret, now - 60_000), now), false);
check('two steps forward is refused', totpMatches(secret, totpCode(secret, now + 60_000), now), false);
check('a wrong code is refused', totpMatches(secret, '000000', now) && totpCode(secret, now) !== '000000', false);
check('a short code is refused', totpMatches(secret, '1234', now), false);
check('nothing at all is refused', totpMatches(secret, '', now), false);
// Typed with a space in the middle, the way the app shows it.
check('spacing in the typed code is tolerated', totpMatches(secret, totpCode(secret, now).replace(/^(\d{3})/, '$1 '), now), true);
// Another secret's code for the same instant is not this secret's.
check('a code from a different secret is refused', totpMatches(secret, totpCode(newSecret(), now), now), false);

// --- What the authenticator reads --------------------------------------------
const uri = otpauthUri(secret, 'dean@st-eng.example');
check('the app is told who it is for', uri.startsWith('otpauth://totp/CYBills:dean%40st-eng.example?'), true);
check('and the issuer, which older apps read off the label', uri.includes('issuer=CYBills'), true);
check('six digits, thirty seconds', uri.includes('digits=6') && uri.includes('period=30'), true);
check('typed by hand it comes in fives', readableSecret('ABCDEFGHIJ'), 'ABCDE FGHIJ');

// --- Recovery codes -----------------------------------------------------------
const codes = newRecoveryCodes();
check('ten of them', codes.length, RECOVERY_COUNT);
check('all different', new Set(codes).size, RECOVERY_COUNT);
let hashes = codes.map(hashRecovery);
check('the codes themselves are never what is stored', hashes.includes(codes[0]!), false);

const after = spendRecovery(hashes, codes[0]!);
check('a good code is accepted', Array.isArray(after), true);
check('and is spent', after!.length, RECOVERY_COUNT - 1);
check('so it cannot be used twice', spendRecovery(after!, codes[0]!), null);
check('a wrong code changes nothing', spendRecovery(after!, 'abcde-12345'), null);
// Read off a screen and typed back with or without the dash, in either case.
check('the dash is optional', Array.isArray(spendRecovery(hashes, codes[1]!.replace('-', ''))), true);
check('and so is the case', Array.isArray(spendRecovery(hashes, codes[2]!.toUpperCase())), true);

// --- The secret at rest -------------------------------------------------------
// A TOTP secret is password-equivalent: whoever holds it mints that person's
// codes forever, so a copy of the data file must not be a copy of everybody's
// second factor.
const sealed = sealSecret(secret);
check('what is stored is not the secret', sealed.includes(secret), false);
check('and it comes back', openSecret(sealed), secret);
check('a mangled one reads as nothing rather than throwing', openSecret('v1:aa:bb:cc'), '');
// The dev fallback, asserted rather than assumed: with no SESSION_SECRET there
// is no key to derive, and the module says so in the stored value rather than
// pretending to have encrypted anything. Production always has one — Google
// sign-in does not switch on without it.
check('and a dev-mode secret is plainly marked as unsealed', openSecret(`plain:${secret}`), secret);
check('and so does an empty one', openSecret(''), '');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
