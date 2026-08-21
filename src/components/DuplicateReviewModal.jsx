import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';
import {
  DUPLICATE_REASON,
  billFileUrl,
  deleteBill,
  fetchBillFileMeta,
  markNotDuplicate,
  notifyBillsChanged,
  updateBill,
} from '@/lib/bills';
import { cn } from '@/lib/utils';

// Side-by-side duplicate review, Dext-style: the document already on file on
// the LEFT, the one that came in second on the RIGHT. Every action here acts on
// the RIGHT-hand document — the original is never touched — because the flag is
// a question about the new submission, not the old one.
//
// `pairs` is [{ duplicate, original }] in doc shape; several pairs page through
// with Previous / Next. `onMerge` (optional) hands the two documents back to the
// caller's merge review rather than merging behind the reviewer's back.

function Facts({ doc }) {
  const rows = [
    ['Supplier', doc.supplier],
    ['Date', doc.date],
    ['Reference', doc.invoiceNumber || '—'],
    ['Total', `${doc.currency} ${doc.total}`],
    ['Uploaded', doc.createdAt ? new Date(doc.createdAt).toLocaleString('en-SG', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'],
    ['By', doc.user || '—'],
  ];
  return (
    <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 border-t px-3 py-2 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="truncate text-right" title={String(v)}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// The stored file. Resolved by id, so it shows whichever tab you came from.
function Preview({ doc }) {
  const [meta, setMeta] = useState(null);
  useEffect(() => {
    let alive = true;
    setMeta(null);
    fetchBillFileMeta(doc.id)
      .then((m) => { if (alive) setMeta(m); })
      .catch(() => { if (alive) setMeta({ hasFile: false }); });
    return () => { alive = false; };
  }, [doc.id]);

  if (meta === null) return <p className="p-10 text-center text-sm text-muted-foreground">Loading…</p>;
  if (!meta.hasFile) return <p className="p-10 text-center text-sm text-muted-foreground">No file is stored for this document.</p>;
  return String(meta.contentType).includes('pdf') ? (
    <iframe src={billFileUrl(doc.id)} title={`${doc.supplier} document`} className="h-full w-full" />
  ) : (
    // No height cap: a tall invoice should scroll inside its pane (as it does in
    // the pane beside it), not be squashed to fit.
    <img src={billFileUrl(doc.id)} alt={`${doc.supplier} document`} className="mx-auto w-full object-contain" />
  );
}

export default function DuplicateReviewModal({ open, pairs = [], onClose, onResolved = () => {}, onMerge = null }) {
  const [idx, setIdx] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) { setIdx(0); setMenuOpen(false); } }, [open]);

  if (!open || !pairs.length) return null;
  const at = Math.min(idx, pairs.length - 1);
  const { duplicate, original } = pairs[at];
  if (!duplicate || !original) return null;

  // Move to the next pair, or close once the last one is settled.
  const advance = () => {
    setMenuOpen(false);
    onResolved();
    if (at < pairs.length - 1) setIdx(at + 1);
    else onClose();
  };

  const act = async (fn) => {
    setBusy(true);
    try {
      await fn();
      notifyBillsChanged();
      advance();
    } finally {
      setBusy(false);
    }
  };

  const notDuplicate = () => act(() => markNotDuplicate(duplicate.id).catch(() => {}));
  const archive = () => act(() => updateBill(duplicate.id, { status: 'archived' }).catch(() => {}));
  const remove = () => {
    if (!window.confirm(`Delete this second copy?\n\n${duplicate.supplier} · ${duplicate.currency} ${duplicate.total}\n\nThe file goes too, and it can't be undone. The document on the left is kept.`)) return;
    act(() => deleteBill(duplicate.id).catch(() => {}));
  };

  const Pane = ({ label, doc, right = false }) => (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="mb-2 flex h-7 items-center justify-between gap-2">
        <p className={cn('text-xs font-semibold uppercase tracking-wide', right ? 'text-destructive' : 'text-muted-foreground')}>{label}</p>
        {right && pairs.length > 1 && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <button type="button" onClick={() => setIdx(Math.max(0, at - 1))} disabled={at === 0} aria-label="Previous duplicate" className="rounded p-1 hover:bg-muted disabled:opacity-40">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="tabular-nums">{at + 1} / {pairs.length}</span>
            <button type="button" onClick={() => setIdx(Math.min(pairs.length - 1, at + 1))} disabled={at >= pairs.length - 1} aria-label="Next duplicate" className="rounded p-1 hover:bg-muted disabled:opacity-40">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
      <div className={cn('flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border', right && 'border-destructive/40')}>
        <div className="min-h-[45vh] flex-1 overflow-auto bg-muted/30">
          <Preview doc={doc} />
        </div>
        <Facts doc={doc} />
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/40" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex shrink-0 items-center justify-between border-b px-6 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <AlertTriangle className="h-4 w-4 text-destructive" strokeWidth={2} />
            Review duplicate items
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground transition-colors hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 gap-4 overflow-hidden p-4 sm:p-6">
          <Pane label="Already on file" doc={original} />
          <Pane label="New submission" doc={duplicate} right />
        </div>

        <div className="shrink-0 border-t px-6 py-4">
          <p className="mb-3 text-center text-sm">
            Does the <span className="font-medium">new submission</span> describe the same purchase as the document{' '}
            <span className="font-medium">already on file</span>?
            <br />
            <span className="text-xs text-muted-foreground">
              {DUPLICATE_REASON[duplicate.duplicateType] || 'It matches a document already submitted.'} Whatever you choose applies to the
              document on the right — the one on the left is kept either way.
            </span>
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={notDuplicate}
              className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
            >
              No, it’s a different purchase
            </button>
            <div className="relative">
              <button
                type="button"
                disabled={busy}
                onClick={() => setMenuOpen((o) => !o)}
                className="inline-flex h-9 items-center gap-1 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                Yes, it’s the same purchase
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} aria-hidden="true" />
                  <div className="absolute bottom-full left-1/2 z-20 mb-1 w-64 -translate-x-1/2 overflow-hidden rounded-md border bg-background py-1 shadow-lg">
                    {onMerge && (
                      <button
                        type="button"
                        onClick={() => { setMenuOpen(false); onMerge([original, duplicate]); }}
                        className="flex w-full flex-col px-3 py-2 text-left text-sm hover:bg-muted"
                      >
                        Merge them into one
                        <span className="text-xs text-muted-foreground">Keeps both files on one document.</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={archive}
                      className="flex w-full flex-col px-3 py-2 text-left text-sm hover:bg-muted"
                    >
                      Archive the new submission
                      <span className="text-xs text-muted-foreground">Out of the inbox, file kept.</span>
                    </button>
                    <button
                      type="button"
                      onClick={remove}
                      className="flex w-full flex-col px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
                    >
                      Delete the new submission
                      <span className="text-xs text-destructive/70">Removes the document and its file.</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
