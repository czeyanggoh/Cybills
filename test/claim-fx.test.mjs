// What a claim line says about a foreign receipt it has converted.
import { fxSummary, lineWorking } from '../src/lib/claimFx.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

check('day rate', fxSummary({ origCurrency: 'USD', origTotal: '25', fxRate: '1.3144', fxSource: 'day' }, 'SGD'), 'USD 25.00 @ 1.3144 (day rate)');
check('the receipt\'s own restatement', fxSummary({ origCurrency: 'USD', origTotal: '17.17', fxRate: '1.292953', fxSource: 'document' }, 'SGD'), 'USD 17.17 @ 1.292953 (as restated on the receipt)');
check('no rate found is said', fxSummary({ origCurrency: 'NZD', origTotal: '100', fxMissing: true }, 'SGD'), 'NZD 100.00 — no rate found, counted as printed');
check('a receipt in the claim\'s currency says nothing', fxSummary({ origCurrency: 'SGD', origTotal: '12', fxRate: '1' }, 'SGD'), '');
check('nothing to say', lineWorking({}, 'SGD'), '');
check('mileage and currency together', lineWorking({ distanceKm: '13', mileageRate: '0.6', origCurrency: 'USD', origTotal: '25', fxRate: '1.3', fxSource: 'day' }, 'SGD').includes('USD 25.00 @ 1.3 (day rate)'), true);

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall claim-fx checks passed');
