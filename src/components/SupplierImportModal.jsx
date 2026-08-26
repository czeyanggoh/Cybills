import { useRef, useState } from 'react';
import { X, CheckCircle2 } from 'lucide-react';
import { setSupplierRule } from '@/lib/supplierRules';
import { addSuppliers } from '@/lib/supplierList';

// Import a suppliers list from CSV, mirroring Dext's "CSV Upload" dialog. The
// columns are Dext's: Code, Name, Currency code, Category code, Category name,
// Tax code, Tax name.
//
// Every named row JOINS THE LIST, and any defaults it carries become that
// supplier's standing rule: currency, category (built as "code - name",
// CYBills' convention), and tax rate. A blank cell is left alone.
//
// The list part matters most where there is no Xero to read contacts from — a
// bridge entity's suppliers can only arrive this way, or one document at a
// time. Importing used to set rules alone, so a file of 300 names could be
// accepted in full and change nothing anybody could see.
const EXAMPLE = [
  { code: '401HGL', name: 'Kevin', currency: 'GBP', catCode: '626000', catName: 'TELEPHONE', taxCode: 'VAT10', taxName: 'VAT (10%)' },
  { code: '401AMA', name: 'Bob', currency: 'USD', catCode: '626001', catName: 'MISC', taxCode: 'VAT15', taxName: 'VAT (15%)' },
  { code: '401TRL', name: 'John', currency: 'EUR', catCode: '626002', catName: 'SUNDRY', taxCode: 'VAT20', taxName: 'VAT (20%)' },
];
const HEADERS = ['Code', 'Name', 'Currency code', 'Category code', 'Category name', 'Tax code', 'Tax name'];
const MAX_BYTES = 2 * 1024 * 1024;

function parseCsvLine(line) {
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

// A row's supplier-rule patch, from the Dext columns we can map onto CYBills.
function rowToPatch(cols, idx) {
  const get = (name) => {
    const i = idx[name.toLowerCase()];
    return i == null ? '' : (cols[i] || '').trim();
  };
  const patch = {};
  const currency = get('Currency code');
  if (currency) patch.currency = currency;
  const catCode = get('Category code');
  const catName = get('Category name');
  const category = catCode && catName ? `${catCode} - ${catName}` : catName || catCode;
  if (category) patch.category = category;
  // Prefer the human tax name (what the CYBills pickers show); fall back to code.
  const tax = get('Tax name') || get('Tax code');
  if (tax) patch.taxRate = tax;
  return patch;
}

function downloadTemplate() {
  const header = HEADERS.join(',');
  const rows = EXAMPLE.map((r) => [r.code, r.name, r.currency, r.catCode, r.catName, r.taxCode, r.taxName].join(','));
  const blob = new Blob([`${header}\n${rows.join('\n')}\n`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cybills-suppliers-template.csv';
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
    if (file.size > MAX_BYTES) { setError('That file is over 2MB. Please upload a smaller CSV.'); return; }
    if (!/\.csv$/i.test(file.name) && file.type && !/csv|text/.test(file.type)) { setError('CSV only, please.'); return; }
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (!lines.length) { setError('That file looks empty.'); return; }
      const header = parseCsvLine(lines[0]);
      const idx = {};
      header.forEach((h, i) => { idx[h.trim().toLowerCase()] = i; });
      if (idx.name == null) { setError('The first row must be a header with a "Name" column. See the example above.'); return; }
      let applied = 0;
      let skipped = 0;
      const names = [];
      for (const line of lines.slice(1)) {
        const cols = parseCsvLine(line);
        const name = (cols[idx.name] || '').trim();
        // A row with no name is the only unusable one. A row with nothing but a
        // name is a supplier — it just has no defaults yet.
        if (!name) { skipped += 1; continue; }
        names.push(name);
        const patch = rowToPatch(cols, idx);
        if (Object.keys(patch).length) setSupplierRule(name, patch);
        applied += 1;
      }
      const added = addSuppliers(names);
      setResult({ applied, skipped, added });
      onImported?.(applied);
    } catch {
      setError('Could not read that file. Make sure it is a CSV.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={close} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">CSV Upload</h2>
          <button type="button" onClick={close} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          {result ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <CheckCircle2 className="h-10 w-10" strokeWidth={1.5} />
              <p className="text-sm font-medium">
                Imported {result.applied} supplier{result.applied === 1 ? '' : 's'}
                {result.added > 0 ? ` — ${result.added} new to the list.` : '.'}
              </p>
              {result.applied > result.added && (
                <p className="text-xs text-muted-foreground">
                  The rest were already here; their defaults were updated.
                </p>
              )}
              {result.skipped > 0 && (
                <p className="text-xs text-muted-foreground">{result.skipped} row{result.skipped === 1 ? '' : 's'} skipped (no name).</p>
              )}
            </div>
          ) : (
            <>
              <p className="mb-4 text-sm text-muted-foreground">
                Upload the CSV file representing your Suppliers list. The first row of your CSV should be the header
                containing the column name. See the example below.{' '}
                <button type="button" onClick={downloadTemplate} className="font-medium text-foreground underline underline-offset-2">
                  Download template
                </button>
              </p>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="border-b bg-muted/40 text-left">
                    <tr className="text-muted-foreground">
                      {HEADERS.map((h) => (
                        <th key={h} className="whitespace-nowrap px-3 py-2.5 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {EXAMPLE.map((r) => (
                      <tr key={r.code} className="border-b last:border-0">
                        <td className="px-3 py-2.5">{r.code}</td>
                        <td className="px-3 py-2.5">{r.name}</td>
                        <td className="px-3 py-2.5">{r.currency}</td>
                        <td className="px-3 py-2.5">{r.catCode}</td>
                        <td className="px-3 py-2.5">{r.catName}</td>
                        <td className="px-3 py-2.5">{r.taxCode}</td>
                        <td className="px-3 py-2.5">{r.taxName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-6 flex flex-col items-center gap-1.5">
                <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
                <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex h-9 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
                  Select file
                </button>
                <p className="text-xs text-muted-foreground">CSV only, 2MB max</p>
              </div>
              {error && <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p>}
            </>
          )}
        </div>

        <div className="flex items-center justify-end border-t px-6 py-4">
          <button type="button" onClick={close} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
            {result ? 'Done' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}
