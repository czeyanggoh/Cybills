import { useState } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { exportDocs } from '@/lib/docsExport';
import { cn } from '@/lib/utils';

// Export dialog for Costs/Sales — CSV / PDF / ZIP. Runs fully client-side and
// records the file in the Exports tab. `kind` is 'costs' | 'sales'.
export default function DocsExportModal({ open, kind, rows, onClose, onArchive = () => {} }) {
  const defaultLabel = kind === 'sales' ? 'CYBills sales default' : 'CYBills default';
  const [tab, setTab] = useState('csv');
  // Default to "Custom CSV" so the columns configured in Business settings →
  // Exports actually drive the file. The full fixed template stays selectable.
  const [csvFormat, setCsvFormat] = useState('Custom CSV');
  const [archiveAfter, setArchiveAfter] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  const doExport = async () => {
    setBusy(true);
    try {
      await exportDocs(rows, { kind, format: tab, csvFormat });
      if (archiveAfter) onArchive?.();
    } finally {
      setBusy(false);
      onClose();
    }
  };

  const TABS = [{ key: 'csv', label: 'CSV' }, { key: 'pdf', label: 'PDF' }, { key: 'zip', label: 'ZIP' }];
  const blurb = { csv: 'Export your data as a CSV file.', pdf: 'Export a PDF containing every receipt image (one document per page).', zip: 'Export a ZIP of every receipt file (each document) plus the CSV.' };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-md overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">Export {rows.length} item{rows.length === 1 ? '' : 's'}</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6">
          <div className="mb-5 grid grid-cols-3 rounded-md border p-0.5 text-sm">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn('rounded py-1.5 font-medium transition-colors', tab === t.key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}
              >
                {t.label}
              </button>
            ))}
          </div>

          <p className="mb-4 text-sm text-muted-foreground">{blurb[tab]}</p>

          {tab === 'csv' && (
            <label className="mb-4 flex items-center gap-3 text-sm">
              <span className="w-24 shrink-0 text-muted-foreground">CSV format</span>
              <div className="relative flex-1">
                <select
                  value={csvFormat}
                  onChange={(e) => setCsvFormat(e.target.value)}
                  className="h-9 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {[defaultLabel, 'Custom CSV'].map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </label>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={archiveAfter} onChange={(e) => setArchiveAfter(e.target.checked)} className="h-4 w-4 accent-black" />
            Archive items after export
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">Cancel</button>
          <button type="button" onClick={doExport} disabled={busy || rows.length === 0} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
            {busy ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}
