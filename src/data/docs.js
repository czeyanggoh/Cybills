// Mock extracted cost documents, shared by the Costs list and the detail view.
// UI only — these stand in for OCR output until a real extraction backend
// (Claude or OpenAI) is wired up. `status` drives which Costs tab a row
// appears under: new/viewed -> Inbox, review -> To review, ready -> Ready,
// expenseclaim -> Archive.
export const DOCS = [
  { id: 1, itemId: '21121225280', unread: true, status: 'new', user: 'Ethan Chew', date: '09 Jul 2026', supplier: 'Grab', type: 'Receipt', category: 'Transport - Taxi', currency: 'SGD', total: '60.80', tax: '0.00' },
  { id: 2, itemId: '21121225281', status: 'viewed', user: 'Ethan Chew', date: '07 Jul 2026', supplier: 'Grab', type: 'Receipt', category: 'Transport - Taxi', currency: 'SGD', total: '65.90', tax: '0.00' },
  { id: 3, itemId: '21121225282', status: 'ready', user: 'Kang Seng Tan', date: '07 Jul 2026', supplier: 'Grab', type: 'Receipt', category: 'Transport - Taxi', currency: 'SGD', total: '15.70', tax: '0.00' },
  { id: 4, itemId: '21121225283', unread: true, status: 'new', user: 'Faith Tan', date: '02 Jul 2026', supplier: 'Taxi Receipt', type: 'Receipt', category: 'Transport - Taxi', currency: 'SGD', total: '36.04', tax: '2.36' },
  { id: 5, itemId: '21121225284', status: 'viewed', user: 'Ethan Chew', date: '06 Jul 2026', supplier: 'Grab', type: 'Receipt', category: 'Transport - Taxi', currency: 'SGD', total: '72.40', tax: '0.00' },
  { id: 6, itemId: '21121225285', status: 'ready', user: 'Geraldine Lee', date: '10 Jun 2026', supplier: 'Trip.com Travel Singapore', type: 'Invoice', category: 'Others', currency: 'SGD', total: '762.55', tax: '49.90' },
  { id: 7, itemId: '21121225286', status: 'ready', user: 'Jia Qi Lee', date: '03 Jun 2026', supplier: 'Taxi Receipt', type: 'Receipt', category: 'Transport - Taxi', currency: 'SGD', total: '49.50', tax: '3.24' },

  // To review — meal claims
  { id: 8, itemId: '21121225287', unread: true, status: 'review', user: 'Wei Jie Koh', date: '11 Jul 2026', supplier: 'Yew Kee Two', type: 'Receipt', category: 'Meal Weekend & PH', currency: 'SGD', total: '5.80', tax: '0.48' },
  { id: 9, itemId: '21121225288', unread: true, status: 'review', user: 'Weng Hong Yap', date: '11 Jul 2026', supplier: 'Yew Kee Two', type: 'Receipt', category: 'Meal Weekend & PH', currency: 'SGD', total: '7.30', tax: '0.60' },
  { id: 10, itemId: '21121225289', status: 'review', user: 'Wei Jie Koh', date: '11 Jul 2026', supplier: 'My Kampung', type: 'Receipt', category: 'Meal Weekend & PH', currency: 'SGD', total: '2.70', tax: '0.22' },
  { id: 11, itemId: '21121225290', unread: true, status: 'review', user: 'Wei Jie Koh', date: '11 Jul 2026', supplier: 'Yew Kee Specialities', type: 'Receipt', category: 'Meal Weekend & PH', currency: 'SGD', total: '6.80', tax: '0.56' },
  { id: 12, itemId: '21121225291', unread: true, status: 'review', user: 'Weng Hong Yap', date: '11 Jul 2026', supplier: 'My Kampung', type: 'Receipt', category: '', currency: 'SGD', total: '2.80', tax: '0.23' },

  // Archive — already published into an expense claim
  { id: 13, itemId: '21121225292', status: 'expenseclaim', user: 'Yong Ding Tan', date: '07 Jul 2026', supplier: 'Gojek', type: 'Receipt', category: 'Transport - Taxi', currency: 'SGD', total: '48.40', tax: '0.00' },
  { id: 14, itemId: '21121225293', status: 'expenseclaim', user: 'Yong Ding Tan', date: '08 Jul 2026', supplier: 'Gojek', type: 'Receipt', category: 'Transport - Taxi', currency: 'SGD', total: '48.10', tax: '0.00' },
  { id: 15, itemId: '21121225294', status: 'expenseclaim', user: 'Clara Lee', date: '11 Jul 2026', supplier: 'Grab', type: 'Receipt', category: 'Transport - Taxi', currency: 'SGD', total: '57.90', tax: '0.00' },
  { id: 16, itemId: '21121225295', status: 'expenseclaim', user: 'Clara Lee', date: '03 Jul 2026', supplier: 'Soteria Technology', type: 'Invoice', category: 'PPE Safety', currency: 'SGD', total: '76.85', tax: '6.34' },
  { id: 17, itemId: '21121225296', status: 'expenseclaim', user: 'Desmond Tan', date: '10 Jul 2026', supplier: 'Grab', type: 'Receipt', category: 'Transport - Taxi', currency: 'SGD', total: '38.60', tax: '0.00' },
  { id: 18, itemId: '21121225297', status: 'expenseclaim', user: 'codey lim', date: '23 Jun 2026', supplier: 'Grab', type: 'Receipt', category: 'Transport - Taxi', currency: 'SGD', total: '22.60', tax: '0.00' },
];

export function getDoc(id) {
  return DOCS.find((d) => String(d.id) === String(id));
}
