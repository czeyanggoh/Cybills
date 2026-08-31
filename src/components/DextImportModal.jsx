import { useMemo, useRef, useState } from 'react';
import { X, Upload, FileText, AlertTriangle, Check } from 'lucide-react';
import { parseDextExport, matchFiles, billPayload, patchPayload } from '@/lib/dextImport';
import { addBill, updateBill, fetchDextImage, sha256Hex, billFileUrl, fetchBillFileMeta } from '@/lib/bills';
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


// One skipped row, with both documents put side by side on request.
//
// Naming a skip is not enough to act on it: "Anthropic · 2026-08-29 · SGD 300"
// describes the pair equally well whether they are one receipt or two, and the
// only thing that settles it is looking at them. So the Dext document and the
// one already here are shown together — the Dext side fetched through the
// server, since those links send no CORS headers and the browser is refused
// them.
function SkippedRow({ row, imported = false }) {
  const [open, setOpen] = useState(false);
  const [dext, setDext] = useState(undefined); // undefined = not asked, null = no good
  const [mine, setMine] = useState(undefined);
  const [failed, setFailed] = useState(false);

  const show = async () => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    if (dext === undefined && row.image) {
      const got = await fetchDextImage(row.image);
      if (got) {
        const bytes = bytesOf(got.base64);
        setDext({
          url: URL.createObjectURL(new Blob([bytes], { type: got.contentType || 'application/octet-stream' })),
          type: got.contentType || '',
        });
      } else {
        setDext(null);
        setFailed(true);
      }
    }
    // Its content type, not a guess from the URL: the file route names no
    // extension, so a stored PDF would render into an <img> and show broken.
    if (mine === undefined && row.matchedBillId) {
      const meta = await fetchBillFileMeta(row.matchedBillId);
      setMine(meta?.hasFile ? { url: billFileUrl(row.matchedBillId), type: meta.contentType || '' } : null);
    }
  };

  return (
    <li className="rounded-md border bg-background/60 p-2">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{row.id}</span>
          {row.what ? ` — ${row.what}` : ''}
          {row.same
            ? ' · the very same file'
            : row.matched
              ? ` · looks like ${row.matched}`
              : ' · looks like one already here'}
          {imported && row.mine ? ` · imported as ${row.mine}` : ''}
        </p>
        {/* Nothing to compare when the two are byte-identical: they are the
            same picture, and offering to show it twice is a waste of a click. */}
        {(imported || !row.same) && (row.image || row.matchedBillId) && (
          <button
            type="button"
            onClick={show}
            className="shrink-0 text-xs font-medium underline underline-offset-2 hover:opacity-70"
          >
            {open ? 'Hide' : 'Compare'}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <DocPane label="From Dext" src={dext?.url} type={dext?.type} pending={dext === undefined} failed={failed} />
          <DocPane
            label={`Already here${row.matched ? ` · ${row.matched}` : ''}`}
            src={mine?.url}
            type={mine?.type}
            pending={mine === undefined && Boolean(row.matchedBillId)}
          />
        </div>
      )}
    </li>
  );
}

// A document, however it is stored. A PDF needs a frame and an image needs an
// img; guessing wrong shows a broken icon over a perfectly good receipt.
function DocPane({ label, src, type = '', pending = false, failed = false }) {
  const isPdf = /pdf/i.test(type) || /\.pdf($|\?)/i.test(String(src || ''));
  return (
    <div className="min-w-0">
      <p className="mb-1 truncate text-[11px] text-muted-foreground">{label}</p>
      <div className="flex h-44 items-center justify-center overflow-hidden rounded border bg-muted/30">
        {pending && <span className="text-[11px] text-muted-foreground">Loading…</span>}
        {!pending && !src && (
          <span className="px-2 text-center text-[11px] text-muted-foreground">
            {failed ? 'Could not be fetched' : 'No document'}
          </span>
        )}
        {!pending && src && (isPdf
          ? <iframe title={label} src={src} className="h-full w-full" />
          : <img alt={label} src={src} className="max-h-full max-w-full object-contain" />)}
      </div>
      {src && (
        <a href={src} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[11px] underline underline-offset-2 hover:opacity-70">
          Open full size
        </a>
      )}
    </div>
  );
}

