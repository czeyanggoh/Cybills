// The IRAS GST register check, the pure half: which costs are asked about, what
// is asked, and what an answer may change.
import {
  gstCheckApplies,
  gstCheckAsk,
  gstCheckKey,
  judgeGstAnswer,
  contactGstPatch,
  numberNamesSupplier,
  registeredNameFor,
  contactHoldsNumber,
} from '../src/lib/gstRegisterCheck.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const doc = {
  kind: 'cost', status: 'ready', supplier: 'Acme Hardware Pte Ltd', date: '2026-11-20',
  supplierGstRegNo: '201512345M', taxLabel: 'GST 9%', tax: 9, total: 109, documentType: 'Invoice',
};

// --- Which documents ---------------------------------------------------------
check('a cost with a Singapore number', gstCheckApplies(doc), true);
check('GST printed, no number', gstCheckApplies({ ...doc, supplierGstRegNo: '' }), true);
check('a number printed but already coded No Tax', gstCheckApplies({ ...doc, tax: 0, taxLabel: '' }), true);
check('no GST shown at all', gstCheckApplies({ ...doc, supplierGstRegNo: '', taxLabel: '', tax: 0 }), false);
check('a foreign tax', gstCheckApplies({ ...doc, taxLabel: 'VAT 7%' }), false);
check('a foreign registration', gstCheckApplies({ ...doc, supplierGstRegNo: '51 824 753 556' }), false);
check('published', gstCheckApplies({ ...doc, xeroInvoiceId: 'x' }), false);
check('a sales document', gstCheckApplies({ ...doc, kind: 'sales' }), false);
check('on a claim', gstCheckApplies({ ...doc, status: 'expenseclaim' }), false);
check('motor vehicle', gstCheckApplies({ ...doc, motorVehicle: true }), false);
check('a payment proof', gstCheckApplies({ ...doc, documentType: 'Payment proof' }), false);
check('nobody named', gstCheckApplies({ ...doc, supplier: 'Unknown supplier' }), false);

// --- What is asked, and where the number came from ---------------------------
check('printed on the paper', gstCheckAsk(doc), {
  source: 'paper', body: { reg_id: '201512345M', supplier_name: 'Acme Hardware Pte Ltd', date: '2026-11-20' },
});
check('from a rule', gstCheckAsk({ ...doc, supplierGstRegNoRemembered: true, supplierGstRegNoFrom: 'rule' }).source, 'rule');
check('from an earlier document', gstCheckAsk({ ...doc, supplierGstRegNoRemembered: true, supplierGstRegNoFrom: 'document' }).source, 'memory');
check('no number: by name', gstCheckAsk({ ...doc, supplierGstRegNo: '' }).source, 'name');

check('the question changes with the number', gstCheckKey(doc) === gstCheckKey({ ...doc, supplierGstRegNo: '201599999Z' }), false);
check('and with the date', gstCheckKey(doc) === gstCheckKey({ ...doc, date: '2026-11-21' }), false);
check('not with the spelling of the name', gstCheckKey(doc), gstCheckKey({ ...doc, supplier: 'ACME HARDWARE PTE. LTD.' }));

// --- What an answer may do ---------------------------------------------------
const answer = (on_date, name = 'ACME HARDWARE PTE. LTD.') => ({
  matched: true, on_date, result: { name, gst_reg_no: '201512345M' },
});
const judge = (a, source) => judgeGstAnswer(a, { source, supplier: doc.supplier });

check('registered, on the paper, name agreeing: saved by itself', judge(answer('yes'), 'paper'),
  { verdict: 'registered', hold: false, autoSave: true, confirmable: false, nameMatches: true });
check('a different name waits for a person', judge(answer('yes', 'OTHER CO PTE. LTD.'), 'paper').autoSave, false);
check('…but can be saved', judge(answer('yes', 'OTHER CO PTE. LTD.'), 'paper').confirmable, true);
check('found by name waits for a person', judge(answer('yes'), 'name').confirmable, true);
check('a remembered number waits for a person', judge(answer('yes'), 'memory').autoSave, false);
check('not registered on the paper number: held', judge(answer('no'), 'paper').hold, true);
check('not registered on a rule number: held', judge(answer('no'), 'rule').hold, true);
check('not registered by NAME: nothing changes', judge(answer('no'), 'name').hold, false);
check('unknown changes nothing', judge(answer('unknown'), 'paper'),
  { verdict: 'unknown', hold: false, autoSave: false, confirmable: false, nameMatches: true });
check('no match', judge({ matched: false }, 'name').verdict, 'no_match');

// --- The contact -------------------------------------------------------------
const numbers = { gstRegNo: '201512345M', uen: '201512345M' };
check('a blank contact takes both', contactGstPatch({}, numbers), { TaxNumber: '201512345M', CompanyNumber: '201512345M' });
check('nothing Xero holds is replaced', contactGstPatch({ TaxNumber: 'X', CompanyNumber: 'Y' }, numbers), {});
check('an M-number is not a UEN', contactGstPatch({}, { gstRegNo: 'M90370287L', uen: 'M90370287L' }), { TaxNumber: 'M90370287L' });

// --- A new supplier's name ---------------------------------------------------
check('a printed number may name the supplier', numberNamesSupplier(doc), true);
check('a remembered one may not', numberNamesSupplier({ ...doc, supplierGstRegNoRemembered: true }), false);
check('nor the buyer’s own', numberNamesSupplier(doc, ['201512345M']), false);
check('nor the number printed for the bill-to party', numberNamesSupplier({ ...doc, billedToRegNo: '201512345 M' }), false);
check('nor no number', numberNamesSupplier({ ...doc, supplierGstRegNo: '' }), false);
const reg = (name, extra = {}) => ({ matched: true, result: { outcome: 'registered', name }, ...extra });
check('ACRA’s name first', registeredNameFor(doc, reg('IRAS NAME PTE. LTD.', { registered_name: 'ACRA NAME PTE. LTD.' })), 'ACRA NAME PTE. LTD.');
check('else IRAS’s', registeredNameFor(doc, reg('IRAS NAME PTE. LTD.')), 'IRAS NAME PTE. LTD.');
check('the same name in another spelling changes nothing', registeredNameFor(doc, reg('ACME HARDWARE PTE. LTD.')), '');
check('a hidden name is not a name', registeredNameFor(doc, reg('T** B**')), '');
check('not registered names nobody', registeredNameFor(doc, { matched: true, registered_name: 'X PTE. LTD.', result: { outcome: 'not_registered' } }), '');
check('a contact holding the number', contactHoldsNumber({ TaxNumber: '2015-12345-M' }, ['201512345M']), true);
check('a blank contact holds none', contactHoldsNumber({}, ['', '201512345M']), false);

check('a contact’s number, when the document has none', gstCheckAsk({ ...doc, supplierGstRegNo: '' }, '201512345M').source, 'contact');
check('…holds nothing and saves nothing', judge(answer('no'), 'contact').hold || judge(answer('yes'), 'contact').confirmable, false);

process.exit(failures ? 1 : 0);
