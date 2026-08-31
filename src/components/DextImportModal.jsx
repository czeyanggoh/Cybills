import { useMemo, useRef, useState } from 'react';
import { X, Upload, FileText, AlertTriangle, Check } from 'lucide-react';
import { parseDextExport, matchFiles, billPayload, patchPayload } from '@/lib/dextImport';
import { addBill, updateBill } from '@/lib/bills';
import { useActiveOrganisation } from '@/lib/organisations';
import { cn } from '@/lib/utils';

// Move a client's documents from Dext into CYBills.
//
// The CSV is the source of the FIELDS and the downloaded files are the source
// of the BYTES. That split is the whole point: those documents have already
// been coded in Dext — supplier read, category chosen, tax settled — and
// re-uploading them here would throw that away and bill a model call each to
// arrive back where it started. Nothing is read by the extractor on this path.
//
// It imports into WHICHEVER ENTITY IS OPEN, which is the one thing worth being
// careful about, so the entity is named on the button and again in the result.

const readAsBase64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('read_failed'));
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.readAsDataURL(file);
  });

export default function DextImportModal({ open, onClose, onImported }) {
  const org = useActiveOrganisation();
  const [csvName, setCsvName] = useState('');
  const [parsed, setParsed] = useState(null);
  const [files, setFiles] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [progress, setProgress] = useState({ at: 0, of: 0 });
  const csvInput = useRef(null);
  const fileInput = useRef(null);

  const match = useMemo(
    () => (parsed ? matchFiles(parsed.rows, files) : null),
    [parsed, files]
  );

  if (!open) return null;

  const reset = () => {
    setCsvName(''); setParsed(null); setFiles([]); setError(''); setDone(null); setProgress({ at: 0, of: 0 });
  };
  const close = () => { if (!busy) { reset(); onClose(); } };

  const takeCsv = async (file) => {
    if (!file) return;
    setError(''); setDone(null);
    try {
      const text = await file.text();
      const result = parseDextExport(text);
      if (!result.rows.length) {
        setError('That file has no rows in it. Export the Costs list from Dext as CSV and try that.');
        return;
      }
      setCsvName(file.name);
      setParsed(result);
    } catch {
      setError('That file could not be read as a CSV.');
    }
  };

  const run = async () => {
    if (!match || busy) return;
    setBusy(true);
    setError('');
    const outcome = { created: 0, withFile: 0, duplicates: 0, failed: [] };
    setProgress({ at: 0, of: match.pairs.length });
    for (let i = 0; i < match.pairs.length; i += 1) {
      const { row, file } = match.pairs[i];
      try {
        const body = billPayload(row);
        if (file) {
          // eslint-disable-next-line no-await-in-loop
          body.fileBase64 = await readAsBase64(file);
          body.mediaType = file.type || 'application/octet-stream';
          body.fileName = file.name;
        }
        // Straight to the inbox, not 'processing': there is nothing to read.
        // eslint-disable-next-line no-await-in-loop
        const res = await addBill(body);
        if (res?.duplicate && !res?.bill) {
          outcome.duplicates += 1;
        } else if (res?.bill?.id) {
          outcome.created += 1;
          if (file) outcome.withFile += 1;
          const patch = patchPayload(row);
          // eslint-disable-next-line no-await-in-loop
          if (Object.keys(patch).length) await updateBill(res.bill.id, patch).catch(() => {});
        } else {
          outcome.failed.push(row.receiptId || `line ${row.line}`);
        }
      } catch {
        outcome.failed.push(row.receiptId || `line ${row.line}`);
      }
      setProgress({ at: i + 1, of: match.pairs.length });
    }
    setBusy(false);
    setDone(outcome);
    onImported?.();
  };

  const Row = ({ children }) => <p className="text-sm text-muted-foreground">{children}</p>;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={close} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">Import from Dext</h2>
          <button type="button" onClick={close} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 overflow-y-auto p-6">
          {done ? (
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <Check className="h-4 w-4" /> Imported {done.created} document{done.created === 1 ? '' : 's'} into {org?.name || 'this entity'}.
              </p>
              <Row>{done.withFile} of them came with their original file.</Row>
              {done.duplicates > 0 && (
                <Row>{done.duplicates} were skipped as duplicates — CYBills already had them.</Row>
              )}
              {done.failed.length > 0 && (
                <p className="text-sm text-destructive">
                  {done.failed.length} could not be imported: {done.failed.slice(0, 8).join(', ')}
                  {done.failed.length > 8 ? '…' : ''}
                </p>
              )}
            </div>
          ) : (
            <>
              <Row>
                Export the client&rsquo;s Costs list from Dext as CSV, and download its documents.
                The CSV carries the coding already done there — supplier, date, category, tax — so
                nothing is read again and nothing is charged for reading it.
              </Row>

              {/* Step 1 — the CSV */}
              <div className="rounded-lg border p-4">
                <p className="mb-2 text-sm font-medium">1. The Dext CSV</p>
                <input ref={csvInput} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => takeCsv(e.target.files?.[0])} />
                <button type="button" onClick={() => csvInput.current?.click()} className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted">
                  <FileText className="h-4 w-4" /> {csvName || 'Choose CSV'}
                </button>
                {parsed && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {parsed.rows.length} document{parsed.rows.length === 1 ? '' : 's'} in the file.
                    {parsed.missing.length > 0 && ` Columns not found: ${parsed.missing.join(', ')}.`}
                  </p>
                )}
              </div>

              {/* Step 2 — the files */}
              <div className={cn('rounded-lg border p-4', !parsed && 'opacity-50')}>
                <p className="mb-2 text-sm font-medium">2. The documents (optional)</p>
                <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => setFiles([...(e.target.files || [])])} />
                <button type="button" disabled={!parsed} onClick={() => fileInput.current?.click()} className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground/50">
                  <Upload className="h-4 w-4" /> {files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : 'Choose files'}
                </button>
                {match && files.length > 0 && (
                  <div className="mt-2 space-y-1 text-sm text-muted-foreground">
                    <p>{match.matched} of {parsed.rows.length} matched to a document, by the Receipt ID in the filename.</p>
                    {match.withoutFile.length > 0 && (
                      <p className="flex items-start gap-1.5">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        {match.withoutFile.length} will import without their file.
                      </p>
                    )}
                    {match.spare.length > 0 && (
                      <p>{match.spare.length} file{match.spare.length === 1 ? '' : 's'} matched no row and will be ignored.</p>
                    )}
                  </div>
                )}
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}
              {busy && <Row>Importing {progress.at} of {progress.of}…</Row>}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button type="button" onClick={close} disabled={busy} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50">
            {done ? 'Close' : 'Cancel'}
          </button>
          {!done && (
            // The entity is named on the button, because this writes a client's
            // paperwork into a live book and the switcher is at the top of the
            // page rather than in front of you.
            <button
              type="button"
              disabled={!parsed || busy}
              onClick={run}
              className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Importing…' : `Import ${parsed?.rows.length || ''} into ${org?.name || 'this entity'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
