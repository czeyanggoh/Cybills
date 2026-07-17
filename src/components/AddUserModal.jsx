import { useState } from 'react';
import { X, ChevronDown, HelpCircle } from 'lucide-react';
import { ROLES } from '@/lib/userStore';
import { cn } from '@/lib/utils';

const EMPTY = { firstName: '', lastName: '', email: '', login: false, role: 'Standard' };

// Two-step "Add a user" dialog: details → role, mirroring Dext.
export default function AddUserModal({ open, onClose, onAdd }) {
  const [step, setStep] = useState('details');
  const [form, setForm] = useState(EMPTY);

  if (!open) return null;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const close = () => {
    setStep('details');
    setForm(EMPTY);
    onClose();
  };
  const canNext = form.firstName.trim() && form.lastName.trim();
  const commit = () => {
    onAdd(form);
    close();
  };

  const input = 'h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={close} aria-hidden="true" />
      <div className="relative w-full max-w-lg overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">
            {step === 'details' ? 'Details' : 'Role & access'}
          </h2>
          <button type="button" onClick={close} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {step === 'details' ? (
          <div className="space-y-5 p-6">
            <label className="grid grid-cols-[140px_1fr] items-center gap-4 text-sm">
              <span>First name <span className="text-destructive">*</span></span>
              <input value={form.firstName} onChange={(e) => set('firstName', e.target.value)} className={input} />
            </label>
            <label className="grid grid-cols-[140px_1fr] items-center gap-4 text-sm">
              <span>Last name <span className="text-destructive">*</span></span>
              <input value={form.lastName} onChange={(e) => set('lastName', e.target.value)} className={input} />
            </label>
            <div className="grid grid-cols-[140px_1fr] items-center gap-4 text-sm">
              <span className="flex items-center gap-1">
                Login access <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />
              </span>
              <button
                type="button"
                onClick={() => set('login', !form.login)}
                className="flex items-center gap-2"
              >
                <span className={cn('flex h-5 w-9 items-center rounded-full p-0.5 transition-colors', form.login ? 'bg-foreground' : 'border')}>
                  <span className={cn('h-4 w-4 rounded-full transition-transform', form.login ? 'translate-x-4 bg-background' : 'bg-muted-foreground/50')} />
                </span>
                <span className="text-muted-foreground">{form.login ? 'Yes' : 'No'}</span>
              </button>
            </div>
            <label className="grid grid-cols-[140px_1fr] items-center gap-4 text-sm">
              <span>Email</span>
              <input value={form.email} onChange={(e) => set('email', e.target.value)} type="email" className={input} />
            </label>
          </div>
        ) : (
          <div className="space-y-5 p-6">
            <label className="grid grid-cols-[140px_1fr] items-center gap-4 text-sm">
              <span>Role</span>
              <div className="relative">
                <select
                  value={form.role}
                  onChange={(e) => set('role', e.target.value)}
                  className="h-10 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </label>
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {form.firstName} {form.lastName} will be added as a {form.role} user
              {form.login ? ' with login access' : ' without login access'}.
            </p>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          {step === 'role' && (
            <button type="button" onClick={() => setStep('details')} className="mr-auto inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
              Back
            </button>
          )}
          <button type="button" onClick={close} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
            Cancel
          </button>
          {step === 'details' ? (
            <button
              type="button"
              disabled={!canNext}
              onClick={() => setStep('role')}
              className={cn('inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90', !canNext && 'opacity-50')}
            >
              Next
            </button>
          ) : (
            <button type="button" onClick={commit} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
              Add
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
