// Mock sales documents for the Sales inbox (UI only). Each carries the fields
// the detail view shows (item id, type, due date, amounts, payer, etc.).
export const SALES = [
  {
    id: 's1',
    status: 'viewed',
    user: 'Benedict Lim ASTP 06',
    date: '20 Nov 2025',
    time: '01:26PM',
    customer: 'ST Engineering Info-Security Pte.Ltd.',
    category: 'Transport - Taxi',
    ref: 'A-8KQL3KBGWILTAV',
    itemId: '18779633990',
    type: 'Sales invoice',
    dueDate: '27 Nov 2025',
    project: 'ASTP 06',
    currency: 'SGD',
    total: '20.60',
    tax: '0.00',
    payer: 'Rasul Bin Subadah',
    card: 'Mastercard · 5889',
  },
  {
    id: 's2',
    status: 'viewed',
    user: 'Benedict Lim ASTP 06',
    date: '18 Nov 2025',
    time: '09:12AM',
    customer: 'ST Engineering Info-Security Pte.Ltd.',
    category: 'Transport - Taxi',
    ref: 'A-8KIWWGXWWQ',
    itemId: '18779580120',
    type: 'Sales invoice',
    dueDate: '25 Nov 2025',
    project: 'ASTP 06',
    currency: 'SGD',
    total: '18.40',
    tax: '0.00',
    payer: 'Rasul Bin Subadah',
    card: 'Mastercard · 5889',
  },
];

export function getSale(id) {
  return SALES.find((s) => String(s.id) === String(id)) || null;
}
