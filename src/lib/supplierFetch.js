import { useEffect, useState } from 'react';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { addBill, notifyBillsChanged } from '@/lib/bills';

// "Auto-fetch bills from online suppliers" (Dext-style). Real supplier-portal
// scraping needs per-supplier credentials/integrations, so this simulates it:
// connect a supplier, then "Fetch latest bills" pulls that period's invoice —
// a generated PDF invoice persisted as a real cost in the inbox, deduped per
// month so re-fetching is idempotent. Everything downstream (detail, category,
// export, claims, reconciliation) then works on it like any uploaded bill.

const CONN_KEY = 'cybills.supplier-connections.v1';
export const SUPPLIER_CONN_EVENT = 'cybills:supplier-connections';

// The connectable suppliers, each with the category its bills post to and a
// typical monthly amount range.
export const FETCH_SUPPLIERS = [
  { id: 'spgroup', name: 'SP Group', kind: 'Utilities', prefix: 'SP', category: '445 - Light, Power, Heating', min: 90, max: 340 },
  { id: 'singtel', name: 'Singtel', kind: 'Telecom', prefix: 'STL', category: '489 - Telephone & Internet', min: 45, max: 190 },
  { id: 'm1', name: 'M1', kind: 'Telecom', prefix: 'M1', category: '489 - Telephone & Internet', min: 30, max: 130 },
  { id: 'aws', name: 'Amazon Web Services', kind: 'Cloud', prefix: 'AWS', category: '463 - IT Software and Consumables', min: 120, max: 920 },
  { id: 'gworkspace', name: 'Google Workspace', kind: 'SaaS', prefix: 'GW', category: '463 - IT Software and Consumables', min: 60, max: 300 },
];

function readConns() {
  try {
    return JSON.parse(localStorage.getItem(CONN_KEY) || 'null') || {};
  } catch {
    return {};
  }
}
function writeConns(next) {
  localStorage.setItem(CONN_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(SUPPLIER_CONN_EVENT));
}

export function toggleSupplier(id) {
  const conns = readConns();
  conns[id] = !conns[id];
  writeConns(conns);
}

// Reactive read of which suppliers are connected.
export function useSupplierConnections() {
  const [conns, setConns] = useState(readConns);
  useEffect(() => {
    const sync = () => setConns(readConns());
    window.addEventListener(SUPPLIER_CONN_EVENT, sync);
    return () => window.removeEventListener(SUPPLIER_CONN_EVENT, sync);
  }, []);
  return conns;
}

const pad2 = (n) => String(n).padStart(2, '0');
const period = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const amountFor = (s) => (s.min + Math.random() * (s.max - s.min)).toFixed(2);
const rand4 = () => String(1000 + Math.floor(Math.random() * 9000));

// Generate a simple, real PDF invoice for a fetched bill → base64 (no prefix).
async function makeInvoicePdf({ supplier, invoiceNumber, date, total, category }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 595]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.1);
  const grey = rgb(0.5, 0.5, 0.5);
  const line = rgb(0.8, 0.8, 0.8);
  const put = (t, x, y, size = 11, f = font, color = ink) => page.drawText(String(t), { x, y, size, font: f, color });
  put(supplier, 32, 548, 18, bold);
  put('TAX INVOICE', 32, 526, 10, font, grey);
  put(`Invoice no.  ${invoiceNumber}`, 32, 486);
  put(`Invoice date  ${date}`, 32, 468);
  put('Bill to  CY Business Management Pte Ltd', 32, 450);
  page.drawLine({ start: { x: 32, y: 418 }, end: { x: 388, y: 418 }, thickness: 0.7, color: line });
  put('Description', 32, 400, 10, bold);
  put('Amount', 316, 400, 10, bold);
  put(`${category} — monthly charges`, 32, 380, 10);
  put(`SGD ${total}`, 316, 380, 10);
  page.drawLine({ start: { x: 32, y: 360 }, end: { x: 388, y: 360 }, thickness: 0.7, color: line });
  put('Total due', 32, 336, 12, bold);
  put(`SGD ${total}`, 300, 336, 12, bold);
  put('Auto-fetched into CYBills', 32, 40, 8, font, grey);
  const bytes = await doc.save();
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Fetch this period's invoice from each given supplier into the Costs inbox.
// Idempotent per month (fileHash keyed by supplier+period). Returns counts.
export async function fetchBillsFrom(suppliers) {
  const p = period();
  const date = today();
  let added = 0;
  let skipped = 0;
  for (const s of suppliers) {
    const total = amountFor(s);
    const invoiceNumber = `${s.prefix}-${p.replace('-', '')}-${rand4()}`;
    // eslint-disable-next-line no-await-in-loop
    const fileBase64 = await makeInvoicePdf({ supplier: s.name, invoiceNumber, date, total, category: s.category });
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await addBill({
        fileHash: `fetch:${s.id}:${p}`,
        fileName: `${s.name} ${p}.pdf`,
        fileBase64,
        mediaType: 'application/pdf',
        supplier: s.name,
        invoiceNumber,
        documentType: 'Invoice',
        currency: 'SGD',
        total,
        tax: '0.00',
        date,
        category: s.category,
        kind: 'cost',
      });
      if (res?.rejected || res?.duplicate) skipped += 1;
      else added += 1;
    } catch {
      skipped += 1;
    }
  }
  if (added) notifyBillsChanged();
  return { added, skipped };
}
