// What a quotation says future invoices are made of (src/lib/billingPlan.js),
// against the case it was written for: The Bridgers' quotation to Yakson, whose
// 2,400.00 monthly invoice is a development instalment and a subscription.
import {
  cleanPlan,
  planProblems,
  takesBillingPlan,
  matchBillingPlan,
  billingPlanPatch,
  billingPlanStatus,
  planMayWriteLines,
  stageTotalCents,
  stageProgress,
  progressText,
  planOverview,
  isPlanSource,
} from '../src/lib/billingPlan.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const DEV = '710 - Software Development';
const SUB = '485 - Subscriptions';
const plan = {
  id: 'p1',
  supplier: 'The Bridgers Pte Ltd',
  reference: 'TB_QU_YAKSON_0001',
  currency: 'SGD',
  stages: [
    {
      id: 'dev', name: 'Development', from: '2026-04-01', to: '2026-08-31',
      lines: [{ description: 'Development phase', amount: 2500, category: DEV }],
    },
    {
      id: 'sub', name: 'Subscription', from: '2026-09-01', to: '',
      lines: [
        { description: 'Development cost instalment', amount: 900, category: DEV },
        { description: 'Subscription', amount: 1500, category: SUB },
      ],
    },
  ],
};
const invoice = {
  kind: 'cost', documentType: 'Invoice', supplier: 'THE BRIDGERS PTE. LTD.', date: '2026-09-16',
  currency: 'SGD', total: 2400, tax: 0, taxRate: 'No Tax', description: 'Subscription Sep 2026', lineItems: [],
};

check('a good plan has no problems', planProblems(plan), []);
check('a line needs a category', planProblems({ ...plan, stages: [{ name: 'S', lines: [{ amount: 5 }] }] }), ['S: every line needs a category.']);
check('a supplier and a line are needed', planProblems({ stages: [] }), ['Name the supplier.', 'Add at least one line with an amount.']);
check('empty lines and stages are dropped', cleanPlan({ stages: [{ lines: [{}] }] }).stages, []);
check('what an invoice comes to', stageTotalCents(plan.stages[1]), 240000);

check('a bill is spoken about', takesBillingPlan(invoice), true);
check('the quotation itself is not', takesBillingPlan({ ...invoice, documentType: 'Quotation' }), false);
check('nor a payment proof', takesBillingPlan({ ...invoice, documentType: 'Payment proof' }), false);
check('nor a sale', takesBillingPlan({ ...invoice, kind: 'sales' }), false);

const hit = matchBillingPlan(invoice, [plan]);
check('the invoice matches the subscription', [hit.status, hit.stage.name, hit.basis], ['match', 'Subscription', 'total']);
check('split as agreed', hit.rows.map((r) => [r.category, r.net, r.tax, r.total]), [
  [DEV, '900.00', '0.00', '900.00'],
  [SUB, '1500.00', '0.00', '1500.00'],
]);
const patch = billingPlanPatch(hit);
check('the document takes the largest line’s account', patch.category, SUB);
check('and says why', patch.categoryReason, 'Billing plan TB_QU_YAKSON_0001: Subscription, 2 lines as agreed.');
check('no project where the lines name none', 'project' in patch, false);

