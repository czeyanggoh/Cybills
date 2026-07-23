import { useState } from 'react';
import { X } from 'lucide-react';
import { setProfileEmail } from '@/lib/profileStore';

// "Change email" — updates the account email (mock; persisted locally).
export default function ChangeEmailModal({ open, currentEmail, onClose, onSaved }) {
  const [email, setEmail] = useState(currentEmail || '');
  if (!open) return null;

  const valid = /.+@.+\..+/.test(email.trim());
  const save = () => {
    if (!valid) return;
    setProfileEmail(email.trim());
    onSaved?.(email.trim());
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-lg overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex h-14 items-center justify-between border-b px-6">
          <h2 className="text-base font-semibold tracking-tight">Change email</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-6">
          <label className="grid grid-cols-[80px_1fr] items-center gap-4 text-sm">
            <span>Email</span>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              type="email"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">Cancel</button>
          <button type="button" onClick={save} disabled={!valid} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">Save</button>
        </div>
      </div>
    </div>
  );
}
