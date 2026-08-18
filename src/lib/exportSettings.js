import { useState, useEffect } from 'react';
import { blobStore } from '@/lib/blobStore';

// Business settings → Exports. Controls how CSV/PDF exports are formatted. Stored
// as a shared, server-backed settings blob. The Custom CSV column selection +
// decimal separator + date format are read by the claim CSV generator
// (claimCsv.js) when the "Custom CSV" format is chosen.

const KEY = 'cybills.export-settings.v1';
export const EXPORT_SETTINGS_EVENT = 'cybills:export-settings-changed';

// Every column the Custom CSV export can include (order = output order).
export const EXPORT_COLUMNS = [
  'Receipt ID', 'Invoice number', 'Type', 'Status', 'Owner', 'Date', 'Due date', 'Supplier',
  'Customer', 'Description', 'Category', 'Product/Service', 'Project 1', 'Payment method',
  'Currency', 'Tax rate', 'Quantity (line items)', 'Unit price (net)', 'Unit price (total)',
  'Net amount', 'Tax amount', 'Total amount', 'Net with currency', 'Tax with currency',
  'Total with currency', 'Base net amount', 'Base total amount', 'Note', 'Image', 'Project 2',
];

export const DEFAULT_EXPORT_COLUMNS = ['Receipt ID', 'Description', 'Net amount', 'Tax amount', 'Total amount'];

export const DEFAULT_EXPORT_SETTINGS = {
  // CSV Exports
  receiptsFormat: 'CYBills Default',
  bankFormat: 'CYBills Excel',
  salesFormat: 'CYBills Sales Default',
  expenseFormat: 'CYBills Default',
  showNet: false,
  // CSV Custom Exports
  decimalSeparator: 'Dot (.)',
  dateFormat: 'DD-Mon-YYYY (e.g. 20-Sep-2025)',
  showItemHeader: false,
  columns: DEFAULT_EXPORT_COLUMNS,
  // PDF Exports
  pdfItemHeaders: false,
  pdfOrder: 'Date (old to new)',
  hideProject: false,
  hideProject2: false,
};

const emit = () => window.dispatchEvent(new Event(EXPORT_SETTINGS_EVENT));
const store = blobStore(KEY, DEFAULT_EXPORT_SETTINGS, emit);

export function getExportSettings() {
  const v = store.get() || {};
  return { ...DEFAULT_EXPORT_SETTINGS, ...v, columns: Array.isArray(v.columns) ? v.columns : DEFAULT_EXPORT_COLUMNS };
}

export function saveExportSettings(next) {
  store.set(next);
  emit();
}

export function useExportSettings() {
  const [s, setS] = useState(getExportSettings);
  useEffect(() => {
    const sync = () => setS(getExportSettings());
    window.addEventListener(EXPORT_SETTINGS_EVENT, sync);
    return () => window.removeEventListener(EXPORT_SETTINGS_EVENT, sync);
  }, []);
  return s;
}
