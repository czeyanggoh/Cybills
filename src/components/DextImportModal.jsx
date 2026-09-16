import { useMemo, useRef, useState } from 'react';
import { X, Upload, FileText, Check, AlertTriangle } from 'lucide-react';
import {
  parseDextExport, matchFiles, billPayload, patchPayload, importedDextIds, planImport,
  isClaimRow, planClaims, claimName, importedClaimIds,
} from '@/lib/dextImport';
import { addBill, updateBill, fetchBills, fetchDextImage, sha256Hex, notifyBillsChanged } from '@/lib/bills';
import { createClaim, addItemToClaim, docToClaimTxn, fetchClaims } from '@/lib/claimStore';
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
  // The Item IDs already in this entity's book, read when the CSV is chosen so
  // the skips are counted before anything is fetched.
  const [heldIds, setHeldIds] = useState(null);
  // The documents themselves, by Item ID — a claim's items may have come across
  // in an earlier import, and the claim needs their ids to put them on it.
  const [heldBills, setHeldBills] = useState(new Map());
  const [heldClaims, setHeldClaims] = useState(new Set());
  const [files, setFiles] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [progress, setProgress] = useState({ at: 0, of: 0 });
  const csvInput = useRef(null);
  const fileInput = useRef(null);

  // A claim row is not a document: it is rebuilt as a claim from its items.
  const plan = useMemo(
    () => (parsed && heldIds ? planImport(parsed.rows.filter((r) => !isClaimRow(r)), heldIds) : null),
    [parsed, heldIds]
  );
  const claimPlan = useMemo(() => {
    if (!parsed) return null;
    const p = planClaims(parsed.rows);
    return {
      ...p,
      toCreate: p.claims.filter((c) => !heldClaims.has(c.row.receiptId)),
      already: p.claims.filter((c) => heldClaims.has(c.row.receiptId)).length,
    };
  }, [parsed, heldClaims]);
  const match = useMemo(
    () => (plan ? matchFiles(plan.toImport, files) : null),
    [plan, files]
  );

  if (!open) return null;

  const reset = () => {
    setCsvName(''); setParsed(null); setHeldIds(null); setHeldBills(new Map()); setHeldClaims(new Set()); setFiles([]); setError(''); setDone(null); setProgress({ at: 0, of: 0 });
  };
  const close = () => { if (!busy) { reset(); onClose(); } };

  // One CSV or several: Dext exports a client's costs and its expense claims as
  // separate lists, and a claim can only be rebuilt with its items beside it.
  const takeCsv = async (picked) => {
    const list = [...(picked || [])];
    if (!list.length) return;
    setError(''); setDone(null);
    try {
      const results = await Promise.all(list.map(async (f) => parseDextExport(await f.text())));
      const rows = results.flatMap((r) => r.rows);
      if (!rows.length) {
        setError('That file has no rows in it. Export the Costs list from Dext as CSV and try that.');
        return;
      }
      // A column is only missing if no file carries it.
      const missing = results[0].missing.filter((h) => results.every((r) => r.missing.includes(h)));
      setCsvName(list.length === 1 ? list[0].name : `${list.length} CSV files`);
      setHeldIds(null);
      setParsed({ rows, missing });
      // The server refuses a held ID regardless; this is so the screen can say
      // how many will be skipped, and not fetch their images for nothing.
      const [bills, claims] = await Promise.all([fetchBills(), fetchClaims()]);
      setHeldBills(new Map(bills.filter((b) => b.dextId && b.status !== 'deleted').map((b) => [String(b.dextId), b])));
      setHeldClaims(importedClaimIds(claims));
      setHeldIds(importedDextIds(bills));
    } catch {
      setError('That file could not be read as a CSV.');
    }
  };

  const run = async () => {
    if (!match || busy) return;
    setBusy(true);
    setError('');
    const outcome = {
      created: 0,
      withFile: 0,
      skipped: plan.alreadyImported.length + plan.repeated.length,
      failed: [],
      claims: 0,
      claimsFailed: [],
    };
    // Every document this run can put on a claim, by Item ID: the ones already
    // here and the ones about to be made.
    const byDextId = new Map(heldBills);
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
        // force: everything in the export comes across. A migration is moving a
        // book, and CYBills' duplicate rule is not Dext's — same supplier, same
        // total, a day apart is a work permit APPLIED for and the same permit
        // ISSUED — so a row left behind is real paperwork lost. Which of them
        // resemble each other is not reported here: the inbox already flags
        // them ("Possible duplicate", "Review duplicates"), and saying it twice
        // in two places is two things to keep agreeing with each other.
        // eslint-disable-next-line no-await-in-loop
        const res = await addBill(body, { force: true });
        if (res?.alreadyImported) {
          // Imported since this screen counted — another tab, or somebody else.
          outcome.skipped += 1;
        } else if (res?.bill?.id) {
          outcome.created += 1;
          if (row.receiptId) byDextId.set(row.receiptId, res.bill);
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
    // The claims, once their items exist. All or nothing per claim: a claim
    // short of one of its receipts would total something Dext never claimed.
    for (const c of claimPlan?.toCreate || []) {
      const who = `${c.claimFor} (${c.row.receiptId})`;
      const docs = c.items.map((i) => byDextId.get(i.receiptId));
      const gone = docs.some((d) => !d);
      const taken = docs.some((d) => d && (d.xeroInvoiceId || d.status === 'expenseclaim'));
      if (gone || taken) {
        outcome.claimsFailed.push(`${who}: ${gone ? 'not every item imported' : 'an item is already published or on another claim'}`);
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const claim = await createClaim({ claimFor: c.claimFor, name: claimName(c.row), endDate: c.row.date });
        for (const d of docs) {
          // eslint-disable-next-line no-await-in-loop
          await addItemToClaim(claim.id, docToClaimTxn(d, d, ''));
        }
        outcome.claims += 1;
      } catch (err) {
        outcome.claimsFailed.push(`${who}: ${err?.message || 'could not be created'}`);
      }
    }
    if (outcome.claims) notifyBillsChanged();

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
              {done.skipped > 0 && (
                <Row>
                  {done.skipped} skipped: their Item ID was already in {org?.name || 'this entity'}.
                </Row>
              )}
              {done.claims > 0 && (
                <Row>
                  {done.claims} expense claim{done.claims === 1 ? '' : 's'} rebuilt with {done.claims === 1 ? 'its' : 'their'} items, as drafts to submit.
                </Row>
              )}
              {done.claimsFailed.length > 0 && (
                <p className="text-sm text-destructive">
                  Claims not created — {done.claimsFailed.join('; ')}
                </p>
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
                Export the client&rsquo;s Costs list from Dext as CSV (add the Expense claims export beside it to bring the claims across too). It carries the coding already
                done there — supplier, date, category, tax — so nothing is read again and nothing is
                charged for reading it, and its Image column is where each document itself is
                fetched from.
              </Row>

              {/* Step 1 — the CSV */}
              <div className="rounded-lg border p-4">
                <p className="mb-2 text-sm font-medium">1. The Dext CSV</p>
                <input ref={csvInput} type="file" multiple accept=".csv,text/csv" className="hidden" onChange={(e) => takeCsv(e.target.files)} />
                <button type="button" onClick={() => csvInput.current?.click()} className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted">
                  <FileText className="h-4 w-4" /> {csvName || 'Choose CSV'}
                </button>
                {parsed && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {parsed.rows.length} document{parsed.rows.length === 1 ? '' : 's'} in the file.
                    {parsed.missing.length > 0 && ` Columns not found: ${parsed.missing.join(', ')}.`}
                  </p>
                )}
                {claimPlan && claimPlan.claimRows.length > 0 && (
                  <div className="mt-2 space-y-1 text-sm text-muted-foreground">
                    <p>
                      {claimPlan.claimRows.length} expense claim{claimPlan.claimRows.length === 1 ? '' : 's'}:{' '}
                      {claimPlan.toCreate.length} will be rebuilt from the items that add up to {claimPlan.toCreate.length === 1 ? 'it' : 'them'}
                      {claimPlan.already > 0 && `, ${claimPlan.already} already imported`}.
                    </p>
                    {claimPlan.unmatched.map((u) => (
                      <p key={u.row.receiptId || u.row.line} className="flex items-start gap-1.5">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        {u.row.owner || u.row.supplier || 'A claim'} ({u.row.total}):{' '}
                        {{
                          no_items: 'no claimed items for this person in the files. Add the Costs export too.',
                          no_match: 'their claimed items don’t add up to it.',
                          ambiguous: 'more than one set of their items adds up to it, so it is left for you.',
                          too_many: 'too many claimed items to match safely.',
                          no_total: 'the claim has no total.',
                        }[u.reason]}
                      </p>
                    ))}
                  </div>
                )}
                {parsed && !plan && <p className="mt-1 text-sm text-muted-foreground">Checking which are already imported…</p>}
                {plan && (plan.alreadyImported.length > 0 || plan.repeated.length > 0) && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {plan.alreadyImported.length > 0 &&
                      `${plan.alreadyImported.length} already imported (same Item ID) and will be skipped. `}
                    {plan.repeated.length > 0 &&
                      `${plan.repeated.length} repeat${plan.repeated.length === 1 ? 's' : ''} an Item ID earlier in the file and will be skipped.`}
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
                    {(plan?.toImport || parsed.rows).filter((r) => r.image).length} of {(plan?.toImport || parsed.rows).length} will be
                    fetched from the links in the CSV. Add files here only to override that.
                  </p>
                )}
                {match && files.length > 0 && (
                  <div className="mt-2 space-y-1 text-sm text-muted-foreground">
                    <p>{match.matched} of {plan.toImport.length} matched to a document, by the Item ID in the filename.</p>
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
              disabled={!plan || (!plan.toImport.length && !claimPlan?.toCreate.length) || busy}
              onClick={run}
              className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Importing…' : `Import ${plan ? plan.toImport.length : ''}${claimPlan?.toCreate.length ? ` + ${claimPlan.toCreate.length} claim${claimPlan.toCreate.length === 1 ? '' : 's'}` : ''} into ${org?.name || 'this entity'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
