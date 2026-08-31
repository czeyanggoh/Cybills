import { useMemo, useRef, useState } from 'react';
import { X, Upload, FileText, AlertTriangle, Check } from 'lucide-react';
import { parseDextExport, matchFiles, billPayload, patchPayload } from '@/lib/dextImport';
import { addBill, updateBill, fetchDextImage, sha256Hex } from '@/lib/bills';
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

// base64 back to bytes, so a document fetched from a link is hashed exactly as
// an uploaded one is — the two paths must agree about what "the same file" is.
const bytesOf = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

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
    const outcome = { created: 0, withFile: 0, duplicates: [], reruns: [], failed: [] };
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
          // The exact-file key. Without it the server can only ever compare a
          // document by supplier, date and total — so importing the very same
          // file twice reads as a coincidence rather than as a re-run.
          // eslint-disable-next-line no-await-in-loop
          body.fileHash = await sha256Hex(file);
        } else if (row.image) {
          // No downloaded file, but the export named where the document lives.
          // Fetched through the server, because those links send no CORS
          // headers and the browser is refused them.
          // eslint-disable-next-line no-await-in-loop
          const got = await fetchDextImage(row.image);
          if (got) {
            body.fileBase64 = got.base64;
            body.mediaType = got.contentType || 'application/octet-stream';
            body.fileName = `${row.receiptId || 'document'}`;
            // eslint-disable-next-line no-await-in-loop
            body.fileHash = await sha256Hex(new Blob([bytesOf(got.base64)]));
          }
        }
        // Straight to the inbox, not 'processing': there is nothing to read.
        //
        // force: EVERYTHING in the export comes across. A migration is moving a
        // book, not adding a document, and a row silently left behind is the
        // one nobody finds until it is missing from a return — Dext's own
        // duplicate rules are not these, and two receipts from one supplier on
        // one day for one amount is an ordinary Tuesday. The server still says
        // which ones it matched, so they are named here and flagged for review
        // rather than dropped.
        // eslint-disable-next-line no-await-in-loop
        const res = await addBill(body, { force: true });
        if (res?.bill?.id) {
          outcome.created += 1;
          if (body.fileBase64) outcome.withFile += 1;
          // Two different things wear the word "duplicate" here, and only one
          // of them is interesting. A byte-identical file already in this book
          // is not a coincidence — it is this import having been run before —
          // so it is reported apart from a document that merely shares a
          // supplier, a date and a total with another.
          const id = row.receiptId || `line ${row.line}`;
          if (res.duplicate?.type === 'exact_file') outcome.reruns.push(id);
          else if (res.duplicate) outcome.duplicates.push(id);
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
              {done.reruns.length > 0 && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
                  <p className="flex items-start gap-1.5 text-sm font-medium">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {done.reruns.length} were the very same file as a document already here.
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    That usually means this export has been imported before, and these are now
                    second copies. They were imported as asked — delete them if this was a re-run.
                  </p>
                  <p className="mt-1 break-words text-xs text-muted-foreground">{done.reruns.join(', ')}</p>
                </div>
              )}
              {done.duplicates.length > 0 && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                  <p className="flex items-start gap-1.5 text-sm font-medium">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {done.duplicates.length} look like documents already here.
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    All of them were imported — nothing was left behind. Check them under{' '}
                    <span className="font-medium text-foreground">Review duplicates</span> in the
                    inbox and delete whichever copy you don&rsquo;t want.
                  </p>
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {done.duplicates.join(', ')}
                  </p>
                </div>
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
                Export the client&rsquo;s Costs list from Dext as CSV. It carries the coding already
                done there — supplier, date, category, tax — so nothing is read again and nothing is
                charged for reading it, and its Image column is where each document itself is
                fetched from.
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
                <p className="mb-2 text-sm font-medium">2. Downloaded documents (only if you have them)</p>
                <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => setFiles([...(e.target.files || [])])} />
                <button type="button" disabled={!parsed} onClick={() => fileInput.current?.click()} className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground/50">
                  <Upload className="h-4 w-4" /> {files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : 'Choose files'}
                </button>
                {parsed && files.length === 0 && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {parsed.rows.filter((r) => r.image).length} of {parsed.rows.length} will be
                    fetched from the links in the CSV. Add files here only to override that.
                  </p>
                )}
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