check('a development month', matchBillingPlan({ ...invoice, date: '2026-05-01', total: 2500 }, [plan]).stage.name, 'Development');
const off = matchBillingPlan({ ...invoice, total: 3600 }, [plan]);
check('a third outlet is said, not fitted', [off.status, off.reason], [
  'mismatch',
  'Billing plan TB_QU_YAKSON_0001 expects SGD 2,400.00 (Subscription); this document is SGD 3,600.00.',
]);
check('the development fee after development', matchBillingPlan({ ...invoice, total: 2500 }, [plan]).status, 'mismatch');
check('dated before the agreement', matchBillingPlan({ ...invoice, date: '2026-01-05' }, [plan]).status, 'outside');
check('billed in another currency', matchBillingPlan({ ...invoice, currency: 'USD' }, [plan]).status, 'mismatch');
check('another supplier: nothing', matchBillingPlan({ ...invoice, supplier: 'Windee' }, [plan]), null);
check('unread: nothing', matchBillingPlan({ ...invoice, total: 0 }, [plan]), null);
check('the browser’s date spelling', matchBillingPlan({ ...invoice, date: '16/09/2026' }, [plan]).status, 'match');
check(
  'two stages that could both be meant',
  matchBillingPlan(invoice, [{ ...plan, stages: [plan.stages[1], { ...plan.stages[1], id: 'x', name: 'Renewal' }] }]).status,
  'ambiguous'
);

// GST added on top of the quoted figures.
const taxed = matchBillingPlan({ ...invoice, total: 2616, tax: 216, taxRate: 'Standard-Rated Purchases' }, [plan]);
check('matched before GST', [taxed.status, taxed.basis], ['match', 'net']);
check('GST shared by amount', taxed.rows.map((r) => [r.net, r.tax, r.total]), [
  ['900.00', '81.00', '981.00'],
  ['1500.00', '135.00', '1635.00'],
]);
const unclaimed = matchBillingPlan({ ...invoice, total: 2616, tax: 0 }, [plan], { printedTax: 216 });
check('GST nobody may claim stays in the cost', unclaimed.rows.map((r) => [r.net, r.tax, r.total]), [
  ['981.00', '0.00', '981.00'],
  ['1635.00', '0.00', '1635.00'],
]);
// Quoted GST-inclusive, one line outside GST.
const mixed = { ...plan, stages: [{ ...plan.stages[1], lines: [{ ...plan.stages[1].lines[0], taxRate: 'No Tax' }, plan.stages[1].lines[1]] }] };
check(
  'a No Tax line takes no GST',
  matchBillingPlan({ ...invoice, tax: 123.85, taxRate: 'Standard-Rated Purchases' }, [mixed]).rows.map((r) => r.tax),
  ['0.00', '123.85']
);
check(
  'GST on a plan with no taxable line is said',
  matchBillingPlan({ ...invoice, tax: 100, taxRate: 'No Tax' }, [plan]).status,
  'mismatch'
);

const outlets = {
  ...plan,
  stages: [{ id: 'o', name: 'Subscription', lines: [
    { amount: 1200, category: SUB, project: 'Wheelock' },
    { amount: 1200, category: SUB, project: 'Wheelock' },
  ] }],
};
check('a project every line shares goes on the document', billingPlanPatch(matchBillingPlan(invoice, [outlets])).project, 'Wheelock');

const coded = { ...invoice, ...patch };
check('coded from the plan', billingPlanStatus(coded, [plan]).status, 'applied');
check('coded, with GST', billingPlanStatus({ ...invoice, total: 2616, tax: 216, lineItems: taxed.rows }, [plan]).status, 'applied');
check('not yet coded', billingPlanStatus(invoice, [plan]).status, 'match');
check(
  'recoded by hand: offered again, not claimed as applied',
  billingPlanStatus({ ...coded, lineItems: [{ ...coded.lineItems[0], category: SUB }, coded.lineItems[1]] }, [plan]).status,
  'match'
);

