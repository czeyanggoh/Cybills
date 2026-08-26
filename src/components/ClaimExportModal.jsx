import { useState } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { generateClaimCsv } from '@/lib/claimCsv';
import { generateClaimPdf } from '@/lib/claimPdf';
import { useAuth } from '@/lib/auth';
import { useExportSettings } from '@/lib/exportSettings';
import { cn } from '@/lib/utils';

function Select({ value, onChange, options }) {
  return (
    <div className="relative flex-1">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

// Export dialog for an expense claim — CSV (with detail level / format) or PDF.
// Both run fully client-side; there is no server round-trip.
export default function ClaimExportModal({ open, onClose, claim, onExported }) {
  const [tab, setTab] = useState('csv');
  const [detail, setDetail] = useState('summary');
  const [pdfDetail, setPdfDetail] = useState('with_receipts');
  const [format, setFormat] = useState('cybills');
  const [archiveAfter, setArchiveAfter] = useState(false);
  const [busy, setBusy] = useState(false);
  const settings = useExportSettings();
  const { user, membership } = useAuth();

  if (!open) return null;

  const doExport = async () => {
    if (busy) return;
    // Never "You" — see DocsExportModal. Blank beats a word that names nobody.
    const exportedBy = membership?.user?.name || user?.name || user?.email || '';
    if (tab === 'csv') {
      // enrichment fetches the live docs, so this is async too.
      setBusy(true);
      try {
        await generateClaimCsv(claim, { detailLevel: detail, format, settings, exportedBy });
      } finally {
        setBusy(false);
      }
    } else {
      // Building "with receipts" fetches each receipt document, so it's async.
      setBusy(true);
      try {
        await generateClaimPdf(claim, { exportedBy, detailLevel: pdfDetail });
      } finally {
        setBusy(false);
      }
    }
    onClose();
    if (archiveAfter) onExported?.();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-md overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">Export 1 item</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6">
          <div className="mb-5 grid grid-cols-2 rounded-md border p-0.5 text-sm">
            {[
              { key: 'csv', label: 'CSV' },
              { key: 'pdf', label: 'PDF' },
            ].map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn(
                  'rounded py-1.5 font-medium transition-colors',
                  tab === t.key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'csv' ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">Export your data as a CSV file.</p>
              <label className="flex items-center gap-3 text-sm">
                <span className="w-28 shrink-0 text-muted-foreground">Detail level</span>
                <Select
                  value={detail}
                  onChange={setDetail}
                  options={[
                    { value: 'summary', label: 'Report summary' },
                    { value: 'items', label: 'Itemised line items' },
                  ]}
                />
              </label>
              <label className="flex items-center gap-3 text-sm">
                <span className="w-28 shrink-0 text-muted-foreground">CSV format</span>
                <Select value={format} onChange={setFormat} options={[{ value: 'cybills', label: 'CYBills Default' }, { value: 'custom', label: 'Custom CSV (from Export settings)' }]} />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={archiveAfter}
                  onChange={(e) => setArchiveAfter(e.target.checked)}
                  className="h-4 w-4 accent-black"
                />
                Archive items after export
              </label>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">Export your data as a PDF file.</p>
              <label className="flex items-center gap-3 text-sm">
                <span className="w-28 shrink-0 text-muted-foreground">Detail level</span>
                <Select
                  value={pdfDetail}
                  onChange={setPdfDetail}
                  options={[
                    { value: 'with_receipts', label: 'Report with receipts' },
                    { value: 'summary', label: 'Report summary' },
                    { value: 'receipts', label: 'Receipts' },
                  ]}
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={archiveAfter}
                  onChange={(e) => setArchiveAfter(e.target.checked)}
                  className="h-4 w-4 accent-black"
                />
                Archive items after export
              </label>
              <p className="text-xs text-muted-foreground">
                &ldquo;Report with receipts&rdquo; appends each item&rsquo;s original receipt document after the report.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={doExport} className={cn('inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90', busy && 'opacity-50')}>
            {busy ? 'Preparing…' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}
