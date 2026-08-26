import { categoryCode } from '@/lib/categoryList';

// A standard Xero chart of accounts (expense / direct-cost / overhead
// accounts), used as the categorisation taxonomy for OCR. Each account carries
// its Xero description — the reader uses those descriptions to classify an expense
// into the single best-matching account. Codes follow Xero's default chart, so
// they line up with a Xero org on the standard chart at publish time. When an
// org is linked to Xero, its live chart can be used instead (same shape).

export const XERO_ACCOUNTS = [
  { code: '300', name: 'Purchases', type: 'DIRECTCOSTS', description: 'Goods purchased with the intention of selling these to customers' },
  { code: '310', name: 'Cost of Goods Sold', type: 'DIRECTCOSTS', description: 'Cost of goods sold by the business' },
  { code: '400', name: 'Advertising', type: 'EXPENSE', description: 'Expenses incurred for advertising while trying to increase sales' },
  { code: '404', name: 'Bank Fees', type: 'EXPENSE', description: 'Fees charged by your bank for transactions regarding your bank account(s)' },
  { code: '408', name: 'Cleaning', type: 'EXPENSE', description: 'Expenses incurred for cleaning business property' },
  { code: '412', name: 'Consulting & Accounting', type: 'EXPENSE', description: 'Expenses related to paying consultants or accountants' },
  { code: '420', name: 'Entertainment', type: 'EXPENSE', description: 'Client and staff entertainment, meals and events not otherwise deductible' },
  { code: '425', name: 'Freight & Courier', type: 'EXPENSE', description: 'Expenses incurred on courier and freight costs' },
  { code: '429', name: 'General Expenses', type: 'EXPENSE', description: 'General expenses related to the running of the business that do not fit another account' },
  { code: '433', name: 'Insurance', type: 'EXPENSE', description: "Expenses incurred for insuring the business' assets" },
  { code: '441', name: 'Legal Expenses', type: 'EXPENSE', description: 'Expenses incurred on any legal matters' },
  { code: '445', name: 'Light, Power, Heating', type: 'EXPENSE', description: 'Utilities: expenses incurred for lighting, powering or heating the premises' },
  { code: '449', name: 'Motor Vehicle Expenses', type: 'EXPENSE', description: 'Expenses incurred on the running of company motor vehicles, fuel and parking' },
  { code: '453', name: 'Office Expenses', type: 'EXPENSE', description: 'General office running costs and supplies' },
  { code: '455', name: 'Meals & Staff Amenities', type: 'EXPENSE', description: 'Meals, food, drinks, pantry and staff amenities for the business' },
  { code: '461', name: 'Printing & Stationery', type: 'EXPENSE', description: 'Expenses incurred by the entity as a result of printing and stationery' },
  { code: '463', name: 'IT Software and Consumables', type: 'EXPENSE', description: 'Software licences, SaaS subscriptions, apps and small IT consumables' },
  { code: '469', name: 'Rent', type: 'EXPENSE', description: 'The payment to lease a building or area' },
  { code: '473', name: 'Repairs and Maintenance', type: 'EXPENSE', description: 'Expenses incurred to repair or maintain an asset back to its original condition' },
  { code: '485', name: 'Subscriptions', type: 'EXPENSE', description: 'Subscriptions to professional bodies, memberships and publications' },
  { code: '489', name: 'Telephone & Internet', type: 'EXPENSE', description: 'Business phone calls, phone lines, mobile plans and internet connections' },
  { code: '493', name: 'Travel - National', type: 'EXPENSE', description: 'Domestic travel with a business purpose: taxis, ride-hailing, trains, buses, flights and accommodation' },
  { code: '494', name: 'Travel - International', type: 'EXPENSE', description: 'International travel with a business purpose: flights, accommodation and transport' },
  { code: '501', name: 'Uniforms & Protective Equipment', type: 'EXPENSE', description: 'Work uniforms, PPE and safety equipment for staff' },
];

// "429 - General Expenses" — the label used in the Category dropdowns.
export function accountLabel(a) {
  return `${a.code} - ${a.name}`;
}

// Category-dropdown labels for the whole chart.
export const XERO_CATEGORY_LABELS = XERO_ACCOUNTS.map(accountLabel);

// Pull the leading Xero account code out of a "429 - General Expenses" (or
// "200-10 - Sales - Projects") label. Returns '' for a category that carries no
// code — "Uncategorised", or a bridge entity's plain "Transport - Taxi".
export const accountCodeFromCategory = categoryCode;
