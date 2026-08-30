// The tax-information block a foreign-currency invoice restates itself in.
//
// A Singapore GST-registered supplier billing in USD has to print what the
// supply is worth in SGD, because that is the figure its customer puts in a SGD
// GST return:
//
//   Total Charges (excluding VAT)   SGD 20.36
//   Total GST                       SGD  1.84
//   Total Charges (including GST)   SGD 22.20
//   Exchange rate: 1 USD = 1.29300000008314 SGD
//
// Two things ride on reading it: the GST percentage (the SGD pair is exact,
// the USD pair is that divided by the rate and rounded), and the rate itself,
// which is published to Xero so the ledger reports the tax the paper states.
// Both make a misread expensive, so the block is kept only when its own halves
// agree.
import { restatement } from '../src/extract.ts';

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const NONE = { baseCurrency: '', baseTotal: 0, baseTax: 0, exchangeRate: 0 };

// The Microsoft invoice, as read.
check('the block is kept whole', restatement({
  currency: 'USD', total: 17.17,
  baseCurrency: 'SGD', baseTotal: 22.2, baseTax: 1.84, exchangeRate: 1.29300000008314,
}), { baseCurrency: 'SGD', baseTotal: 22.2, baseTax: 1.84, exchangeRate: 1.29300000008314 });

// Either half can stand in for the other: the rate alone says what the totals
// would have said, and the totals alone say what the rate was.
check('totals with no printed rate', restatement({
  currency: 'USD', total: 17.17, baseCurrency: 'SGD', baseTotal: 22.2, baseTax: 1.84,
}).exchangeRate.toFixed(4), '1.2930');
check('a rate with no printed totals', restatement({
  currency: 'USD', total: 17.17, baseCurrency: 'SGD', exchangeRate: 1.293,
}), { baseCurrency: 'SGD', baseTotal: 22.2, baseTax: 0, exchangeRate: 1.293 });

// A block that contradicts the invoice it sits on is a misread. Publishing its
// rate would restate the bill in a live ledger, so nothing is kept at all.
check('a rate that does not carry the total is dropped', restatement({
  currency: 'USD', total: 17.17, baseCurrency: 'SGD', baseTotal: 22.2, baseTax: 1.84, exchangeRate: 4.7,
}), NONE);
check('a tax that is not inside its total is dropped', restatement({
  currency: 'USD', total: 17.17, baseCurrency: 'SGD', baseTotal: 22.2, baseTax: 90, exchangeRate: 1.293,
}), NONE);
check('a cent of rounding is not a contradiction', restatement({
  currency: 'USD', total: 17.17, baseCurrency: 'SGD', baseTotal: 22.19, baseTax: 1.84, exchangeRate: 1.293,
}).baseTotal, 22.19);

// Nothing to restate: the same currency said twice, or no second currency at
// all. Both are the ordinary document, and both must leave the fields empty —
// a rate of 1 sent to Xero is not the same as sending none.
check('the same currency is not a restatement', restatement({
  currency: 'SGD', total: 22.2, baseCurrency: 'SGD', baseTotal: 22.2, baseTax: 1.84, exchangeRate: 1,
}), NONE);
check('no block at all', restatement({ currency: 'USD', total: 17.17 }), NONE);
check('a currency with no figures under it', restatement({ currency: 'USD', total: 17.17, baseCurrency: 'SGD' }), NONE);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
