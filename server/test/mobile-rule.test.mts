// One rule for a phone number, in two places that must never disagree.
//
// The form validates it (src/lib/mobile.js) and the group is opened with it
// (server/src/whatsapp.ts). If those drift, a number the form accepts is
// refused when CYBills tries to connect — or worse, accepted and never matched,
// so everything that person sends lands on the entity's General account with no
// error anywhere.
//
// The two are separate implementations on purpose: the server's is used
// synchronously in hot paths, and the browser cannot import TypeScript. So they
// are pinned to each other here instead.
const { normaliseMobile: fromServer } = await import('../src/whatsapp.ts');
const client = (await import('../../src/lib/mobile.js')) as {
  normaliseMobile: (raw: string) => string;
  mobileError: (raw: string, opts?: { required?: boolean }) => string;
};

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const CASES: Array<[string, string]> = [
  ['+60 12-345 6789', '60123456789'],
  ['0060123456789', '60123456789'],
  ['(65) 9123-4567', '6591234567'],
  ['6591234567', '6591234567'],
  ['65 9123 4567', '6591234567'],
  // A national trunk prefix: refused rather than repaired, because no country
  // code begins with 0 and there is no way to know which to prepend.
  ['0123456789', ''],
  ['09123 4567', ''],
  ['12345', ''],
  ['1234567890123456', ''],
  ['call me', ''],
  ['', ''],
];

for (const [input, want] of CASES) {
  check(`server: ${JSON.stringify(input)}`, fromServer(input), want);
  check(`client agrees`, client.normaliseMobile(input), fromServer(input));
}

// --- What the person typing it is told ---------------------------------------
check('a blank passes — the number can be filled in later', client.mobileError(''), '');
check('and is refused only when the caller insists', client.mobileError('', { required: true }), 'A mobile number is required.');
check('a national number says what to do', client.mobileError('0123456789'), 'Start with the country code — 65… or 60…, not 0…');
check('a short one says so', client.mobileError('12345'), 'That is not the right length — 8 to 15 digits including the country code.');
check('a good one says nothing', client.mobileError('+65 9123 4567'), '');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
