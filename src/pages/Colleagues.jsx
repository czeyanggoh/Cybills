import { useEffect, useRef, useState } from 'react';
import { Search, ChevronDown, CheckCircle2, Building2 } from 'lucide-react';
import AppShell from '@/components/AppShell';
import AddColleagueModal from '@/components/AddColleagueModal';
import ClientAccessModal from '@/components/ClientAccessModal';
import EditUserModal from '@/components/EditUserModal';
import {
  useColleagues,
  usePractice,
  addColleagues,
  clientAccessLabel,
} from '@/lib/practiceStore';
import { setUserActive, removeUser, setUserPassword, inviteUser, updateUser } from '@/lib/userStore';
import { cn } from '@/lib/utils';

// Whether this colleague runs the practice's own business (the roster, client
// access) — the "Manage practice's business" column.
const managesPractice = (c) => c.practiceRole === 'Owner' || c.practiceRole === 'Practice Admin';

// Per-row "Manage" dropdown. Same fixed-position placement trick as the Users
// page: the table scrolls, and a clipped axis clips the menu with it.
function ManageMenu({ colleague, onEdit, onAccess, onToast }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const [pos, setPos] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = buttonRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = 208; // w-52
      const height = 300;
      const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8);
      const below = window.innerHeight - r.bottom;
      setPos(
        below < height && r.top > below
          ? { left, width, bottom: window.innerHeight - r.top + 4 }
          : { left, width, top: r.bottom + 4 }
      );
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
  const item = 'flex w-full items-center px-3 py-2 text-left text-sm transition-colors hover:bg-muted';
  const run = (fn) => { setOpen(false); fn(); };

  const sendInvite = async () => {
    if (!colleague.email) {
      onToast(`${colleague.name} has no email address — add one before inviting them.`);
      return;
    }
    onToast(`Sending invitation to ${colleague.email}…`);
    const res = await inviteUser(colleague.id);
    if (res.sent) {
      onToast(`Invitation emailed to ${colleague.email}.`);
      return;
    }
    if (!res.link) {
      onToast(`Could not invite ${colleague.name} (${res.error || 'unknown error'}).`);
      return;
    }
    try {
      await navigator.clipboard.writeText(res.link);
      onToast(`Email isn’t configured — invite link copied to your clipboard. Send it to ${colleague.email} yourself.`);
    } catch {
      window.prompt(`Email isn’t configured. Copy this invite link and send it to ${colleague.email}:`, res.link);
      onToast('Invite link created — share it with the colleague.');
    }
  };

  return (
    <div className="relative">
      <button type="button" ref={buttonRef} onClick={() => setOpen((o) => !o)} className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm transition-colors hover:bg-muted">
        Manage <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            style={pos ? { top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width } : { visibility: 'hidden' }}
            className="fixed z-40 max-h-[70vh] overflow-auto rounded-md border bg-background py-1 shadow-lg"
          >
            <button type="button" className={item} onClick={() => run(() => onEdit('details'))}>Edit colleague details</button>
            <button type="button" className={item} onClick={() => run(onAccess)}>Client access</button>
            <button type="button" className={item} onClick={() => run(() => onEdit('privileges'))}>Edit privileges</button>
            <button type="button" className={item} onClick={() => run(sendInvite)}>
              {colleague.invitedAt ? 'Resend invitation' : 'Send invitation'}
            </button>
            <button
              type="button"
              className={item}
              onClick={() =>
                run(async () => {
                  const pw = window.prompt(`Set a password for ${colleague.name} (min 8 characters). Prefer "Send invitation" — it lets them choose their own.`);
                  if (!pw) return;
                  if (pw.length < 8) { onToast('Password must be at least 8 characters.'); return; }
                  const ok = await setUserPassword(colleague.id, pw);
                  onToast(ok ? `Password set for ${colleague.name}.` : 'Could not set password.');
                })
              }
            >
              {colleague.hasPassword ? 'Change password' : 'Set password'}
            </button>
            {colleague.deactivated ? (
              <button type="button" className={cn(item, 'text-emerald-600')} onClick={() => run(() => { setUserActive(colleague.id, true); onToast(`${colleague.name} reactivated.`); })}>Reactivate colleague</button>
            ) : (
              <button type="button" className={cn(item, 'text-destructive')} onClick={() => run(() => { setUserActive(colleague.id, false); onToast(`${colleague.name} deactivated.`); })}>Deactivate colleague</button>
            )}
            <button
              type="button"
              className={cn(item, 'text-destructive')}
              onClick={() => run(() => { if (window.confirm(`Remove ${colleague.name} from the practice?`)) { removeUser(colleague.id); onToast(`${colleague.name} removed.`); } })}
            >
              Remove colleague
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// The practice's own team. Distinct from Users, which is one CLIENT's staff:
// these people work across clients, and which clients is the "Client access"
// column — a colleague is a Business Admin inside every one they hold.
export default function Colleagues() {
  const [tab, setTab] = useState('active');
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [edit, setEdit] = useState(null); // { colleague, mode }
  const [access, setAccess] = useState(null); // colleague
  const [toast, setToast] = useState('');
  const { data: colleagues = [], isLoading, error } = useColleagues();
  const { data: practice } = usePractice();
  const practiceName = practice?.practice?.name || 'the practice';

  const showToast = (msg) => setToast(msg);

  const handleAdd = async (form, notify) => {
    const r = await addColleagues([form], notify).catch(() => null);
    const dups = r?.duplicates || [];
    if (dups.length) {
      const who = dups
        .map((d) => (d.organisationName ? `${d.email} (already in ${d.organisationName})` : d.email))
        .join(', ');
      showToast(`Already a user: ${who} — not added again.`);
      return;
    }
    const invites = r?.invites || [];
    const notSent = invites.filter((i) => !i.sent);
    if (invites.length && !notSent.length) {
      showToast(`Colleague added — invitation emailed to ${invites.map((i) => i.email).join(', ')}.`);
    } else if (notSent.length) {
      const links = notSent.filter((i) => i.link).map((i) => i.link);
      const raw = notSent.map((i) => i.error).find(Boolean) || '';
      const reason = /not[_ ]configured|not[_ ]connected/i.test(raw)
        ? 'email isn’t set up — connect the mailbox in Settings → Email'
        : raw
          ? `the mail server rejected it (${raw})`
          : 'the mail server didn’t accept it';
      if (links.length) navigator.clipboard?.writeText(links.join('\n')).catch(() => {});
      showToast(
        `Colleague added, but the invite email didn’t go out — ${reason}.${links.length ? ' Invite link copied to your clipboard.' : ''}`
      );
    } else {
      showToast('Colleague added.');
    }
  };

  const filtered = colleagues.filter(
    (c) =>
      c.name.toLowerCase().includes(query.toLowerCase()) ||
      (c.email || '').toLowerCase().includes(query.toLowerCase())
  );
  const rows = filtered.filter((c) => (tab === 'deactivated' ? c.deactivated : !c.deactivated));
  // Anyone still active on the practice team can approve for anyone else. A
  // deactivated colleague cannot sign in, so a claim routed to them would wait
  // for somebody who can never open it.
  const managerOptions = colleagues.filter((m) => !m.deactivated && !m.pending);
  const deactivatedCount = colleagues.filter((c) => c.deactivated).length;

  return (
    <AppShell>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Colleagues</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {practiceName}&apos;s own team. Each colleague works on the clients they&apos;re given
            access to, as a Business Admin inside each one.
          </p>
          {/* The entity switcher sits above this page and does nothing to it —
              a colleague belongs to no single client, so this list is the same
              whichever one is open. Saying so beats leaving the header to imply
              otherwise. */}
          <p className="mt-1 text-xs text-muted-foreground">
            The practice&apos;s own list — it doesn&apos;t change with the client entity you have open.
          </p>
        </div>
        <button type="button" onClick={() => setAddOpen(true)} className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted">
          Add a colleague
        </button>
      </div>

      {toast && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-emerald-600/30 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          <CheckCircle2 className="h-4 w-4" /> {toast}
          <button type="button" onClick={() => setToast('')} className="ml-auto text-emerald-700/70 hover:text-emerald-700">Dismiss</button>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-md border text-sm">
          {[
            { key: 'active', label: 'Active' },
            { key: 'deactivated', label: `Deactivated${deactivatedCount ? ` (${deactivatedCount})` : ''}` },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn('px-4 py-1.5 transition-colors', tab === t.key ? 'bg-foreground text-background' : 'hover:bg-muted')}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative hidden sm:block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="h-8 w-48 rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr className="text-muted-foreground">
              <th className="px-3 py-2.5 font-medium">Name</th>
              <th className="px-3 py-2.5 font-medium">Email</th>
              <th className="px-3 py-2.5 font-medium">Role</th>
              <th className="px-3 py-2.5 font-medium">Manage practice&apos;s business</th>
              <th className="px-3 py-2.5 font-medium">Direct manager</th>
              <th className="px-3 py-2.5 font-medium">Client access</th>
              <th className="px-3 py-2.5 font-medium">Last login</th>
              <th className="px-3 py-2.5 font-medium">Manage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-b last:border-0 transition-colors hover:bg-muted/40">
                <td className="whitespace-nowrap px-3 py-3 font-medium">{c.name}</td>
                <td className="px-3 py-3 text-muted-foreground">{c.email || '—'}</td>
                <td className="whitespace-nowrap px-3 py-3">{c.practiceRole}</td>
                <td className="px-3 py-3">{managesPractice(c) ? 'Yes' : 'No'}</td>
                {/* Who approves this colleague's expense claims. It lives here
                    rather than on Users because a colleague is on no client's
                    roster — which is exactly why they could never submit a claim
                    at all: there was nowhere to name their approver. */}
                <td className="px-3 py-3">
                  <select
                    value={c.managerId || ''}
                    aria-label={`Direct manager for ${c.name}`}
                    onChange={async (e) => {
                      await updateUser(c.id, { managerId: e.target.value });
                      const who = managerOptions.find((m) => m.id === e.target.value);
                      showToast(who ? `${who.name} approves ${c.name}'s claims.` : `Direct manager cleared for ${c.name}.`);
                    }}
                    className="h-8 w-44 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">— None —</option>
                    {managerOptions.filter((m) => m.id !== c.id).map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-3">
                  <button
                    type="button"
                    onClick={() => setAccess(c)}
                    title={(c.clients || []).map((o) => o.name).join(', ') || 'No clients yet'}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors hover:bg-muted"
                  >
                    <Building2 className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.75} />
                    {clientAccessLabel(c)}
                  </button>
                </td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">{c.lastLogin}</td>
                <td className="px-3 py-3">
                  <ManageMenu
                    colleague={c}
                    onEdit={(mode) => setEdit({ colleague: c, mode })}
                    onAccess={() => setAccess(c)}
                    onToast={showToast}
                  />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-16 text-center text-sm text-muted-foreground">
                  {error
                    ? 'Only the practice team can see colleagues.'
                    : isLoading
                      ? 'Loading colleagues…'
                      : tab === 'deactivated'
                        ? 'No deactivated colleagues.'
                        : 'No colleagues yet — add one to get started.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Showing {rows.length} of {rows.length} items</p>}

      <AddColleagueModal
        open={addOpen}
        practiceName={practice?.practice?.name}
        onClose={() => setAddOpen(false)}
        onAdd={handleAdd}
      />
      <ClientAccessModal
        key={access ? `access-${access.id}` : 'access-closed'}
        open={Boolean(access)}
        colleague={access}
        onClose={() => setAccess(null)}
        onSaved={(label) => showToast(`Client access updated for ${access?.name} — ${label}.`)}
      />
      <EditUserModal
        key={edit ? `${edit.colleague.id}-${edit.mode}` : 'closed'}
        open={Boolean(edit)}
        mode={edit?.mode}
        user={edit?.colleague}
        practice
        onClose={() => setEdit(null)}
      />
    </AppShell>
  );
}
