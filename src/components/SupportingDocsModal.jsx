import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { reasonText } from '@/lib/supportingDocs';
import { formatDate } from '@/lib/date';
import { cn } from '@/lib/utils';

// "These came in together, and all but one are the paperwork behind it."
//
// Opened from the Costs toolbar on a selection, or from a row's "Supporting
// document?" badge with the group the rules found (src/lib/supportingDocs.js).
// The one question it asks is WHICH document is the invoice: the rest are set
// aside as its supporting documents. Nothing is combined and nothing is lost:
// each stays a document, linked to the invoice, and Undo puts it back.

const money = (d) => `${d.currency ? `${d.currency} ` : ''}${(Number(String(d.total ?? '').replace(/[^0-9.-]/g, '')) || 0).toFixed(2)}`;
const amount = (d) => Number(String(d.total ?? '').replace(/[^0-9.-]/g, '')) || 0;

export default function SupportingDocsModal({ open, docs, group, onClose, onConfirm, onKeepSeparate, busy, error }) {
  const [mainId, setMainId] = useState('');
  const key = (docs || []).map((d) => d.id).join('|');

  useEffect(() => {
    if (!open) return;
    // The rules' own answer where there is one; else the largest, which is what
    // an invoice recharging the others is.
    const largest = [...(docs || [])].sort((a, b) => amount(b) - amount(a))[0];
    setMainId(group?.mainId || largest?.id || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key, group?.mainId]);

  if (!open || !docs?.length) return null;
  const others = docs.filter((d) => d.id !== mainId);
  const reasons = new Map((group?.mainId === mainId ? group.supports : []).map((s) => [s.id, s]));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-y-auto rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">Supporting documents</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4 p-6">
          <p className="text-sm text-muted-foreground">
            Pick the invoice. The other {others.length === 1 ? 'document is' : `${others.length} documents are`} set aside as its supporting
            paperwork: not published on {others.length === 1 ? 'its' : 'their'} own, so the same spending is not posted twice, and sent to Xero
            as attachments when the invoice is published.
          </p>
          <div className="divide-y rounded-lg border">
            {docs.map((d) => {
              const isMain = d.id === mainId;
              const why = reasons.get(d.id);
              return (
                <label key={d.id} className={cn('flex cursor-pointer items-start gap-3 px-4 py-3 text-sm', isMain && 'bg-muted/50')}>
                  <input type="radio" name="supporting-main" className="mt-1" checked={isMain} onChange={() => setMainId(d.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{d.supplier || 'Unknown supplier'}</span>
                    <span className="text-muted-foreground">
                      {d.invoiceNumber ? ` · ${d.invoiceNumber}` : ''}
                      {d.date && d.date !== '—' ? ` · ${formatDate(d.date)}` : ''}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {isMain ? 'The invoice' : `Supporting document${why ? `: ${reasonText(why)}` : ''}`}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">{money(d)}</span>
                </label>
              );
            })}
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <div className="flex items-center justify-between gap-2 border-t px-6 py-4">
          {group && onKeepSeparate ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onKeepSeparate(group.mainId, group.supports.map((s) => s.id))}
              className="text-sm text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
            >
              Keep separate
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-muted">
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !mainId || !others.length}
              onClick={() => onConfirm(mainId, others.map((d) => d.id))}
              className="inline-flex h-9 items-center rounded-md bg-foreground px-4 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Set aside {others.length} as supporting
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
