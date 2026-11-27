// The IRAS GST register check, the pure half: which costs are checked, what is
// asked, and what an answer may change (Cze, 27 Nov 2026). The calls and the
// store are server/src/gstCheck.ts; IRAS is asked through cyworkspace.
//
// A cost is checked when its supplier's Xero contact holds NO GST number
// (Tax Identification Number). With a Singapore number to hand, that number is
// asked about; without one, cyworkspace looks the supplier's name up in ACRA.
//
// What an answer may do:
//   - the number came from the document, a supplier rule or an earlier read, and
//     IRAS says the supplier was NOT registered on the invoice date: the cost is
//     held at No Tax;
//   - registered, the number printed on THIS document and IRAS's name agreeing:
//     the numbers are saved to the Xero contact at publish, by themselves;
//   - registered any other way (found by name, a remembered number, a name that
//     differs): saved only when a person presses Save;
//   - found by name and not registered: nothing changes, since the match may be
//     the wrong business.

import { isSingaporeGstRegNo, looksLikeGst } from './taxRateRules.js';
import { normaliseSupplier } from './supplierDuplicates.js';

const num = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
const compact = (v) => String(v ?? '').toUpperCase().replace(/[\s.-]/g, '');

// What a check was about. A change of supplier, number or date makes it a
// different question, and the earlier answer stops applying.
export function gstCheckKey(doc) {
  return [normaliseSupplier(doc?.supplier), compact(doc?.supplierGstRegNo), String(doc?.date ?? '').trim()].join('|');
}

const SET_ASIDE = ['deleted', 'merged', 'expenseclaim'];

// Whether this document is one the register has anything to say about: a cost,
// still unpublished, from a named supplier, that shows Singapore GST.
export function gstCheckApplies(doc) {
  if (!doc || (doc.kind || 'cost') !== 'cost' || doc.xeroInvoiceId) return false;
  if (SET_ASIDE.includes(String(doc.status || ''))) return false;
  // No Tax whatever the register says.
  if (doc.motorVehicle === true || doc.medicalProvider === true) return false;
  if (/payment proof|quotation|pro.?forma/i.test(String(doc.documentType || ''))) return false;
  const supplier = String(doc.supplier ?? '').trim();
  if (!supplier || /^unknown (supplier|customer)$/i.test(supplier)) return false;
  const label = String(doc.taxLabel ?? '');
  if (!looksLikeGst(label)) return false;
  const reg = String(doc.supplierGstRegNo ?? '').trim();
  // A foreign registration is a foreign supplier: not on IRAS's register.
  if (reg) return isSingaporeGstRegNo(reg);
  return num(doc.tax) > 0 || /\bgst\b/i.test(label);
}

// What to ask, and where the number came from. `contactNumber` is the one on the
// Xero contact, used when a person checks a document that carries none.
export function gstCheckAsk(doc, contactNumber = '') {
  const printed = String(doc?.supplierGstRegNo ?? '').trim();
  const fromDoc = Boolean(printed) && isSingaporeGstRegNo(printed);
  const reg = fromDoc ? printed : String(contactNumber ?? '').trim();
  const known = Boolean(reg) && isSingaporeGstRegNo(reg);
  const from = String(doc?.supplierGstRegNoFrom || '');
  const source = !known
    ? 'name'
    : !fromDoc
      ? 'contact'
    : doc.supplierGstRegNoRemembered !== true
      ? 'paper'
      : from === 'document' || !from
        ? 'memory'
        : 'rule';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(doc?.date ?? '')) ? String(doc.date) : '';
  return {
    source,
    body: { reg_id: known ? reg : '', supplier_name: String(doc?.supplier ?? '').trim(), date },
  };
}

