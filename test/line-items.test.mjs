// A line of an itemised table has to agree with itself: net + tax = total,
// whichever of the three somebody just typed.
import { balanceLine, cellNumber, foldTaxIntoCost, completeLine, completeLines } from '../src/lib/lineItems.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const row = { description: 'Telephone', net: '94.85', tax: '7.98', total: '102.83' };

// --- Editing net or tax carries the total ------------------------------------
check('a new net updates the total', balanceLine(row, { net: '100' }).total, '107.98');
check('…and leaves the tax alone', balanceLine(row, { net: '100' }).tax, '7.98');
check('a new tax updates the total', balanceLine(row, { tax: '9' }).total, '103.85');
check('…and leaves the net alone', balanceLine(row, { tax: '9' }).net, '94.85');

// --- Editing the total gives way from the net --------------------------------
check('a new total back-solves the net', balanceLine(row, { total: '110' }).net, '102.02');
check('…keeping the stated tax', balanceLine(row, { total: '110' }).tax, '7.98');

// --- Mid-typing must not fight the typist ------------------------------------
check('clearing a cell cascades nothing', balanceLine(row, { net: '' }), { ...row, net: '' });
check('a lone decimal point is not a number', balanceLine(row, { net: '.' }), { ...row, net: '.' });
check('a partial number still balances', balanceLine(row, { net: '12.' }).total, '19.98');
check('a real zero IS a number', balanceLine(row, { net: '0' }).total, '7.98');

// --- A blank neighbour counts as nothing, not NaN ----------------------------
check(
  'net typed into an empty row',
  balanceLine({ description: 'x', net: '', tax: '', total: '' }, { net: '50' }).total,
  '50.00'
);

// --- Other fields are none of its business -----------------------------------
check('a description passes through', balanceLine(row, { description: 'Internet' }), { ...row, description: 'Internet' });
check('a project passes through', balanceLine(row, { project: 'GCY' }), { ...row, project: 'GCY' });

// --- cellNumber -------------------------------------------------------------
check('empty is null, not 0', cellNumber(''), null);
check('undefined is null', cellNumber(undefined), null);
check('zero is zero', cellNumber('0'), 0);
check('currency noise is stripped', cellNumber('SGD 1,234.50'), 1234.50);
check('a negative survives', cellNumber('-5.25'), -5.25);


// --- No Tax on the document means no tax on its lines -------------------------
// The per-line half of the invariant. A document coded to a zero-tax code has
// its tax folded into the cost; leaving the LINES carrying tax makes them
// contradict the document, and the publish path refuses a breakdown that
// disagrees with its own paper — so the correction locked the bill out of Xero.
{
  const rows = [
    { description: 'Lite Monthly Charges', net: '652.50', tax: '65.25', total: '717.75' },
    { description: 'Support', net: '100.00', tax: '10.00', total: '110.00' },
  ];
  const folded = foldTaxIntoCost(rows);
  check('the row is still worth what it was worth', folded[0].total, '717.75');
  check('...its tax is gone', folded[0].tax, '0.00');
  check('...and the tax is now inside the cost', folded[0].net, '717.75');
  check('every row, not just the first', folded[1], { description: 'Support', net: '110.00', tax: '0.00', total: '110.00' });

  // The two sums the publish path checks both come out right, which is the
  // whole point: rows against the document's total, their tax against its tax.
  const sum = (rows, f) => rows.reduce((t, r) => t + Number(r[f]), 0).toFixed(2);
  check('the rows still add up to the document total', sum(folded, 'total'), '827.75');
  check('...and their tax to the document tax of zero', sum(folded, 'tax'), '0.00');

  // It repairs an inconsistency; it does not fill in blanks or churn rows that
  // are already right.
  const clean = [{ description: 'Already net', net: '50.00', tax: '0.00', total: '50.00' }];
  check('a row with no tax is left alone', foldTaxIntoCost(clean)[0], clean[0]);
  const blank = [{ description: 'Nothing typed yet', net: '', tax: '', total: '' }];
  check('an empty row is left alone', foldTaxIntoCost(blank)[0], blank[0]);
  check('a non-list is not a crash', foldTaxIntoCost(null), []);
}

// --- A row that states two figures has stated the third ----------------------
// Net, Tax and Total are one row seen three ways. Stored with one missing, the
// row does not add up: the grid totals it as nothing and reports the document
// "out by" its own amount, and the publish path refuses the whole breakdown for
// failing to reconcile.
check('a net with no total is worth its net', completeLine({ net: '33', tax: '', total: '' }), { net: '33', tax: '0.00', total: '33.00' });
check('with tax, the total carries it', completeLine({ net: '100', tax: '9', total: '' }), { net: '100', tax: '9', total: '109.00' });
check('a total with no net gives the net back', completeLine({ net: '', tax: '9', total: '109' }), { net: '100.00', tax: '9', total: '109' });
check('a total and a net state the tax between them', completeLine({ net: '100', tax: '', total: '109' }), { net: '100', tax: '9.00', total: '109' });
// An empty row is somebody about to type, not a contradiction.
check('an empty row is left alone', completeLine({ description: 'x', net: '', tax: '', total: '' }), { description: 'x', net: '', tax: '', total: '' });
// A row that already adds up is not rewritten.
check('a complete row is untouched', completeLine({ net: '10', tax: '0', total: '10' }), { net: '10', tax: '0', total: '10' });
check('and other fields ride along', completeLine({ description: 'Ride fare', category: '493', net: '33', tax: '', total: '' }).description, 'Ride fare');
check('completeLines maps them', completeLines([{ net: '1', tax: '', total: '' }, { net: '2', tax: '', total: '' }]).map((r) => r.total), ['1.00', '2.00']);
check('and tolerates nothing at all', completeLines(null), []);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
