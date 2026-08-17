import { useState } from 'react';
import { X } from 'lucide-react';
import { changeOwnPassword } from '@/lib/userStore';

// "Change password" — rotates the signed-in user's own password on the server,
// which also emails them a confirmation that it changed. `hasPassword` is false
// for someone who has only ever signed in with Google: they're choosing a
// password for the first time, so there's no current one to confirm.
export default function ChangePasswordModal({ open, onClose, onSaved, hasPassword = true }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  const input = 'h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

  const ERRORS = {
    wrong_current_password: 'Your current password isn’t right.',
    weak_password: 'New password must be at least 8 characters.',
    unauthenticated: 'Your session expired — sign in again.',
    not_found: 'Your account is no longer on the roster.',
  };

  const save = async () => {
    if (busy) return;
    if (hasPassword && !current) return setError('Enter your current password.');
    if (next.length < 8) return setError('New password must be at least 8 characters.');
    if (next !== confirm) return setError('New passwords don’t match.');
    setError('');
    setBusy(true);
    const res = await changeOwnPassword(current, next);
    setBusy(false);
    if (!res.ok) {
      setError(ERRORS[res.error] || 'Could not change your password. Please try again.');
      return;
    }
    onSaved?.();
    setCurrent(''); setNext(''); setConfirm('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-lg overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex h-14 items-center justify-between border-b px-6">
          <h2 className="text-base font-semibold tracking-tight">Change password</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4 p-6">
          {hasPassword ? (
            <label className="grid grid-cols-[160px_1fr] items-center gap-4 text-sm">
              <span>Current password</span>
              <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" className={input} />
            </label>
          ) : (
            <p className="rounded-md border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
              You sign in with Google and don’t have a password yet. Setting one lets you sign in
              with your email address as well.
            </p>
          )}
          <label className="grid grid-cols-[160px_1fr] items-center gap-4 text-sm">
            <span>New password</span>
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" className={input} />
          </label>
          <label className="grid grid-cols-[160px_1fr] items-center gap-4 text-sm">
            <span>Confirm new password</span>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" className={input} />
          </label>
          {error && <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">Cancel</button>
          <button type="button" onClick={save} disabled={busy} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
