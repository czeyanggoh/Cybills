import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronDown, KeyRound, Loader2, Lock, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import AppShell from '@/components/AppShell';
import CostsSubnav from '@/components/CostsSubnav';
import { getDirectory, USERS_EVENT } from '@/lib/userStore';
import {
  usePortalLogins,
  isActiveRun,
  savePortalLogin,
  updatePortalLogin,
  deletePortalLogin,
  runPortalLogin,
  runAllPortalLogins,
} from '@/lib/retrieve';
import {
  DEFAULT_SCHEDULE,
  SCHEDULE_DAYS,
  SCHEDULE_HOURS,
  dayKeyLabel,
  hourLabel,
  normaliseSchedule,
  ordinal,
  scheduleLabel,
} from '@/lib/retrieveSchedule';
import { cn } from '@/lib/utils';

// Costs -> Retrieve: the supplier portals CYBills signs into for the invoices
// nobody sends — SP Group's utility bills are the first. Each login is kept on
// the server with its password sealed; Retrieve hands it to n8n, which signs in
// and downloads, and what comes back lands in the Costs inbox and is read like
// any upload. See server/src/retrieve.ts.

const inputCls =
  'h-10 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring';

const when = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-SG', { dateStyle: 'medium', timeStyle: 'short' });
};

// The people a login's documents can be filed under: the entity's own people
// and its general account, as the Costs owner picker offers them.
function useOwnerChoices() {
  const read = () => getDirectory().filter((p) => !p.external && !p.deactivated);
  const [people, setPeople] = useState(read);
  useEffect(() => {
    const sync = () => setPeople(read());
    sync();
    window.addEventListener(USERS_EVENT, sync);
    return () => window.removeEventListener(USERS_EVENT, sync);
  }, []);
  return people;
}

