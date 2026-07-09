// Mock extracted cost documents, shared by the Costs list and the detail view.
// UI only — these stand in for OCR output until a real extraction backend
// (e.g. Claude Vision) is wired up.
export const DOCS = [
  { id: 1, itemId: '21121225280', unread: true, status: 'new', user: 'Ethan Chew', date: '09 Jul 2026', supplier: 'Grab', type: 'Receipt', category: 'Transport - Taxi', currency: 'SGD', total: '60.80', tax: '0.00' },
  { id: 2, itemId: '21121225281', status: 'viewed', user: 'Ethan Chew', date: '07 Jul 2026', supplier: 'Grab', type: 'Receipt', category: 'Transport - Taxi', currency: 'SGD', total: '65.90', tax: '0.00' },
  { id: 3, itemId: '21121225282', status: 'ready', user: 'Kang Seng Tan', date: '07 Jul 2026', supplier: 'Grab', type: 'Receipt', category: 'Transport - Taxi', currency: 'SGD', total: '15.70', tax: '0.00' },
  { id: 4, itemId: '21121225283', unread: true, status: 'new', user: 'Faith Tan', date: '02 Jul 2026', supplier: 'Taxi Receipt', type: 'Receipt', category: 'Transport - Taxi', currency: 'SGD', total: '36.04', tax: '2.36' },
  { id: 5, itemId: '21121225284', status: 'viewed', user: 'Ethan Chew', date: '06 Jul 2026', supplier: 'Grab', type: 'Receipt', category: 'Transport - Taxi', currency: 'SGD', total: '72.40', tax: '0.00' },
  { id: 6, itemId: '21121225285', status: 'ready', user: 'Geraldine Lee', date: '10 Jun 2026', supplier: 'Trip.com Travel Singapore', type: 'Invoice', category: 'Others', currency: 'SGD', total: '762.55', tax: '49.90' },
  { id: 7, itemId: '21121225286', status: 'ready', user: 'Jia Qi Lee', date: '03 Jun 2026', supplier: 'Taxi Receipt', type: 'Receipt', category: 'Transport - Taxi', currency: 'SGD', total: '49.50', tax: '3.24' },
  { id: 8, itemId: '21121225287', status: 'review', user: 'Ethan Chew', date: '01 Jun 2026', supplier: 'Amazon Web Services', type: 'Invoice', category: 'Software', currency: 'SGD', total: '1,240.00', tax: '81.16' },
  { id: 9, itemId: '21121225288', status: 'review', user: 'Faith Tan', date: '28 May 2026', supplier: 'SingTel', type: 'Invoice', category: 'Utilities', currency: 'SGD', total: '96.30', tax: '6.30' },
];

export function getDoc(id) {
  return DOCS.find((d) => String(d.id) === String(id));
}
