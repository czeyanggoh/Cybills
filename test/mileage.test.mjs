// A mileage claim's money is derived: distance × the rate per km, and never
// typed. These are the rules the document page, the server's PATCH and the
// reader's finalize all apply — one module, loaded by both sides.
import {
  isMileage,
  positive,
  mileageAmount,
  formatKm,
  mileageSummary,
  mileagePatch,
} from '../src/lib/mileage.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- what counts as a mileage document ----------------------------------------
check('Mileage is mileage', isMileage('Mileage'), true);
check('however it is cased or padded', isMileage('  mileage '), true);
check('a receipt is not', isMileage('Receipt'), false);
check('nor nothing', isMileage(''), false);
check('nor undefined', isMileage(undefined), false);

// --- the figures --------------------------------------------------------------
check('a form string is a number', positive('13'), 13);
check('with its unit', positive('13 km'), 13);
check('a decimal rate', positive('0.60'), 0.6);
check('a stored number', positive(12.5), 12.5);
check('blank is nothing', positive(''), 0);
check('zero is nothing', positive('0'), 0);
check('a negative is nothing', positive('-3'), 0);

// --- distance × rate ----------------------------------------------------------
check('13 km at 0.60', mileageAmount('13', '0.60'), 7.8);
check('to the cent', mileageAmount(12.5, 0.63), 7.88); // 7.875 → 7.88
check('no rate is no amount', mileageAmount('13', ''), null);
check('no distance is no amount', mileageAmount('', '0.60'), null);

// --- how it reads -------------------------------------------------------------
check('a whole distance', formatKm('13'), '13 km');
check('a fractional one keeps its decimals', formatKm(12.5), '12.5 km');
check('but no more than two', formatKm(12.345), '12.35 km');
check('nothing reads as nothing', formatKm(''), '');
check('the working, with the currency', mileageSummary('13', '0.60', 'SGD'), '13 km × SGD 0.60/km');
check('without one', mileageSummary('13', '0.60'), '13 km × 0.60/km');
check('a distance still waiting on its rate', mileageSummary('13', ''), '13 km');
check('no distance says nothing', mileageSummary('', '0.60'), '');

// --- the patch ----------------------------------------------------------------
const doc = { documentType: 'Mileage', distanceKm: 13, mileageRate: 0.6 };
check('a mileage document with both halves gets its total, tax 0', mileagePatch(doc), { total: 7.8, tax: 0 });
check('a receipt is left alone', mileagePatch({ documentType: 'Receipt', distanceKm: 13, mileageRate: 0.6 }), {});
check(
  'the page spells the type "type"',
  mileagePatch({ type: 'Mileage', distanceKm: '13', mileageRate: '0.60' }),
  { total: 7.8, tax: 0 }
);
check(
  'a change to the distance recomputes',
  mileagePatch(doc, { distanceKm: 20 }),
  { total: 12, tax: 0 }
);
check(
  'a change to the rate recomputes',
  mileagePatch(doc, { mileageRate: 0.5 }),
  { total: 6.5, tax: 0 }
);
check(
  'the entity default fills a missing rate, and is written so the document keeps it',
  mileagePatch({ documentType: 'Mileage', distanceKm: 13 }, {}, '0.60'),
  { mileageRate: 0.6, total: 7.8, tax: 0 }
);
check(
  'a rate on the document beats the default',
  mileagePatch({ documentType: 'Mileage', distanceKm: 13, mileageRate: 0.8 }, {}, '0.60'),
  { total: 10.4, tax: 0 }
);
check(
  'becoming a mileage document computes from what it carries',
  mileagePatch({ documentType: 'Receipt', distanceKm: 13 }, { documentType: 'Mileage' }, '0.60'),
  { mileageRate: 0.6, total: 7.8, tax: 0 }
);
check(
  'becoming one with no distance leaves the total: nothing to compute from',
  mileagePatch({ documentType: 'Receipt', total: 22.2 }, { documentType: 'Mileage' }, ''),
  {}
);
check(
  'clearing the distance takes the total with it',
  mileagePatch(doc, { distanceKm: '' }),
  { total: 0, tax: 0 }
);
check(
  'clearing the rate too, when there is no default to fall back on',
  mileagePatch(doc, { mileageRate: '' }),
  { total: 0, tax: 0 }
);
check(
  'but a cleared rate falls back to the default',
  mileagePatch(doc, { mileageRate: '' }, 0.5),
  { mileageRate: 0.5, total: 6.5, tax: 0 }
);
check(
  'a distance read by the reader onto a document with no rate and no default: nothing yet',
  mileagePatch({ documentType: 'Mileage' }, { distanceKm: 13 }),
  { total: 0, tax: 0 }
);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll mileage tests passed.');
