import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { fetchAutoClaims, saveAutoClaims, FREQUENCIES, EMPTY_AUTO_CLAIMS } from '@/lib/autoClaims';
import { formatClaimDate } from '@/lib/claimStore';
import { cn } from '@/lib/utils';

// Manage Auto Expense claims — Dext's dialog: when the current claims period
// ends, how often it repeats, whether items still in the inbox come along, and
// which people are on the schedule. The claims themselves are filed server-side
// the day after a period ends.

// How far the claims-end date moves each time a period is filed, in words.
const NEXT_IN = { weekly: 'a week', fortnightly: 'a fortnight', monthly: 'a month' };

function Toggle({ on, onToggle, label }) {
  return (
    <button type="button" onClick={onToggle} className="flex items-center gap-2" aria-pressed={on} aria-label={label}>
      <span className={cn('flex h-5 w-9 items-center rounded-full p-0.5 transition-colors', on ? 'justify-end bg-foreground' : 'justify-start border')}>
        <span className={cn('h-4 w-4 rounded-full', on ? 'bg-background' : 'bg-muted-foreground/50')} />
      </span>
      <span className="text-sm text-muted-foreground">{on ? 'Yes' : 'No'}</span>
    </button>
  );
}

export default function AutoClaimsModal({ open, onClose }) {
  const [settings, setSettings] = useState(EMPTY_AUTO_CLAIMS);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Load fresh every time it opens: the end date rolls forward on its own as
  // periods are filed, so a stale draft would show a date that has already gone.
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setLoading(true);
    setError('');
    fetchAutoClaims().then((r) => {
      if (!alive) return;
      setSettings(r.settings);
      setUsers(r.users);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [open]);

  if (!open) return null;

  const set = (patch) => setSettings((s) => ({ ...s, ...patch }));
  const enabled = new Set(settings.userIds || []);
  const toggleUser = (id) => {
    const next = new Set(enabled);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ userIds: [...next] });
  };

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      await saveAutoClaims(settings);
      onClose();
    } catch (err) {
      setError(err?.code === 'forbidden' ? 'Only a Business Admin can change this.' : 'Could not save the schedule.');
    } finally {
      setSaving(false);
    }
  };

  const onCount = (settings.userIds || []).filter((id) => users.some((u) => u.id === id)).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col rounded-lg border bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="text-base font-semibold tracking-tight">Manage Auto Expense claims</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <label className="flex items-center justify-between gap-4 text-sm">
            <span className="font-medium">Current claims end</span>
            <input
              type="date"
              value={settings.endDate || ''}
              onChange={(e) => set({ endDate: e.target.value })}
              className="h-9 w-56 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="flex items-center justify-end gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(settings.endOfMonth)}
              onChange={(e) => set({ endOfMonth: e.target.checked })}
              className="h-4 w-4 accent-black"
            />
            <span className="w-[13.5rem]">End of month</span>
          </label>

          <label className="flex items-center justify-between gap-4 text-sm">
            <span className="font-medium">Frequency</span>
            <select
              value={settings.frequency}
              onChange={(e) => set({ frequency: e.target.value })}
              className="h-9 w-56 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </label>

          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="font-medium">Include inbox items</span>
            <div className="w-56">
              <Toggle
                on={Boolean(settings.includeInbox)}
                onToggle={() => set({ includeInbox: !settings.includeInbox })}
                label="Include inbox items"
              />
            </div>
          </div>

          {/* What the schedule will actually do, in words — the dates alone don't say it. */}
          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            The day after {settings.endDate ? formatClaimDate(settings.endDate) : 'the end date'}, everyone switched on
            below gets an expense claim holding their{' '}
            {settings.includeInbox ? 'inbox and Ready' : 'Ready'} cost documents dated on or before it. The end date
            then moves on {NEXT_IN[settings.frequency] || 'a period'}
            {settings.endOfMonth ? ', staying on the last day of the month' : ''}. Claims are never created empty.
          </p>

          <div className="overflow-hidden rounded-md border">
            <div className="border-b bg-muted/40 px-3 py-2 text-sm font-medium">Users</div>
            <div className="max-h-64 overflow-y-auto">
              {loading && <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading…</p>}
              {!loading && users.length === 0 && (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No one on this entity’s roster yet — add them under Users. Practice colleagues aren’t listed: an
                  expense claim belongs to the entity’s own people.
                </p>
              )}
              {users.map((u) => (
                <div key={u.id} className="flex items-center justify-between gap-3 border-b px-3 py-2.5 last:border-0">
                  <span className="min-w-0 truncate text-sm">
                    {u.name || u.email}
                    {u.name && u.email && <span className="ml-2 text-xs text-muted-foreground">{u.email}</span>}
                  </span>
                  <Toggle on={enabled.has(u.id)} onToggle={() => toggleUser(u.id)} label={u.name || u.email} />
                </div>
              ))}
            </div>
          </div>
          <p className="text-center text-xs text-muted-foreground">
            {onCount} of {users.length} {users.length === 1 ? 'person' : 'people'} on the schedule
          </p>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t px-5 py-4">
          <button type="button" onClick={onClose} className="rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || loading}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
