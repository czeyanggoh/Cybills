import { useEffect, useRef, useState } from 'react';
import { X, AlertTriangle, Loader2 } from 'lucide-react';
import { buildMergePreview } from '@/lib/mergeDocs';
import { displayItemId } from '@/lib/bills';
import { cn } from '@/lib/utils';

// Dext-style "Merge items" review screen: combined document preview on the left,
// the combined details (editable) on the right, a "Merging N items" summary, and
// a warning when the selected items look unrelated. Nothing is created until the
// reviewer confirms with Merge.
function Row({ label, children }) {
  return (
    <div className="grid grid-cols-[7rem,1fr] items-center gap-3 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

const inputCls =
  'w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

export default function MergeModal({ open, docs, categoryOptions = [], onClose, onConfirm }) {
  const [building, setBuilding] = useState(false);
  const [preview, setPreview] = useState(null);
  const [fields, setFields] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const urlRef = useRef('');

  // Build the combined PDF + re-extract when the modal opens.
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setBuilding(true);
    setError('');
    setPreview(null);
    setFields(null);
    (async () => {
      try {
        const p = await buildMergePreview(docs);
        if (!alive) return;
        if (!p) {
          setError('Select at least 2 documents that each have an uploaded file.');
          return;
        }
        const blob = new Blob([Uint8Array.from(atob(p.base64), (c) => c.charCodeAt(0))], {
          type: 'application/pdf',
        });
        urlRef.current = URL.createObjectURL(blob);
        setPreview({ ...p, url: urlRef.current });
        setFields(p.fields);
      } catch {
        if (alive) setError('Could not prepare the merge. Please try again.');
      } finally {
        if (alive) setBuilding(false);
      }
    })();
    return () => {
      alive = false;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = '';
      }
    };
  }, [open, docs]);

  if (!open) return null;

  const set = (k, v) => setFields((f) => ({ ...f, [k]: v }));
  const submit = async () => {
    if (!preview || !fields || submitting) return;
    setSubmitting(true);
    await onConfirm(preview.sources, preview.base64, fields);
    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border bg-background shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-sm font-semibold">Merge items</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        {building ? (
          <div className="flex flex-1 items-center justify-center gap-2 px-6 py-24 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Combining documents and re-reading the fields…
          </div>
        ) : error ? (
          <div className="px-6 py-16 text-center text-sm text-muted-foreground">{error}</div>
        ) : preview && fields ? (
          <>
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto p-5 md:grid-cols-2">
              {/* Preview */}
              <div className="min-h-[320px] overflow-hidden rounded-lg border bg-muted/30">
                <iframe src={preview.url} title="Merged document preview" className="h-full min-h-[320px] w-full" />
              </div>

              {/* Combined details */}
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Merging {preview.sources.length} items:</span>
                  {preview.sources.map((d) => (
                    <span key={d.id} className="rounded bg-muted px-1.5 py-0.5 tabular-nums">{displayItemId(d.id)}</span>
                  ))}
                </div>

                {preview.warnings.length > 0 && (
                  <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      These items have {preview.warnings.join(', ')}. Make sure they belong to the same
                      document before merging.
                    </span>
                  </div>
                )}

                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Item details</p>
                <Row label="Type"><input className={inputCls} value={fields.documentType} onChange={(e) => set('documentType', e.target.value)} /></Row>
                <Row label="Date"><input className={inputCls} value={fields.date} onChange={(e) => set('date', e.target.value)} /></Row>
                <Row label="Supplier"><input className={inputCls} value={fields.supplier} onChange={(e) => set('supplier', e.target.value)} /></Row>
                <Row label="Category">
                  <select className={cn(inputCls, 'appearance-none')} value={fields.category} onChange={(e) => set('category', e.target.value)}>
                    <option value="">Uncategorised</option>
                    {categoryOptions.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </Row>
                <p className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Amount</p>
                <Row label="Currency"><input className={inputCls} value={fields.currency} onChange={(e) => set('currency', e.target.value)} /></Row>
                <Row label="Total amount"><input className={inputCls} value={fields.total} onChange={(e) => set('total', e.target.value)} /></Row>
                <Row label="Tax amount"><input className={inputCls} value={fields.tax} onChange={(e) => set('tax', e.target.value)} /></Row>

                {preview.skipped > 0 && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {preview.skipped} selected item{preview.skipped === 1 ? '' : 's'} without a file {preview.skipped === 1 ? 'was' : 'were'} left out.
                  </p>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
              <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm hover:bg-muted">
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Merge
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
