import { useState, useEffect } from 'react';
import { Image as ImageIcon, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchBillFileMeta, billFileUrl } from '@/lib/bills';
import { cn } from '@/lib/utils';

// An image icon that opens a lightbox of the uploaded receipt(s). `itemIds` is
// one bill id or a list of them (a claim's line items) — each item's receipt is
// the file stored on its cost document, resolved globally by id (so it shows
// even when the document lives in another org's book). Items without a stored
// file are skipped; if none have one, the lightbox says so.
export default function ReceiptViewer({ itemIds, size = 'sm' }) {
  const ids = (Array.isArray(itemIds) ? itemIds : [itemIds]).map(String).filter(Boolean);
  const idsKey = ids.join(',');
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState(null); // null = not loaded yet; else [{id, contentType}]
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (!open || files) return undefined;
    let alive = true;
    Promise.all(ids.map((id) => fetchBillFileMeta(id).then((m) => ({ id, ...m }))))
      .then((metas) => { if (alive) setFiles(metas.filter((m) => m.hasFile)); })
      .catch(() => { if (alive) setFiles([]); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, files, idsKey]);

  const dim = size === 'lg' ? 'h-4 w-4' : 'h-3.5 w-3.5';
  const withFiles = files || [];
  const cur = withFiles[Math.min(idx, Math.max(0, withFiles.length - 1))];

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setIdx(0); setOpen(true); }}
        aria-label="View receipt"
        title="View receipt"
        className="inline-flex items-center"
      >
        <ImageIcon className={cn(dim, 'text-muted-foreground/60 hover:text-foreground')} strokeWidth={1.75} />
      </button>
      {open && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
          <div className="absolute inset-0 bg-foreground/50" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
            <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
              <span className="text-sm font-medium">
                Uploaded receipt{withFiles.length > 1 ? ` (${Math.min(idx, withFiles.length - 1) + 1} of ${withFiles.length})` : ''}
              </span>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="text-muted-foreground hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="relative flex-1 overflow-auto bg-muted/30">
              {files === null ? (
                <p className="p-12 text-center text-sm text-muted-foreground">Loading…</p>
              ) : !cur ? (
                <p className="p-12 text-center text-sm text-muted-foreground">No receipt image is attached to this {ids.length > 1 ? 'claim' : 'item'}.</p>
              ) : String(cur.contentType).includes('pdf') ? (
                <iframe src={billFileUrl(cur.id)} title="Uploaded receipt" className="h-[70vh] w-full" />
              ) : (
                <img src={billFileUrl(cur.id)} alt="Uploaded receipt" className="mx-auto max-h-[74vh] w-full object-contain" />
              )}
              {withFiles.length > 1 && cur && (
                <>
                  <button type="button" onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx <= 0} aria-label="Previous" className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full border bg-background p-1.5 shadow disabled:opacity-40">
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button type="button" onClick={() => setIdx((i) => Math.min(withFiles.length - 1, i + 1))} disabled={idx >= withFiles.length - 1} aria-label="Next" className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full border bg-background p-1.5 shadow disabled:opacity-40">
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