// An answer from cyworkspace (`available: true`), read against the document.
export function judgeGstAnswer(answer, { source, supplier }) {
  if (!answer?.matched) {
    return { verdict: 'no_match', hold: false, autoSave: false, confirmable: false, nameMatches: false };
  }
  const r = answer.result || {};
  const nameMatches = Boolean(r.name) && normaliseSupplier(r.name) === normaliseSupplier(supplier);
  const verdict =
    answer.on_date === 'yes' ? 'registered' : answer.on_date === 'no' ? 'not_registered' : 'unknown';
  const canSave = verdict === 'registered' && Boolean(r.gst_reg_no);
  const autoSave = canSave && source === 'paper' && nameMatches;
  return {
    verdict,
    // A number not off this document's evidence holds nothing.
    hold: verdict === 'not_registered' && source !== 'name' && source !== 'contact',
    autoSave,
    confirmable: canSave && !autoSave && source !== 'contact',
    nameMatches,
  };
}

// The contact fields to write: never over a value Xero already holds.
export function contactGstPatch(contact, { gstRegNo, uen }) {
  const patch = {};
  if (gstRegNo && !String(contact?.TaxNumber ?? '').trim()) patch.TaxNumber = String(gstRegNo);
  // Xero's "Business registration number" is the UEN; an M-number is not one.
  const u = compact(uen);
  if (u && !/^M[A-Z0-9]\d{7}[A-Z0-9]$/.test(u) && isSingaporeGstRegNo(u) && !String(contact?.CompanyNumber ?? '').trim()) {
    patch.CompanyNumber = u;
  }
  return patch;
}

// --- A new supplier's name --------------------------------------------------
// A supplier the entity has never had, billing with its own Singapore number
// printed on the paper, is filed under the name that number is registered to
// (Cze, 28 Nov 2026). An existing supplier keeps its name: Xero matches a
// contact by exact name, so another spelling would make a second contact with
// no bank details.

// Whether the number on this read may name the supplier at all: printed on this
// document (never remembered), Singapore's, and not the buyer's own.
export function numberNamesSupplier(data, ownNumbers = []) {
  const reg = compact(data?.supplierGstRegNo);
  if (!reg || data.supplierGstRegNoRemembered === true || !isSingaporeGstRegNo(reg)) return false;
  if (!looksLikeGst(data.taxLabel)) return false;
  const supplier = String(data.supplier ?? '').trim();
  if (!supplier || /^unknown (supplier|customer)$/i.test(supplier)) return false;
  return ![...ownNumbers, data.billedToRegNo].some((n) => compact(n) === reg);
}

export const sameSupplierName = (a, b) => Boolean(normaliseSupplier(a)) && normaliseSupplier(a) === normaliseSupplier(b);

// The registered name the answer gives, or '' to keep the printed one: nothing
// found, a name IRAS hides (an individual's), or the same name already.
export function registeredNameFor(data, answer) {
  const r = answer?.result;
  if (!answer?.matched || (r?.outcome !== 'registered' && r?.outcome !== 'deregistered')) return '';
  const name = String(answer.registered_name || r.name || '').replace(/\s+/g, ' ').trim();
  if (!name || name.includes('*') || /^n\/?a$/i.test(name)) return '';
  return sameSupplierName(name, data?.supplier) ? '' : name;
}

// Whether a contact already holds one of these numbers: the same business under
// another name.
export function contactHoldsNumber(contact, numbers) {
  const wanted = numbers.map(compact).filter(Boolean);
  return [contact?.TaxNumber, contact?.CompanyNumber].some((v) => compact(v) && wanted.includes(compact(v)));
}

// What a held cost says to whoever reads it. IRAS's answer itself is shown to
// the practice only (its API terms restrict passing it on).
export const GST_HOLD_REASON =
  'No Tax: the GST on this document could not be supported by the supplier’s GST registration on its date. Your accounting firm can see the detail; a code picked by hand is kept.';

// The source notice IRAS's API terms ask for beside its data.
export const IRAS_TERMS_URL = 'https://go.gov.sg/iras-api-tou';
export function irasNotice(checkedAt) {
  const day = String(checkedAt || '').slice(0, 10) || 'the date shown';
  return `Contains information from Check GST Register API accessed on ${day} from Inland Revenue Authority of Singapore which is made available under the Terms & Conditions of Use of IRAS API.`;
}
