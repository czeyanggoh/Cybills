import { useState } from 'react';
import { X, Info, FileText } from 'lucide-react';
import { CATEGORIES } from '@/data/categories';
import { cn } from '@/lib/utils';
import ComboSelect from '@/components/ComboSelect';

// Field group used for both the current and the new item.
function ItemFields({ heading, category, total, tax, onChange }) {
  return (
    <div>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {heading}
      </h3>
      <div className="space-y-3">
        <label className="flex items-center gap-3 text-sm">
          <span className="w-28 shrink-0 text-muted-foreground">Category</span>
          <div className="flex-1">
            <ComboSelect
              aria-label="Category"
              value={category}
              options={CATEGORIES}
              onChange={(v) => onChange('category', v)}
              emptyLabel="Select a category"
            />
          </div>
        </label>
        <label className="flex items-center gap-3 text-sm">
          <span className="w-28 shrink-0 text-muted-foreground">Total amount</span>
          <input
            value={total}
            onChange={(e) => onChange('total', e.target.value)}
            inputMode="decimal"
            className="h-9 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="flex items-center gap-3 text-sm">
          <span className="w-28 shrink-0 text-muted-foreground">Tax amount</span>
          <input
            value={tax}
            onChange={(e) => onChange('tax', e.target.value)}
            inputMode="decimal"
            className="h-9 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
      </div>
    </div>
  );
}

// "Split item" dialog — mirrors Dext's, rendered black & white. Splitting keeps
// the same image and lets you divide the total/tax across two categorised items.
export default function SplitItemModal({ open, onClose, onSplit, imageUrl, previewType, current }) {
  const [cur, setCur] = useState({
    category: current?.category || '',
    total: current?.total || '',
    tax: current?.tax || '',
  });
  const [next, setNext] = useState({ category: '', total: '', tax: '' });

  if (!open) return null;

  const patch = (setter) => (key, value) => setter((s) => ({ ...s, [key]: value }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-6">
          <h2 className="text-base font-semibold tracking-tight">Split item</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-6 overflow-auto p-6 md:grid-cols-2">
          {/* Preview */}
          <div className="overflow-hidden rounded-lg border bg-muted/30">
            {imageUrl ? (
              previewType === 'pdf' ? (
                <iframe src={imageUrl} title="Document" className="h-[420px] w-full" />
              ) : (
                <img src={imageUrl} alt="Document" className="max-h-[420px] w-full object-contain" />
              )
            ) : (
              <div className="flex h-[420px] flex-col items-center justify-center gap-2 text-muted-foreground">
                <FileText className="h-8 w-8" strokeWidth={1.5} />
                <span className="text-sm">No preview</span>
              </div>
            )}
          </div>

          {/* Fields */}
          <div className="space-y-6">
            <p className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-3 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              Splitting creates a new item with the same image as the current item. You can apply
              different categories, total and tax amounts. All other fields of the new item will be
              copied from the current item.
            </p>
            <ItemFields heading="Current item" {...cur} onChange={patch(setCur)} />
            <ItemFields heading="New item" {...next} onChange={patch(setNext)} />
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSplit?.({ current: cur, next })}
            className={cn(
              'inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90'
            )}
          >
            Split
          </button>
        </div>
      </div>
    </div>
  );
}
