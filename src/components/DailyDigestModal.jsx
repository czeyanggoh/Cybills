import { useEffect, useRef, useState } from 'react';
import { X, Check, Mail } from 'lucide-react';
import { useDigest, useDigestRefresh, saveDigest, sendDigestNow } from '@/lib/digestStore';
import { hourLabel } from '@/lib/digest';
import { cn } from '@/lib/utils';

function Toggle({ on, onToggle, label }) {
  return (
    <button type="button" onClick={onToggle} className="flex items-center gap-2" aria-pressed={on} aria-label={label}>
      <span className={cn('flex h-5 w-9 items-center rounded-full p-0.5 transition-colors', on ? 'justify-end bg-foreground' : 'justify-start border')}>
        <span className={cn('h-4 w-4 rounded-full', on ? 'bg-background' : 'bg-muted-foreground/50')} />
      </span>
      <span className="text-sm text-muted-foreground">{on ? 'On' : 'Off'}</span>
    </button>
  );
}

const Box = ({ on }) => (
  <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', on && 'border-foreground bg-foreground text-background')}>
    {on && <Check className="h-3 w-3" strokeWidth={3} />}
  </span>
);

// "Daily digest" — once a day, email this colleague the paperwork their clients
// have sent in that is still waiting to be paid. Per client, it can be narrowed
// to the people they look after there: a document counts as somebody's when
// they own it, uploaded it, or emailed it in.
export default function DailyDigestModal({ open, colleague, onClose, onSaved }) {
  const { data, isLoading, error } = useDigest(open ? colleague?.id : null);
  const refresh = useDigestRefresh();
  const [enabled, setEnabled] = useState(false);
  const [hour, setHour] = useState(8);
  const [unpaidOnly, setUnpaidOnly] = useState(true);
  const [picked, setPicked] = useState({}); // orgId -> addresses[]
  const [typed, setTyped] = useState({}); // orgId -> text being typed
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  // Seeded ONCE per opening. The query refetches on its own (window focus, the
  // refresh after a send), and re-seeding then would throw away whatever has
  // been ticked but not yet saved.
  const seeded = useRef(false);
  useEffect(() => {
    if (!data?.digest || seeded.current) return;
    seeded.current = true;
    setEnabled(Boolean(data.digest.enabled));
    setHour(data.digest.hour ?? 8);
    setUnpaidOnly(data.digest.unpaidOnly !== false);
    setPicked(Object.fromEntries((data.digest.clients || []).map((c) => [c.orgId, c.addresses || []])));
  }, [data]);

  if (!open || !colleague) return null;

  const clients = data?.clients || [];
  const hours = data?.hours || [8];
  const last = data?.digest?.lastResult;

  // Ticking the first client IS asking for the digest: with the switch left at
  // its default Off, Save quietly saved a digest that would never be sent.
  const toggleClient = (id) => {
    if (!picked[id] && !Object.keys(picked).length) setEnabled(true);
    setPicked((p) => {
      const next = { ...p };
      if (next[id]) delete next[id];
      else next[id] = [];
      return next;
    });
  };
  const toggleAddress = (id, email) =>
    setPicked((p) => {
      const list = p[id] || [];
      const e = email.toLowerCase();
      return { ...p, [id]: list.includes(e) ? list.filter((a) => a !== e) : [...list, e] };
    });
  const addTyped = (id) => {
    const e = String(typed[id] || '').trim().toLowerCase();
    if (!e.includes('@')) return;
    setPicked((p) => ({ ...p, [id]: [...new Set([...(p[id] || []), e])] }));
    setTyped((t) => ({ ...t, [id]: '' }));
  };

  const payload = () => ({
    enabled,
    hour,
    unpaidOnly,
    clients: Object.entries(picked).map(([orgId, addresses]) => ({ orgId, addresses })),
  });

  const save = async () => {
    setBusy('save');
    setNote('');
    try {
      await saveDigest(colleague.id, payload());
      refresh();
      const n = Object.keys(picked).length;
      onSaved?.(
        !enabled
          ? `Daily digest off for ${colleague.name}${n ? ' — switch “Send daily” on to start it' : ''}.`
          : n
            ? `Daily digest on for ${colleague.name} at ${hourLabel(hour)}.`
            : `Daily digest for ${colleague.name} has no clients picked, so nothing will be sent.`
      );
      onClose();
    } catch (e) {
      setNote(e.message);
    } finally {
      setBusy('');
    }
  };

  const sendNow = async () => {
    setBusy('send');
    setNote('');
    try {
      await saveDigest(colleague.id, payload());
      refresh();
      const r = await sendDigestNow(colleague.id);
      setNote(
        r.sent
          ? `Sent to ${colleague.email} — ${r.count} item${r.count === 1 ? '' : 's'}.`
          : /not[_ ]configured|not[_ ]connected/i.test(r.error || '')
            ? 'Not sent: email isn’t set up — connect the mailbox in Settings → Email.'
            : `Not sent: ${r.error || r.skipped || 'unknown error'}.`
      );
    } catch (e) {
      setNote(e.message);
    } finally {
      setBusy('');
    }
  };

  const count = Object.keys(picked).length;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-6">
          <h2 className="truncate pr-4 text-base font-semibold tracking-tight">Daily digest for {colleague.name}</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          <p className="mb-4 text-sm text-muted-foreground">
            Once a day, {colleague.email ? <code>{colleague.email}</code> : colleague.name} is emailed the documents the
            clients below have sent in that are still in the Costs tab — one row each, with a link to the document.
            Nothing is sent on a day with nothing to report.
          </p>

          <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium">Send daily</span>
              <Toggle on={enabled} onToggle={() => setEnabled((v) => !v)} label="Send daily" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <span className="font-medium">At</span>
              <select value={hour} onChange={(e) => setHour(Number(e.target.value))} className="h-8 rounded-md border bg-background px-2 text-sm">
                {hours.map((h) => (
                  <option key={h} value={h}>{hourLabel(h)}</option>
                ))}
              </select>
              <span className="text-xs text-muted-foreground">{data?.timezone || ''}</span>
            </label>
            <button type="button" onClick={() => setUnpaidOnly((v) => !v)} className="flex items-center gap-2 text-sm">
              <Box on={unpaidOnly} /> Only items requiring payment
            </button>
          </div>

          {last && (
            <p className={cn('mb-4 text-xs', last.sent ? 'text-muted-foreground' : 'text-amber-700')}>
              Last digest {new Date(last.at).toLocaleString()}:{' '}
              {last.sent ? `sent, ${last.count} item${last.count === 1 ? '' : 's'}.` : last.error ? `not sent — ${last.error}.` : 'nothing to report.'}
            </p>
          )}

          <div className="overflow-hidden rounded-lg border">
            <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2.5 text-sm font-medium text-muted-foreground">
              <span>Clients</span>
              <span>{count} selected</span>
            </div>
            <div className="max-h-[45vh] overflow-auto">
              {clients.map((c) => {
                const on = Boolean(picked[c.id]);
                const chosen = picked[c.id] || [];
                const known = new Set(c.people.map((p) => p.email.toLowerCase()));
                const extra = chosen.filter((a) => !known.has(a));
                return (
                  <div key={c.id} className="border-b last:border-0">
                    <button type="button" onClick={() => toggleClient(c.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50">
                      <Box on={on} />
                      <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                      {on && (
                        <span className="text-xs text-muted-foreground">
                          {chosen.length ? `${chosen.length} ${chosen.length === 1 ? 'person' : 'people'}` : 'Everyone'}
                        </span>
                      )}
                    </button>
                    {on && (
                      <div className="space-y-1 bg-muted/20 px-4 pb-3 pl-11 pt-1">
                        <p className="pb-1 text-xs text-muted-foreground">
                          Only documents under these people — owned, uploaded or emailed in by them. Tick none for everyone.
                        </p>
                        {[...c.people.filter((p) => !p.external), ...extra.map((a) => ({ email: a, name: a }))].map((p) => (
                          <button key={p.email} type="button" onClick={() => toggleAddress(c.id, p.email)} className="flex w-full items-center gap-2 py-0.5 text-left text-sm">
                            <Box on={chosen.includes(p.email.toLowerCase())} />
                            <span className="truncate">{p.name}</span>
                            {p.name !== p.email && !p.general && <span className="truncate text-xs text-muted-foreground">{p.email}</span>}
                          </button>
                        ))}
                        <div className="flex items-center gap-2 pt-1">
                          <input
                            type="email"
                            value={typed[c.id] || ''}
                            onChange={(e) => setTyped((t) => ({ ...t, [c.id]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTyped(c.id); } }}
                            placeholder="Another address, e.g. finance@client.com"
                            className="h-8 w-72 rounded-md border bg-background px-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                          />
                          <button type="button" onClick={() => addTyped(c.id)} className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted">Add</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {!clients.length && (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {error ? error.message : isLoading ? 'Loading clients…' : `${colleague.name} has no client access yet.`}
                </p>
              )}
            </div>
          </div>
          {note && <p className="mt-3 text-sm text-muted-foreground">{note}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t px-6 py-4">
          <button
            type="button"
            onClick={sendNow}
            disabled={Boolean(busy) || !count}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
            title={count ? 'Save, then email this digest now' : 'Pick a client first'}
          >
            <Mail className="h-4 w-4" /> {busy === 'send' ? 'Sending…' : 'Send one now'}
          </button>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">Cancel</button>
            <button type="button" onClick={save} disabled={Boolean(busy)} className="inline-flex h-9 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
              {busy === 'save' ? 'Saving…' : 'Save digest'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
