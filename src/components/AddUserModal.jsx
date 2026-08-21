import { useState } from 'react';
import { X, ChevronDown, HelpCircle } from 'lucide-react';
import { ROLES, ROLE_INFO } from '@/lib/userStore';
import { useOrganisations, getActiveOrganisationId } from '@/lib/organisations';
import { cn } from '@/lib/utils';

const EMPTY = {
  firstName: '',
  lastName: '',
  email: '',
  login: false,
  role: 'Standard',
  mobile: '',
  privileges: { accessAll: false, createClaims: false, canPublish: false },
  sendText: false,
};

function Toggle({ on, onToggle }) {
  return (
    <button type="button" onClick={onToggle} className="flex items-center gap-2">
      <span className={cn('flex h-5 w-9 items-center rounded-full p-0.5 transition-colors', on ? 'justify-end bg-foreground' : 'justify-start border')}>
        <span className={cn('h-4 w-4 rounded-full', on ? 'bg-background' : 'bg-muted-foreground/50')} />
      </span>
      <span className="text-sm text-muted-foreground">{on ? 'Yes' : 'No'}</span>
    </button>
  );
}

// Three-step "Add a user" dialog — Details → Role → Review & invite, mirroring
// Dext. Email is only requested when the user is granted login access; without
// it they can't sign in and are simply added to the account.
export default function AddUserModal({ open, onClose, onAdd }) {
  const [step, setStep] = useState('details');
  const [form, setForm] = useState(EMPTY);
  const { data: organisations = [] } = useOrganisations();
  if (!open) return null;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setPriv = (k, v) => setForm((f) => ({ ...f, privileges: { ...f.privileges, [k]: v } }));
  const close = () => { setStep('details'); setForm(EMPTY); onClose(); };

  const activeOrg = organisations.find((o) => o.id === getActiveOrganisationId()) || organisations[0];
  const orgName = activeOrg?.name || '';

  const emailValid = !form.login || /.+@.+\..+/.test(form.email.trim());
  const canNext = form.firstName.trim() && form.lastName.trim() && emailValid;
  const isStandard = form.role === 'Standard';

  // Invite (notify) only when they have login access + an email; pass the active
  // org name so the invite email names the right organisation. The server files
  // the new user under that same organisation — rosters are per-tenant.
  const commit = () => { onAdd(form, form.login, '', orgName); close(); };

  const input = 'h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const TITLES = { details: 'Details', role: 'Role', review: 'Review and add' };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={close} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">{TITLES[step]}</h2>
          <button type="button" onClick={close} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {step === 'details' && (
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
                <span className="flex items-center gap-1">Login access <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" /></span>
                <Toggle on={form.login} onToggle={() => set('login', !form.login)} />
              </div>
              {/* Email is only needed when the user can log in. */}
              {form.login ? (
                <label className="grid grid-cols-[140px_1fr] items-center gap-4 text-sm">
                  <span>Email <span className="text-destructive">*</span></span>
                  <input value={form.email} onChange={(e) => set('email', e.target.value)} type="email" className={input} />
                </label>
              ) : (
                <p className="rounded-md border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
                  Without login access this user can’t sign in — no email is required. They can be
                  granted access via invitation later.
                </p>
              )}
            </div>
          )}

          {step === 'role' && (
            <div className="space-y-5 p-6">
              <label className="grid grid-cols-[140px_1fr] items-center gap-4 text-sm">
                <span>Role</span>
                <div className="relative">
                  <select value={form.role} onChange={(e) => set('role', e.target.value)} className="h-10 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                </div>
              </label>

              <div className="text-sm">
                <p className="font-medium">{form.role} users can:</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                  {(ROLE_INFO[form.role] || []).map((line) => <li key={line}>{line}</li>)}
                </ul>
              </div>

              {isStandard && (
                <div className="space-y-4">
                  <p className="text-sm font-medium">and optionally:</p>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1 text-sm">Access all documents <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" /></span>
                    <Toggle on={form.privileges.accessAll} onToggle={() => setPriv('accessAll', !form.privileges.accessAll)} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Create expense claims</span>
                    <Toggle on={form.privileges.createClaims} onToggle={() => setPriv('createClaims', !form.privileges.createClaims)} />
                  </div>
                  <div>
                    <p className="mb-2 text-sm font-medium">Publishing permissions</p>
                    <label className="mb-2 flex items-center gap-2 text-sm">
                      <input type="radio" name="pub" checked={!form.privileges.canPublish} onChange={() => setPriv('canPublish', false)} className="accent-black" />
                      Can’t publish to accounting software
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="radio" name="pub" checked={form.privileges.canPublish} onChange={() => setPriv('canPublish', true)} className="accent-black" />
                      Can publish items and expense claims to an accounting software
                    </label>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 'review' && (
            <div className="space-y-4 p-6 text-sm">
              <p>
                You are adding a user to{' '}
                <span className="font-medium">{orgName || 'this organisation'}</span> with the
                following details:
              </p>
              <div className="pl-4">
                <p><span className="font-medium">First name:</span> {form.firstName}</p>
                <p><span className="font-medium">Last name:</span> {form.lastName}</p>
                {form.login && <p><span className="font-medium">Email:</span> {form.email}</p>}
              </div>
              <p>The user will have access to your account with the following permissions:</p>
              <p className="pl-4"><span className="font-medium">Role:</span> {form.role}</p>
              {form.login ? (
                <p className="text-muted-foreground">
                  They&apos;ll get access straight away — they can sign in with {form.email}.
                </p>
              ) : (
                <p className="text-muted-foreground">This user is added without login access.</p>
              )}
              <div className="flex items-center justify-between border-t pt-4">
                <span className="text-sm">Add a mobile number</span>
                <Toggle on={form.sendText} onToggle={() => set('sendText', !form.sendText)} />
              </div>
              {form.sendText && (
                <label className="grid grid-cols-[140px_1fr] items-center gap-4">
                  <span>Mobile number</span>
                  <input value={form.mobile} onChange={(e) => set('mobile', e.target.value)} placeholder="+65…" className={input} />
                </label>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          {step !== 'details' && (
            <button type="button" onClick={() => setStep(step === 'review' ? 'role' : 'details')} className="mr-auto inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
              Back
            </button>
          )}
          <button type="button" onClick={close} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
            Cancel
          </button>
          {step === 'details' && (
            <button type="button" disabled={!canNext} onClick={() => setStep('role')} className={cn('inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90', !canNext && 'opacity-50')}>
              Next
            </button>
          )}
          {step === 'role' && (
            <button type="button" onClick={() => setStep('review')} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
              Next
            </button>
          )}
          {step === 'review' && (
            <button type="button" onClick={commit} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
              Add
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
