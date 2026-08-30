import { useState } from 'react';
import { X, ChevronDown, HelpCircle, Check, Search } from 'lucide-react';
import { PRACTICE_ROLES, PRACTICE_ROLE_INFO } from '@/lib/practiceStore';
import { useAllOrganisations } from '@/lib/organisations';
import { mobileError, MOBILE_HINT } from '@/lib/mobile';
import { cn } from '@/lib/utils';

const EMPTY = {
  firstName: '',
  lastName: '',
  email: '',
  login: true,
  practiceRole: 'Standard',
  mobile: '',
  allClients: false,
  clientAccess: [],
  privileges: { accessAll: false, createClaims: false, canPublish: false },
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

// Four-step "Add a colleague" dialog — Details → Role → Client access → Review.
// Client access is a step of its own because it is the whole of what a colleague
// can reach: unlike a client's employee, they belong to no entity, so a
// colleague added without a client has nothing to open.
export default function AddColleagueModal({ open, practiceName, onClose, onAdd }) {
  const [step, setStep] = useState('details');
  const [form, setForm] = useState(EMPTY);
  const [q, setQ] = useState('');
  const { data: organisations = [] } = useAllOrganisations();
  if (!open) return null;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const close = () => { setStep('details'); setForm(EMPTY); setQ(''); onClose(); };

  const emailValid = !form.login || /.+@.+\..+/.test(form.email.trim());
  // A mobile number is asked for, not demanded: it is how a bill they send in
  // over WhatsApp is matched back to them, but plenty of people are added who
  // will never send one in, and a number can be filled in later. A number that
  // IS typed still has to be usable.
  const mobileMsg = mobileError(form.mobile);
  const canNext = form.firstName.trim() && form.lastName.trim() && emailValid && !mobileMsg;

  const toggleClient = (id) =>
    setForm((f) => ({
      ...f,
      clientAccess: f.clientAccess.includes(id)
        ? f.clientAccess.filter((x) => x !== id)
        : [...f.clientAccess, id],
    }));

  const filtered = organisations.filter((o) => o.name.toLowerCase().includes(q.trim().toLowerCase()));
  const accessCount = form.allClients ? organisations.length : form.clientAccess.length;

  // Invite (notify) only when they have login access + an email.
  const commit = () => {
    const { login, ...rest } = form;
    onAdd({ ...rest, login: login ? 'Yes' : 'No', email: login ? form.email.trim() : '' }, login);
    close();
  };

  const input = 'h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const TITLES = {
    details: 'Details',
    role: 'Role in the practice',
    access: 'Client access',
    review: 'Review and add',
  };

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
              <p className="text-sm text-muted-foreground">
                A colleague is part of {practiceName || 'the practice'} — not an employee of one
                client. You&apos;ll choose which clients they work on next.
              </p>
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
              {form.login ? (
                <label className="grid grid-cols-[140px_1fr] items-center gap-4 text-sm">
                  <span>Email <span className="text-destructive">*</span></span>
                  <input value={form.email} onChange={(e) => set('email', e.target.value)} type="email" className={input} />
                </label>
              ) : (
                <p className="rounded-md border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
                  Without login access this colleague can’t sign in — no email is required.
                </p>
              )}
              <label className="grid grid-cols-[140px_1fr] items-start gap-4 text-sm">
                <span className="pt-2">Mobile</span>
                <div>
                  <input
                    value={form.mobile}
                    onChange={(e) => set('mobile', e.target.value)}
                    placeholder="60123456789"
                    className={input}
                  />
                  <p className={cn('mt-1 text-xs', mobileMsg ? 'text-destructive' : 'text-muted-foreground')}>
                    {mobileMsg || MOBILE_HINT}
                  </p>
                </div>
              </label>
            </div>
          )}

          {step === 'role' && (
            <div className="space-y-5 p-6">
              <label className="grid grid-cols-[140px_1fr] items-center gap-4 text-sm">
                <span>Role</span>
                <div className="relative">
                  <select value={form.practiceRole} onChange={(e) => set('practiceRole', e.target.value)} className="h-10 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {PRACTICE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                </div>
              </label>
              <div className="text-sm">
                <p className="font-medium">{form.practiceRole} colleagues can:</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                  {(PRACTICE_ROLE_INFO[form.practiceRole] || []).map((line) => <li key={line}>{line}</li>)}
                </ul>
              </div>
            </div>
          )}

          {step === 'access' && (
            <div className="space-y-4 p-6">
              <div className="flex items-center justify-between rounded-lg border px-4 py-3">
                <div>
                  <p className="text-sm font-medium">All clients</p>
                  <p className="text-xs text-muted-foreground">Including clients connected later.</p>
                </div>
                <Toggle on={form.allClients} onToggle={() => set('allClients', !form.allClients)} />
              </div>
              <div className={cn('transition-opacity', form.allClients && 'pointer-events-none opacity-40')}>
                <div className="relative mb-3">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clients" className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
                </div>
                <div className="max-h-64 overflow-auto rounded-lg border">
                  {filtered.map((o) => {
                    const on = form.allClients || form.clientAccess.includes(o.id);
                    return (
                      <button key={o.id} type="button" onClick={() => toggleClient(o.id)} className="flex w-full items-center gap-3 border-b px-4 py-2.5 text-left transition-colors last:border-0 hover:bg-muted/50">
                        <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', on && 'border-foreground bg-foreground text-background')}>
                          {on && <Check className="h-3 w-3" strokeWidth={3} />}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm">{o.name}</span>
                      </button>
                    );
                  })}
                  {!filtered.length && (
                    <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                      {q ? `No clients match “${q}”.` : 'No clients connected yet.'}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {step === 'review' && (
            <div className="space-y-4 p-6 text-sm">
              <dl className="space-y-3">
                {[
                  ['Name', `${form.firstName} ${form.lastName}`.trim()],
                  ['Email', form.login ? form.email : 'No login access'],
                  ['Practice role', form.practiceRole],
                  ['Client access', form.allClients ? 'All clients' : accessCount ? `${accessCount} client${accessCount === 1 ? '' : 's'}` : 'No clients yet'],
                ].map(([label, value]) => (
                  <div key={label} className="grid grid-cols-[140px_1fr] gap-4">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="font-medium">{value || '—'}</dd>
                  </div>
                ))}
              </dl>
              {!form.allClients && !accessCount && (
                <p className="rounded-md border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
                  With no client access there is nothing for them to open yet. You can grant it
                  any time from Manage → Client access.
                </p>
              )}
              {form.login && (
                <p className="rounded-md border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
                  An invitation will be emailed to {form.email} so they can set their own password.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t px-6 py-4">
          <button
            type="button"
            onClick={step === 'details' ? close : () => setStep({ role: 'details', access: 'role', review: 'access' }[step])}
            className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted"
          >
            {step === 'details' ? 'Cancel' : 'Back'}
          </button>
          {step === 'review' ? (
            <button type="button" onClick={commit} className="inline-flex h-9 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
              Add colleague
            </button>
          ) : (
            <button
              type="button"
              disabled={step === 'details' && !canNext}
              onClick={() => setStep({ details: 'role', role: 'access', access: 'review' }[step])}
              className="inline-flex h-9 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