// --- how much is left to bill ----------------------------------------------------
const run = { ...plan.stages[1], quantity: 24, billedBefore: 1 };
const counted = { ...plan, stages: [plan.stages[0], run] };
const book = [
  { ...invoice, id: 'b', invoiceNumber: 'INV-0014', date: '2026-10-16' },
  { ...coded, id: 'a', invoiceNumber: 'INV-0013' },
  { ...invoice, id: 'c', invoiceNumber: 'inv 0013' },
  { ...invoice, id: 'd', invoiceNumber: 'INV-0015', status: 'deleted' },
  { ...invoice, id: 'e', invoiceNumber: 'INV-0016', duplicateOfId: 'a' },
  { ...invoice, id: 'f', invoiceNumber: 'INV-0017', total: 3600 },
  { ...invoice, id: 'g', documentType: 'Quotation' },
  { ...invoice, id: 'h', supplier: 'Windee' },
];
const sofar = stageProgress(counted, run, book);
check('oldest first, each invoice number once', sofar.invoices.map((d) => d.id), ['a', 'b']);
check('with what was billed elsewhere', [sofar.billed, sofar.left, sofar.over], [3, 21, 0]);
check('said in words', progressText(sofar, run, 'SGD'), '3 of 24 billed · 21 left (SGD 50,400.00)');
check('all billed', progressText(stageProgress(counted, { ...run, quantity: 3 }, book), run, 'SGD'), 'All 3 billed');
check('one more than agreed', progressText(stageProgress(counted, { ...run, quantity: 2 }, book), run, 'SGD'), '3 billed, 1 more than the 2 agreed');
const open = stageProgress(counted, plan.stages[1], book);
check('no quantity: counted, nothing said to be left', [open.billed, open.left, progressText(open, plan.stages[1], 'SGD')], [2, null, '']);
check('a stage keeps its own dates', stageProgress(counted, plan.stages[0], book).invoices.length, 0);
check('quantities are whole numbers', cleanPlan({ stages: [{ quantity: '24', billedBefore: -2, lines: [{ amount: 1 }] }] }).stages.map((s) => [s.quantity, s.billedBefore]), [[24, 0]]);
check(
  'more billed than agreed is refused',
  planProblems({ ...plan, stages: [{ ...run, quantity: 2, billedBefore: 3 }] }),
  ['Subscription: more invoices already billed than the stage runs to.']
);

const seenAs = planOverview(counted, book);
check('the page: each stage with its invoices', seenAs.stages.map((s) => [s.stage.name, s.invoices.map((i) => [i.doc.id, i.place, i.coded])]), [
  ['Development', []],
  ['Subscription', [['a', 2, true], ['b', 3, false]]],
]);
check('…invoiced and still to come', [seenAs.stages[1].invoicedCents, seenAs.stages[1].leftCents, seenAs.leftCents], [480000, 5040000, 5040000]);
check('…and what the plan does not explain', seenAs.differing.map((x) => x.doc.id), ['f']);
const other = { ...counted, id: 'p2', stages: [{ id: 'z', name: 'Extra', lines: [{ amount: 3600, category: SUB }] }] };
check('a second agreement claims its own invoices', planOverview(counted, book, [counted, other]).differing, []);
const twice = { ...counted, stages: [run, { ...run, id: 'again', name: 'Renewal' }] };
check('two stages that could both mean it: neither counts it', stageProgress(twice, run, [book[0]]).invoices.length, 0);

// --- a plan typed by hand --------------------------------------------------------
check('a quotation is what a plan is recorded from', [isPlanSource({ type: 'Quotation' }), isPlanSource({ documentType: 'Other' }), isPlanSource({ type: 'Invoice' }), isPlanSource(null)], [true, true, false, false]);
check('typed while looking at an invoice: that invoice still counts', stageProgress({ ...counted, sourceBillId: 'a' }, run, book).invoices.map((d) => d.id), ['a', 'b']);
check(
  'the agreement it was read from does not',
  stageProgress({ ...counted, sourceBillId: 'z' }, run, [{ ...invoice, id: 'z', documentType: 'Other', invoiceNumber: 'AGR-1' }, ...book]).invoices.map((d) => d.id),
  ['a', 'b']
);

check('no rows: a read may write them', planMayWriteLines([], 2400), true);
check('rows that do not add up: replaced', planMayWriteLines([{ total: '100' }], 2400), true);
check('rows that add up are somebody’s', planMayWriteLines([{ total: '2400.00' }], 2400), false);

process.exit(failures ? 1 : 0);