export default function DextImportModal({ open, onClose, onImported }) {
  const org = useActiveOrganisation();
  const [csvName, setCsvName] = useState('');
  const [parsed, setParsed] = useState(null);
  const [files, setFiles] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [progress, setProgress] = useState({ at: 0, of: 0 });
  // A migration is moving a book, and CYBills' duplicate rule is not Dext's:
  // same supplier, same total, a day apart is a work permit APPLIED for and the
  // same permit ISSUED. Within one export those rows match each other, so
  // skipping loses real paperwork — hence everything comes across by default,
  // flagged rather than dropped. Unticking gets the cautious behaviour back.
  const [importAll, setImportAll] = useState(true);
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
    const outcome = { created: 0, withFile: 0, skipped: [], flagged: [], failed: [] };
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
        // A document the server already has is NOT imported again — which is
        // what keeps a run repeatable, so a migration can be topped up without
        // making a second copy of everything. But a skip is never silent: every
        // one is named, with what it is and what it matched, because "67 of 70
        // imported" without saying which three is a puzzle rather than a
        // report.
        // eslint-disable-next-line no-await-in-loop
        const res = await addBill(body, { force: importAll });
        if (res?.bill?.id && res?.duplicate) {
          // Imported anyway, and told apart from the rest by its OWN item id —
          // without that the report names a document to go and look at and no
          // way to find it.
          outcome.flagged.push({
            id: row.receiptId || `line ${row.line}`,
            what: [row.supplier, row.date, row.total && `${row.currency || ''} ${row.total}`.trim()]
              .filter(Boolean)
              .join(' · '),
            same: res.duplicate.type === 'exact_file',
            mine: res.bill.displayId || '',
            matched: res.duplicate.bill?.displayId || '',
            image: row.image || '',
            matchedBillId: res.duplicate.bill?.id || '',
          });
        }
        if (res?.duplicate && !res?.bill) {
          outcome.skipped.push({
            id: row.receiptId || `line ${row.line}`,
            what: [row.supplier, row.date, row.total && `${row.currency || ''} ${row.total}`.trim()]
              .filter(Boolean)
              .join(' · '),
            // 'exact_file' is the same bytes; anything else is a resemblance.
            same: res.duplicate.type === 'exact_file',
            matched: res.duplicate.bill?.displayId || '',
            // Both sides of the comparison, so the pair can be LOOKED at rather
            // than reasoned about from a supplier and a total.
            image: row.image || '',
            matchedBillId: res.duplicate.bill?.id || '',
          });
        } else if (res?.bill?.id) {
          outcome.created += 1;
          if (body.fileBase64) outcome.withFile += 1;
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
      {/* Wider once there is a pair to compare: two documents at 240px each are
          a thumbnail, and the whole point is being able to tell them apart. */}
      <div
        className={cn(
          'relative flex max-h-[90vh] w-full flex-col overflow-hidden rounded-lg bg-background shadow-xl',
          done?.skipped?.length ? 'max-w-3xl' : 'max-w-lg'
        )}
      >
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
              {done.flagged.length > 0 && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                  <p className="flex items-start gap-1.5 text-sm font-medium">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {done.flagged.length} look like documents already here.
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    All of them were imported — nothing was left behind. Compare each pair and
                    delete whichever copy you don&rsquo;t want. Often they are not copies at all:
                    one supplier, one amount, a day apart is an ordinary week.
                  </p>
                  <ul className="mt-2 max-h-[22rem] space-y-2 overflow-y-auto">
                    {done.flagged.map((d) => <SkippedRow key={d.id} row={d} imported />)}
                  </ul>
                </div>
              )}
              {done.skipped.length > 0 && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                  <p className="flex items-start gap-1.5 text-sm font-medium">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {done.skipped.length} skipped — CYBills already has them.
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Each is listed with what it is, so you can check it in Dext and add it by hand if
                    it really is a separate document. Running this import again will skip them the
                    same way rather than making a second copy.
                  </p>
                  <ul className="mt-2 max-h-[22rem] space-y-2 overflow-y-auto">
                    {done.skipped.map((d) => <SkippedRow key={d.id} row={d} />)}
                  </ul>
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

              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={importAll}
                  onChange={(e) => setImportAll(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-black"
                />
                <span>
                  Import everything, even where it looks like a duplicate
                  <span className="block text-xs text-muted-foreground">
                    On, nothing in the export is left behind and lookalikes are flagged to compare.
                    Off, a document CYBills already has is skipped — safe to re-run, but a genuine
                    second receipt from the same supplier on the same day is dropped.
                  </span>
                </span>
              </label>

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