function RunStatus({ login }) {
  const run = login.run;
  if (!run) return <span className="text-xs text-muted-foreground">Not retrieved yet</span>;
  if (run.status === 'queued') return <span className="text-xs text-muted-foreground">Waiting its turn…</span>;
  if (run.status === 'running') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Signing in and retrieving… (started {when(run.startedAt)})
      </span>
    );
  }
  return (
    <div className="space-y-1 text-xs">
      <div className={cn(run.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
        {run.status === 'failed' ? 'Failed' : 'Last retrieved'} {when(run.endedAt || run.startedAt)}
        {run.scheduled ? ' (on schedule)' : ''} — {run.note}
      </div>
      {run.filed?.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {run.filed.map((f) => (
            <Link key={f.billId} to={`/costs/${f.displayId || f.billId}`} className="font-medium text-foreground hover:underline">
              {f.fileName || f.displayId}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// Where a login's schedule is read on its card: when it retrieves by itself and
// the day it next will.
function ScheduleLine({ login, timezone }) {
  const s = normaliseSchedule(login.schedule);
  if (s.frequency === 'off') {
    return <span>Retrieves only when somebody presses Retrieve now</span>;
  }
  return (
    <span>
      Retrieves {scheduleLabel(s).replace(/^\w/, (c) => c.toLowerCase())}
      {timezone ? ` (${timezone})` : ''}
      {login.nextScheduledDay ? ` · next ${dayKeyLabel(login.nextScheduledDay)}` : ''}
      {!login.hasPassword ? ' · paused until a password is saved' : ''}
    </span>
  );
}

const selectCls = cn(inputCls, 'appearance-none pr-9');
function Select({ value, onChange, children, label }) {
  return (
    <div className="relative">
      <select value={value} onChange={(e) => onChange(e.target.value)} className={selectCls} aria-label={label}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

function LoginModal({ open, login, portals, owners, timezone, onClose, onSaved }) {
  const editing = Boolean(login);
  const [portal, setPortal] = useState('');
  const [label, setLabel] = useState('');
  const [loginUrl, setLoginUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [accountRef, setAccountRef] = useState('');
  const [owner, setOwner] = useState('');
  const [schedule, setSchedule] = useState(DEFAULT_SCHEDULE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setPortal(login?.portal || portals[0]?.id || '');
    setLabel(login?.label || '');
    setLoginUrl(login?.loginUrl || '');
    setUsername(login?.username || '');
    setPassword('');
    setAccountRef(login?.accountRef || '');
    setOwner(login?.owner || '');
    setSchedule(normaliseSchedule(login?.schedule));
    setError('');
    setBusy(false);
  }, [open, login, portals]);

  if (!open) return null;
  const spec = portals.find((p) => p.id === portal);
  const canSave = Boolean(portal && username.trim() && (editing || password) && (portal !== 'other' || loginUrl.trim()));

  const save = async () => {
    if (!canSave || busy) return;
    setBusy(true);
    setError('');
    try {
      const fields = { label, loginUrl, username, accountRef, owner, schedule };
      // Blank on an edit keeps the saved one — it is never shown, so the form
      // has nothing to send back.
      if (password) fields.password = password;
      const out = editing ? await updatePortalLogin(login.id, fields) : await savePortalLogin({ ...fields, portal });
      setPassword('');
      onSaved(out.login);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-background shadow-xl">
        <div className="flex h-14 items-center justify-between border-b px-6">
          <h2 className="text-base font-semibold tracking-tight">{editing ? 'Edit portal login' : 'Add portal login'}</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form
          className="space-y-4 p-6"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          {!editing && (
            <div className="space-y-2">
              <div className="text-sm text-muted-foreground">Portal</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {portals.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPortal(p.id)}
                    className={cn(
                      'rounded-md border p-3 text-left text-sm transition-colors',
                      portal === p.id ? 'border-foreground bg-muted' : 'hover:bg-muted'
                    )}
                  >
                    <div className="font-medium">{p.name}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{p.description}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <label className="block space-y-1.5 text-sm">
            <span className="text-muted-foreground">Name</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={spec?.name || 'e.g. SP Group — Main office'} className={inputCls} />
          </label>

          {portal === 'other' && (
            <label className="block space-y-1.5 text-sm">
              <span className="text-muted-foreground">Sign-in page <span className="text-destructive">*</span></span>
              <input value={loginUrl} onChange={(e) => setLoginUrl(e.target.value)} placeholder="https://" className={inputCls} />
            </label>
          )}

          <label className="block space-y-1.5 text-sm">
            <span className="text-muted-foreground">{spec?.usernameLabel || 'Username'} <span className="text-destructive">*</span></span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              autoFocus={editing}
              className={inputCls}
            />
          </label>

          <label className="block space-y-1.5 text-sm">
            <span className="text-muted-foreground">Password {!editing && <span className="text-destructive">*</span>}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              // Not the person's own password for CYBills: keep the browser
              // from offering it here, or from saving this one as theirs.
              autoComplete="new-password"
              placeholder={editing ? 'Leave blank to keep the saved password' : ''}
              className={inputCls}
            />
          </label>

          <label className="block space-y-1.5 text-sm">
            <span className="text-muted-foreground">Account number</span>
            <input
              value={accountRef}
              onChange={(e) => setAccountRef(e.target.value)}
              placeholder="Optional — only this account, where the login holds several"
              className={inputCls}
            />
          </label>

          <label className="block space-y-1.5 text-sm">
            <span className="text-muted-foreground">File documents under</span>
            <div className="relative">
              <select value={owner} onChange={(e) => setOwner(e.target.value)} className={cn(inputCls, 'appearance-none pr-9')}>
                <option value="">General account</option>
                {owners
                  .filter((p) => !p.general)
                  .map((p) => (
                    <option key={p.email} value={p.email}>
                      {p.name || p.email}
                    </option>
                  ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            </div>
          </label>

          <div className="space-y-1.5 text-sm">
            <div className="text-muted-foreground">Retrieve automatically</div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Select
                label="How often"
                value={schedule.frequency}
                onChange={(frequency) => setSchedule((s) => ({ ...s, frequency }))}
              >
                <option value="off">Off</option>
                <option value="daily">Every day</option>
                <option value="monthly">Once a month</option>
              </Select>
              {schedule.frequency === 'monthly' && (
                <Select label="Day of the month" value={schedule.day} onChange={(day) => setSchedule((s) => ({ ...s, day: Number(day) }))}>
                  {SCHEDULE_DAYS.map((d) => (
                    <option key={d} value={d}>
                      on the {ordinal(d)}
                    </option>
                  ))}
                </Select>
              )}
              {schedule.frequency !== 'off' && (
                <Select label="Hour" value={schedule.hour} onChange={(hour) => setSchedule((s) => ({ ...s, hour: Number(hour) }))}>
                  {SCHEDULE_HOURS.map((h) => (
                    <option key={h} value={h}>
                      at {hourLabel(h)}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            {schedule.frequency !== 'off' && (
              <p className="text-xs text-muted-foreground">
                {schedule.frequency === 'monthly' && schedule.day > 28 ? 'A month without that day runs on its last day. ' : ''}
                Times are {timezone || 'the practice’s'} time. A run that fails is not retried until the next one — the
                reason shows on the login.
              </p>
            )}
          </div>

          <p className="flex gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            The password is encrypted on the server and is never shown again, here or anywhere else. It is only sent to
            CYBM’s n8n workflow, to sign in when you retrieve.
          </p>

          {error && <p className="text-sm text-destructive">{error}</p>}
          <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
        </form>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!canSave || busy}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {editing ? 'Save' : 'Add login'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Retrieve() {
  const [state, reload] = usePortalLogins();
  const owners = useOwnerChoices();
  const [modal, setModal] = useState({ open: false, login: null });
  const [error, setError] = useState('');
  const { logins, portals, enabled, timezone, loading } = state;
  const busyAll = logins.some((l) => isActiveRun(l.run));

  const run = async (id) => {
    setError('');
    try {
      await runPortalLogin(id);
    } catch (err) {
      setError(err.message);
    }
    reload();
  };
  const runAll = async () => {
    setError('');
    try {
      await runAllPortalLogins();
    } catch (err) {
      setError(err.message);
    }
    reload();
  };
  const remove = async (login) => {
    if (!window.confirm(`Delete the ${login.label} login? The saved password is deleted with it. Documents it already retrieved stay in Costs.`)) return;
    setError('');
    try {
      await deletePortalLogin(login.id);
    } catch (err) {
      setError(err.message);
    }
    reload();
  };

  return (
    <AppShell subnav={<CostsSubnav />}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">Retrieve</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={runAll}
            disabled={!enabled || !logins.length || busyAll}
            className="inline-flex h-9 items-center gap-2 rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={cn('h-4 w-4', busyAll && 'animate-spin')} />
            Retrieve all
          </button>
          <button
            type="button"
            onClick={() => setModal({ open: true, login: null })}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Add login
          </button>
        </div>
      </div>

      <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
        Some suppliers never send the bill — it waits on their portal. Save the login here and CYBills signs in, downloads
        the invoices and files them into the Costs inbox, where they are read like any upload. An invoice already
        retrieved is never filed twice. Give a login a schedule and it does this by itself — every day, or once a month.
      </p>

      {!loading && !enabled && (
        <div className="mb-4 flex max-w-2xl gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          Retrieval isn’t switched on for this server yet (no n8n workflow is configured). Logins can be saved now and will
          be used once it is.
        </div>
      )}
      {(error || state.error) && <p className="mb-4 text-sm text-destructive">{error || state.error}</p>}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : !logins.length ? (
        <div className="max-w-2xl rounded-lg border border-dashed p-8 text-center">
          <KeyRound className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No portal logins yet</p>
          <p className="mt-1 text-sm text-muted-foreground">Add the SP Group login this entity’s utility bills are under.</p>
          <button
            type="button"
            onClick={() => setModal({ open: true, login: null })}
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Add login
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {logins.map((l) => {
            const active = isActiveRun(l.run);
            return (
              <div key={l.id} className="rounded-lg border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">{l.label}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {l.portalName} · {l.username}
                      {l.accountRef ? ` · account ${l.accountRef}` : ''} · files under {l.ownerName || 'General'}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {l.hasPassword ? `Password saved ${when(l.passwordSetAt)}` : 'No password saved'}
                      {l.filedCount ? ` · ${l.filedCount} document${l.filedCount === 1 ? '' : 's'} retrieved so far` : ''}
                      {l.lastInvoiceDate ? ` · next fetches invoices after ${dayKeyLabel(l.lastInvoiceDate)}` : ''}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      <ScheduleLine login={l} timezone={timezone} />
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => run(l.id)}
                      disabled={!enabled || active || !l.hasPassword}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
                    >
                      <RefreshCw className={cn('h-3.5 w-3.5', active && 'animate-spin')} /> Retrieve now
                    </button>
                    <button
                      type="button"
                      onClick={() => setModal({ open: true, login: l })}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      aria-label={`Edit ${l.label}`}
                      title="Edit"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(l)}
                      disabled={active}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-50"
                      aria-label={`Delete ${l.label}`}
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="mt-3 border-t pt-3">
                  <RunStatus login={l} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <LoginModal
        open={modal.open}
        login={modal.login}
        portals={portals}
        owners={owners}
        timezone={timezone}
        onClose={() => setModal({ open: false, login: null })}
        onSaved={() => reload()}
      />
    </AppShell>
  );
}
