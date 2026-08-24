import { useRef, useState } from 'react';
import { X, Upload, CheckCircle2 } from 'lucide-react';
import { setSupplierRule } from '@/lib/supplierRules';

// Import supplier defaults in bulk from a CSV. Suppliers themselves come from
// Xero, so this doesn't create contacts — it sets each named supplier's standing
// RULE (the same values the Suppliers table edits): category, customer, project,
// tax rate, and the two extract toggles. A blank cell leaves that field alone.
const TEMPLATE_COLS = ['Name', 'Category', 'Customer', 'Project', 'Tax rate', 'Extract line items', 'Extract supplier statements'];

function parseCsvLine(line) {
  // Minimal CSV: handles quoted fields with commas.
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const truthy = (v) => /^(yes|true|1|y)$/i.test(String(v || '').trim());
const falsy = (v) => /^(no|false|0|n)$/i.test(String(v || '').trim());

function rowToPatch(cols, headerIdx) {
  const get = (name) => {
    const i = headerIdx[name.toLowerCase()];
    return i == null ? '' : (cols[i] || '').trim();
  };
  const patch = {};
  if (get('Category')) patch.category = get('Category');
  if (get('Customer')) patch.customer = get('Customer');
  if (get('Project')) patch.project = get('Project');
  if (get('Tax rate')) patch.taxRate = get('Tax rate');
  const eli = get('Extract line items');
  if (truthy(eli)) patch.extractLineItems = true;
  else if (falsy(eli)) patch.extractLineItems = false;
  const ess = get('Extract supplier statements');
  if (truthy(ess)) patch.extractStatements = true;
  else if (falsy(ess)) patch.extractStatements = false;
  return patch;
}

function downloadTemplate() {
  const csv = `${TEMPLATE_COLS.join(',')}\n"A1 Consultancy",412 - Consulting & Accounting,,GCY,No Tax,No,Yes\n`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cybills-supplier-rules-template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function SupplierImportModal({ open, onClose, onImported }) {
  const fileRef = useRef(null);
  const [result, setResult] = useState(null); // { applied, skipped }
  const [error, setError] = useState('');

  if (!open) return null;

  const close = () => { setResult(null); setError(''); onClose(); };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (!lines.length) { setError('That file looks empty.'); return; }
      const header = parseCsvLine(lines[0]);
      const headerIdx = {};
      header.forEach((h, i) => { headerIdx[h.trim().toLowerCase()] = i; });
      if (headerIdx.name == null) { setError('The CSV needs a "Name" column. Download the template for the exact headers.'); return; }
      let applied = 0;
      let skipped = 0;
      for (const line of lines.slice(1)) {
        const cols = parseCsvLine(line);
        const name = (cols[headerIdx.name] || '').trim();
        if (!name) { skipped += 1; continue; }
        const patch = rowToPatch(cols, headerIdx);
        if (Object.keys(patch).length === 0) { skipped += 1; continue; }
        setSupplierRule(name, patch);
        applied += 1;
      }
      setResult({ applied, skipped });
      onImported?.(applied);
    } catch {
      setError('Could not read that file. Make sure it is a CSV.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={close} aria-hidden="true" />
      <div className="relative w-full max-w-md overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">Import supplier rules from CSV</h2>
          <button type="button" onClick={close} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          {result ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <CheckCircle2 className="h-10 w-10" strokeWidth={1.5} />
              <p className="text-sm font-medium">Applied rules to {result.applied} supplier{result.applied === 1 ? '' : 's'}.</p>
              {result.skipped > 0 && (
                <p className="text-xs text-muted-foreground">{result.skipped} row{result.skipped === 1 ? '' : 's'} skipped (no name or nothing to set).</p>
              )}
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Sets each named supplier&rsquo;s standing rule (Category, Customer, Project, Tax rate, and the extract
                toggles) in bulk. A blank cell leaves that field alone. Suppliers still come from Xero — this only sets
                their defaults.
              </p>
              <p className="text-sm">
                Follow the{' '}
                <button type="button" onClick={downloadTemplate} className="font-medium text-foreground underline underline-offset-2">
                  CSV template
                </button>
                .
              </p>
              {error && <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p>}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
          {result ? (
            <button type="button" onClick={close} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">Done</button>
          ) : (
            <>
              <button type="button" onClick={close} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">Cancel</button>
              <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
                <Upload className="h-4 w-4" /> Select file
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
