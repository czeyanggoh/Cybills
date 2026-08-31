import { useState } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { exportDocs } from '@/lib/docsExport';
import { useAuth } from '@/lib/auth';
import { useExportSettings } from '@/lib/exportSettings';
import { useActiveOrganisation } from '@/lib/organisations';
import { cn } from '@/lib/utils';

// Export dialog for Costs/Sales — CSV / PDF / ZIP. Runs fully client-side and
// records the file in the Exports tab. `kind` is 'costs' | 'sales'.
export default function DocsExportModal({ open, kind, rows, onClose, onArchive = () => {} }) {
  const defaultLabel = kind === 'sales' ? 'CYBills sales default' : 'CYBills default';
  const { user, membership } = useAuth();
  const settings = useExportSettings();
  const org = useActiveOrganisation();
  const [tab, setTab] = useState('csv');
  // Opens on the format this entity chose in Business settings → Exports, which
  // is what "choose how the data in CSV exports gets formatted" has to mean —
  // it was stored and then never read, so the setting decided nothing and the
  // dialog asked again every time. Still a choice here: a preference is where
  // it STARTS, not a rule about one particular export.
  const [csvFormat, setCsvFormat] = useState(
    (kind === 'sales' ? settings.salesFormat : settings.receiptsFormat) === 'Custom CSV' ? 'Custom CSV' : defaultLabel
  );
  const [archiveAfter, setArchiveAfter] = useState(false);
  const [busy, setBusy] = useState(false);
  // What the finished file turned out to hold, kept only when it holds less
  // than was asked for (see doExport).
  const [result, setResult] = useState(null);
  if (!open) return null;

  // A CSV describes every row. A PDF and a ZIP are made of the documents
  // THEMSELVES, so a row with no stored file — typed in by hand, or captured
  // before its image was kept — has nothing to contribute and simply isn't
  // there. Said here, before the export, because the alternative is finding out
  // by opening a PDF that is one page saying nothing.
  const needsFiles = tab === 'pdf' || tab === 'zip';
  const withFile = rows.filter((d) => d.hasFile).length;
  const noFiles = needsFiles && withFile === 0 && rows.length > 0;
  const someMissing = needsFiles && withFile > 0 && withFile < rows.length;

  const doExport = async () => {
    // Record the export under the signed-in user's name (not the generic "You"),
    // matching the claim export dialogs.
    // Never "You": this is read by whoever opens the file or the Exports tab,
    // and it means a different person to each of them. An email is a worse name
    // than a name but still identifies somebody; blank is honest when nothing does.
    const exportedBy = membership?.user?.name || user?.name || user?.email || '';
    setBusy(true);
    try {
      const res = await exportDocs(rows, { kind, format: tab, csvFormat, exportedBy, orgName: org?.name || '' });
      if (archiveAfter) onArchive?.();
      // The file is downloaded either way. The dialog stays open only when the
      // result came out short of what was promised above — a stored file that
      // would not fetch or would not parse. A shortfall already named in the
      // notice needs no second telling, and repeating it would read as a new
      // problem rather than the one already accounted for.
      if (res && res.added < withFile) {
        setResult(res);
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setResult(null);
    onClose();
  };

  const TABS = [{ key: 'csv', label: 'CSV' }, { key: 'pdf', label: 'PDF' }, { key: 'zip', label: 'ZIP' }];
  const blurb = { csv: 'Export your data as a CSV file.', pdf: 'Export a PDF containing every receipt image (one document per page).', zip: 'Export a ZIP of every receipt file (each document) plus the CSV.' };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={close} aria-hidden="true" />
      <div className="relative w-full max-w-md overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">Export {rows.length} item{rows.length === 1 ? '' : 's'}</h2>
          <button type="button" onClick={close} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6">
          <div className="mb-5 grid grid-cols-3 rounded-md border p-0.5 text-sm">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => { setTab(t.key); setResult(null); }}
                className={cn('rounded py-1.5 font-medium transition-colors', tab === t.key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}
              >
                {t.label}
              </button>
            ))}
          </div>

          <p className="mb-4 text-sm text-muted-foreground">{blurb[tab]}</p>

          {noFiles && (
            <p className="mb-4 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              {rows.length === 1 ? 'This document has no stored file' : `None of these ${rows.length} documents has a stored file`},
              so there is nothing for the {tab === 'pdf' ? 'PDF' : 'ZIP'} to contain. Export as CSV instead.
            </p>
          )}
          {someMissing && (
            <p className="mb-4 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              {withFile} of {rows.length} have a stored file. The other {rows.length - withFile}{' '}
              {rows.length - withFile === 1 ? 'was entered without one and won’t appear' : 'were entered without one and won’t appear'}.
            </p>
          )}
          {result && (
            <p className="mb-4 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              {result.filename} was downloaded with {result.added} of {result.total} document
              {result.total === 1 ? '' : 's'}. The rest had no file that could be read.
            </p>
          )}

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
          <button type="button" onClick={close} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
            {result ? 'Done' : 'Cancel'}
          </button>
          {!result && (
            <button type="button" onClick={doExport} disabled={busy || rows.length === 0 || noFiles} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
              {busy ? 'Exporting…' : 'Export'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
