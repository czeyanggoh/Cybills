// Expense claims for the Costs → Expense claims view. Each claim carries its
// line-item transactions and an activity history so the detail page + exported
// PDF can be rendered. `total`/`tax`/`net` are the claim rollups (SGD).

function sum(txns, key) {
  return txns.reduce((n, t) => n + Number(t[key] || 0), 0).toFixed(2);
}

const foodTxns = [
  { date: '11 Jul 2026', itemId: '21152768590', supplier: 'Yew Kee Specialities', category: 'Meal Weekend & PH', project: '', net: '6.24', tax: '0.56', total: '6.80', status: 'ready' },
];

const taxiTxns = [
  { date: '29 Jun 2026', itemId: '21009218170', supplier: 'Taxi Receipt', category: 'Transport - Taxi', project: 'ESTP 02', net: '26.50', tax: '0.00', total: '26.50', status: 'ready' },
  { date: '29 Jun 2026', itemId: '21009218270', supplier: 'Grab', category: 'Transport - Taxi', project: 'ESTP 02', net: '47.00', tax: '0.00', total: '47.00', status: 'ready' },
  { date: '01 Jul 2026', itemId: '21040291130', supplier: 'Taxi Receipt', category: 'Transport - Taxi', project: 'ESTP 02', net: '68.80', tax: '0.00', total: '68.80', status: 'ready' },
  { date: '01 Jul 2026', itemId: '21040291140', supplier: 'Taxi Receipt', category: 'Transport - Taxi', project: 'ESTP 02', net: '37.10', tax: '0.00', total: '37.10', status: 'ready' },
  { date: '02 Jul 2026', itemId: '21053219830', supplier: 'Taxi Receipt', category: 'Transport - Taxi', project: 'ESTP 02', net: '50.00', tax: '0.00', total: '50.00', status: 'ready' },
  { date: '02 Jul 2026', itemId: '21053219840', supplier: 'Taxi Receipt', category: 'Transport - Taxi', project: 'ESTP 02', net: '31.30', tax: '0.00', total: '31.30', status: 'ready' },
  { date: '03 Jul 2026', itemId: '21069127230', supplier: 'Taxi Receipt', category: 'Transport - Taxi', project: 'ESTP 02', net: '49.50', tax: '0.00', total: '49.50', status: 'ready' },
  { date: '10 Jul 2026', itemId: '21139068200', supplier: 'Taxi Receipt', category: 'Transport - Taxi', project: 'ESTP 02', net: '46.80', tax: '0.00', total: '46.80', status: 'ready' },
];

// Build the "added to claim" + "created" activity list from the transactions.
function addedHistory(txns, by, at = 'Today at 08:37', createdAt = 'Today at 08:37') {
  return [
    ...txns.map((t) => ({ text: `Item ${t.itemId} was added to the expense claim`, by, at })),
    { text: 'This expense claim was created', by, at: createdAt },
  ];
}

