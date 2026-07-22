import { useState } from 'react';
import { X, HelpCircle } from 'lucide-react';
import { addVaultTags } from '@/lib/vaultTags';
import { cn } from '@/lib/utils';

const blankRow = () => ({ name: '', rules: '', autoApply: false });

// "Add tags" — Dext's bulk tag editor: one or more rows of Tag + Rules +
// auto-apply toggle.
export default function AddTagsModal({ open, onClose, onAdded }) {
  const [rows, setRows] = useState([blankRow()]);
  if (!open) return null;

  const patch = (i, key, val) => setRows((r) => r.map((row, idx) => (idx === i ? { ...row, [key]: val } : row)));
  const removeRow = (i) => setRows((r) => (r.length === 1 ? [blankRow()] : r.filter((_, idx) => idx !== i)));
  const addRow = () => setRows((r) => [...r, blankRow()]);

  const submit = () => {
    const added = addVaultTags(rows);
    if (added > 0) {
      onAdded?.(added);
      setRows([blankRow()]);
      onClose();
    }
  };
  const canSubmit = rows.some((r) => r.name.trim());

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-6">
          <h2 className="text-base font-semibold tracking-tight">Add tags</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          <p className="mb-1 text-sm font-medium">Instructions examples</p>
          <ul className="mb-5 space-y-1 text-sm text-muted-foreground">
            <li><span className="font-medium text-foreground">Payroll</span> Apply this tag when the document is about employee compensation.</li>
            <li><span className="font-medium text-foreground">Finance</span> Apply this tag to all documents addressed to Jim and Jane.</li>
            <li><span className="font-medium text-foreground">Quality control</span> Apply this tag to all delivery notes.</li>
          </ul>

          <div className="overflow-hidden rounded-lg border">
            <div className="grid grid-cols-[1fr_2fr_140px_40px] items-center gap-3 border-b bg-muted/40 px-4 py-2.5 text-sm font-medium text-muted-foreground">
              <span>Tag</span>
              <span className="inline-flex items-center gap-1">Rules <HelpCircle className="h-3.5 w-3.5" /></span>
              <span className="inline-flex items-center gap-1">Auto-apply tag <HelpCircle className="h-3.5 w-3.5" /></span>
              <span />
            </div>
            {rows.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_2fr_140px_40px] items-start gap-3 border-b px-4 py-3 last:border-0">
                <input
                  value={row.name}
                  onChange={(e) => patch(i, 'name', e.target.value)}
                  className="h-10 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <textarea
                  value={row.rules}
                  onChange={(e) => patch(i, 'rules', e.target.value)}
                  rows={1}
                  className="min-h-10 rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <button type="button" onClick={() => patch(i, 'autoApply', !row.autoApply)} className="flex items-center gap-2 pt-2">
                  <span className={cn('flex h-5 w-9 items-center rounded-full p-0.5 transition-colors', row.autoApply ? 'justify-end bg-foreground' : 'justify-start border')}>
                    <span className={cn('h-4 w-4 rounded-full', row.autoApply ? 'bg-background' : 'bg-muted-foreground/50')} />
                  </span>
                  <span className="text-sm text-muted-foreground">{row.autoApply ? 'Yes' : 'No'}</span>
                </button>
                <button type="button" onClick={() => removeRow(i)} className="pt-2.5 text-destructive/70 hover:text-destructive" aria-label="Remove row">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
            <div className="px-4 py-3">
              <button type="button" onClick={addRow} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
                Add
              </button>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end border-t px-6 py-4">
          <button type="button" onClick={submit} disabled={!canSubmit} className="inline-flex h-9 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
            Add tags
          </button>
        </div>
      </div>
    </div>
  );
}
