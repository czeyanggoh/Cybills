// A line of an itemised table has to agree with itself: net + tax = total,
// whichever of the three somebody just typed.
import { balanceLine, cellNumber } from '../src/lib/lineItems.js';

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

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
