import { useState } from 'react';
import { X, Search, Check } from 'lucide-react';
import { useAllOrganisations } from '@/lib/organisations';
import { updateUser } from '@/lib/userStore';
import { cn } from '@/lib/utils';

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

// "Client access" — which client entities a colleague may open. This is the
// whole of a colleague's reach: they belong to no single entity, so without a
// client ticked here there is nothing for them to work on. Inside every client
// they're given they act as a Business Admin, which is why the list is the
// permission rather than a role being picked alongside it.
export default function ClientAccessModal({ open, colleague, onClose, onSaved }) {
  const { data: organisations = [], isLoading } = useAllOrganisations();
  const [q, setQ] = useState('');
  const [all, setAll] = useState(Boolean(colleague?.allClients));
  const [picked, setPicked] = useState(() => new Set(colleague?.clientAccess || []));
  const [saving, setSaving] = useState(false);

  if (!open || !colleague) return null;

  const filtered = organisations.filter((o) =>
    o.name.toLowerCase().includes(q.trim().toLowerCase())
  );
  const toggle = (id) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    // Nothing to save for an owner: the server restores both fields on load, so
    // writing them would only look like it had worked.
    if (colleague.accountOwner) return onClose();
    setSaving(true);
    try {
      await updateUser(colleague.id, { allClients: all, clientAccess: [...picked] });
      onSaved?.(all ? 'All clients' : `${picked.size} client${picked.size === 1 ? '' : 's'}`);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-6">
          <h2 className="truncate pr-4 text-base font-semibold tracking-tight">Client access for {colleague.name}</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          {/* An account owner's access is restored on every load, so narrowing
              it here would be undone a second later — and used to be, silently:
              you picked five clients, were told "updated — 5 clients", and the
              column still said All clients with nothing to say why. Better to
              not offer the choice than to take it and put it back. */}
          {colleague.accountOwner ? (
            <p className="mb-4 rounded-md border border-amber-600/30 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
              {colleague.name} is an <span className="font-medium">account owner</span>, so they work on every
              client — including ones added later — and that cannot be narrowed here. It is what stops the
              practice ever being left with nobody able to open a client. To change it, take them off
              OWNER_EMAILS (or off the practice&rsquo;s own seed) first.
            </p>
          ) : (
            <p className="mb-4 text-sm text-muted-foreground">
              {colleague.name} can open the clients ticked below, and is a Business Admin
              inside each one. Clients that aren&apos;t ticked stay out of reach — they
              don&apos;t appear in the organisation switcher at all.
            </p>
          )}

          <div className="mb-5 flex items-center justify-between rounded-lg border px-4 py-3">
            <div>
              <p className="text-sm font-medium">All clients</p>
              <p className="text-xs text-muted-foreground">
                Every client the practice has connected, including ones added later.
              </p>
            </div>
            <Toggle on={all} onToggle={() => setAll((v) => !v)} />
          </div>

          <div className={cn('transition-opacity', all && 'pointer-events-none opacity-40')}>
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search clients"
                className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            <div className="overflow-hidden rounded-lg border">
              <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2.5 text-sm font-medium text-muted-foreground">
                <span>Client</span>
                <span>{all ? 'All' : `${picked.size} selected`}</span>
              </div>
              <div className="max-h-72 overflow-auto">
                {filtered.map((o) => {
                  const on = all || picked.has(o.id);
                  return (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => toggle(o.id)}
                      className="flex w-full items-center gap-3 border-b px-4 py-3 text-left transition-colors last:border-0 hover:bg-muted/50"
                    >
                      <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', on && 'border-foreground bg-foreground text-background')}>
                        {on && <Check className="h-3 w-3" strokeWidth={3} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{o.name}</span>
                        {o.tenantName && o.tenantName !== o.name && (
                          <span className="block truncate text-xs text-muted-foreground">{o.tenantName}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
                {!filtered.length && (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                    {isLoading ? 'Loading clients…' : q ? `No clients match “${q}”.` : 'No clients connected yet.'}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-6 py-4">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">Cancel</button>
          <button type="button" onClick={save} disabled={saving} className="inline-flex h-9 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
            {saving ? 'Saving…' : colleague.accountOwner ? 'Close' : 'Save access'}
          </button>
        </div>
      </div>
    </div>
  );
}
