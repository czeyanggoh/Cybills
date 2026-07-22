import { useState } from 'react';
import { X } from 'lucide-react';
import { addCustomCategory } from '@/lib/customCategories';

// "Add category" dialog — mirrors Dext's. Creates a category (Name required,
// Code optional) that becomes available in every category dropdown.
export default function AddCategoryModal({ open, onClose, onAdded }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  if (!open) return null;

  const add = () => {
    const label = addCustomCategory(name, code);
    if (!label) return;
    onAdded?.(label);
    setName('');
    setCode('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-lg overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex h-14 items-center justify-between border-b px-6">
          <h2 className="text-base font-semibold tracking-tight">Add category</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          <label className="flex items-center gap-4 text-sm">
            <span className="w-20 shrink-0 text-muted-foreground">Name <span className="text-destructive">*</span></span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className="h-10 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="flex items-center gap-4 text-sm">
            <span className="w-20 shrink-0 text-muted-foreground">Code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="h-10 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">Cancel</button>
          <button
            type="button"
            onClick={add}
            disabled={!name.trim()}
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