export const CLAIMS = [
  {
    id: '21154564340', claimFor: 'Astrid Yang', type: 'Regular', name: 'Food',
    claimDate: '15 Jul 2026', endDate: '15 Jul 2026', currency: 'SGD',
    net: sum(foodTxns, 'net'), tax: sum(foodTxns, 'tax'), total: sum(foodTxns, 'total'),
    transactions: foodTxns,
    history: [
      { text: 'Item 21152768590 was added to the expense claim', by: 'Astrid Yang', at: 'Today at 10:45' },
      { text: 'This expense claim was created', by: 'Astrid Yang', at: 'Last Monday at 15:44' },
    ],
  },
  {
    id: '21177964810', claimFor: 'Jia Qi Lee ESTP 02', type: 'Regular', name: 'claim ending 20jul',
    claimDate: '20 Jul 2026', endDate: '20 Jul 2026', currency: 'SGD',
    net: sum(taxiTxns, 'net'), tax: sum(taxiTxns, 'tax'), total: sum(taxiTxns, 'total'),
    transactions: taxiTxns,
    history: addedHistory(taxiTxns, 'Jia Qi Lee ESTP 02'),
  },
  {
    id: '21149916630', claimFor: 'Weng Hong Yap', type: 'Regular', name: '11 July Expenses',
    claimDate: '11 Jul 2026', endDate: '11 Jul 2026', currency: 'SGD',
    net: '15.23', tax: '1.37', total: '16.60',
    transactions: [
      { date: '11 Jul 2026', itemId: '21147036440', supplier: 'Yew Kee Specialities', category: 'Meals & Entertainment', project: '', net: '15.23', tax: '1.37', total: '16.60', status: 'ready' },
    ],
    history: addedHistory([{ itemId: '21147036440' }], 'Weng Hong Yap', 'Today at 09:12', 'Today at 09:10'),
  },
  {
    id: '21150482270', claimFor: 'Yong Ding Tan', type: 'Regular', name: 'htx to home (2nd week)',
    claimDate: '26 Jul 2026', endDate: '26 Jul 2026', currency: 'SGD',
    net: '96.50', tax: '0.00', total: '96.50',
    transactions: [
      { date: '19 Jul 2026', itemId: '21149480790', supplier: 'Gojek', category: 'Transport - Taxi', project: '', net: '48.10', tax: '0.00', total: '48.10', status: 'ready' },
      { date: '20 Jul 2026', itemId: '21149480800', supplier: 'Gojek', category: 'Transport - Taxi', project: '', net: '48.40', tax: '0.00', total: '48.40', status: 'ready' },
    ],
    history: addedHistory([{ itemId: '21149480790' }, { itemId: '21149480800' }], 'Yong Ding Tan', 'Today at 07:55', 'Yesterday at 18:20'),
  },
  {
    id: '21151773640', claimFor: 'Clara Lee', type: 'Regular', name: 'Transport Expense',
    claimDate: '31 Jul 2026', endDate: '31 Jul 2026', currency: 'SGD',
    net: '57.90', tax: '0.00', total: '57.90',
    transactions: [
      { date: '15 Jul 2026', itemId: '21151773600', supplier: 'Grab', category: 'Transport - Taxi', project: '', net: '31.40', tax: '0.00', total: '31.40', status: 'ready' },
      { date: '18 Jul 2026', itemId: '21151773620', supplier: 'ComfortDelGro', category: 'Transport - Taxi', project: '', net: '26.50', tax: '0.00', total: '26.50', status: 'ready' },
    ],
    history: addedHistory([{ itemId: '21151773600' }, { itemId: '21151773620' }], 'Clara Lee', 'Today at 11:02', 'Last Friday at 14:30'),
  },
  {
    id: '21152004480', claimFor: 'Clara Lee', type: 'Regular', name: 'PPE Expense',
    claimDate: '31 Jul 2026', endDate: '31 Jul 2026', currency: 'SGD',
    net: '70.50', tax: '6.35', total: '76.85',
    transactions: [
      { date: '22 Jul 2026', itemId: '21152004400', supplier: 'Horme Hardware', category: 'PPE Safety', project: '', net: '70.50', tax: '6.35', total: '76.85', status: 'ready' },
    ],
    history: addedHistory([{ itemId: '21152004400' }], 'Clara Lee', 'Today at 13:40', 'Today at 13:35'),
  },
  {
    id: '21152238910', claimFor: 'Alex Tan Jun Rong', type: 'Regular', name: 'Taxi claim for night CR',
    claimDate: '07 Jul 2026', endDate: '07 Jul 2026', currency: 'SGD',
    net: '13.40', tax: '0.00', total: '13.40',
    transactions: [
      { date: '05 Jul 2026', itemId: '21152238900', supplier: 'Grab', category: 'Transport - Taxi', project: '', net: '13.40', tax: '0.00', total: '13.40', status: 'ready' },
    ],
    history: addedHistory([{ itemId: '21152238900' }], 'Alex Tan Jun Rong', 'Last Monday at 22:10', 'Last Monday at 22:05'),
  },
];

export function getClaim(id) {
  return CLAIMS.find((c) => String(c.id) === String(id)) || null;
}
