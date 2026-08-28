import { useEffect, useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Search, ChevronDown, Settings2, CheckCircle2 } from 'lucide-react';
import AppShell from '@/components/AppShell';
import AddUserModal from '@/components/AddUserModal';
import AddMultipleUsersModal from '@/components/AddMultipleUsersModal';
import EditUserModal from '@/components/EditUserModal';
import { useUsers, addUser, addUsers, setUserActive, removeUser, setUserPassword, approveUser, inviteUser, updateUser } from '@/lib/userStore';
import { useOrganisations, getActiveOrganisationId, useXeroProjectOptions } from '@/lib/organisations';
import { useAuth } from '@/lib/auth';
import { isPracticeTeam } from '@/lib/practiceStore';
import { cn } from '@/lib/utils';
import ComboSelect from '@/components/ComboSelect';
import { resetTotpFor } from '@/lib/totp';

// Per-row "Manage" dropdown (Edit details / privileges, resend, reset,
// (de)activate, remove).
function ManageMenu({ user, onEdit, onToast }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const [pos, setPos] = useState(null);
  // The table scrolls (overflow-x-auto), and a browser that clips one axis
  // clips the other with it — so an absolutely-positioned menu was cut off at
  // the bottom edge of the table, which on the last row hid the whole thing.
  // Measure the button and render the menu fixed, flipping above when there
  // isn't room below.
  useEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = buttonRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = 208; // w-52
      const height = 300; // enough to decide which side has room
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

  // Send (or re-send) the invitation email. The server always returns the link,
  // so when mail isn't configured — or delivery failed — we hand the admin the
  // link to pass on instead of leaving the invite stuck.
  const sendInvite = async () => {
    if (!user.email) {
      onToast(`${user.name} has no email address — add one before inviting them.`);
      return;
    }
    onToast(`Sending invitation to ${user.email}…`);
    const res = await inviteUser(user.id);
    if (res.sent) {
      onToast(`Invitation emailed to ${user.email}.`);
      return;
    }
    if (!res.link) {
      onToast(`Could not invite ${user.name} (${res.error || 'unknown error'}).`);
      return;
    }
    try {
      await navigator.clipboard.writeText(res.link);
      onToast(`Email isn’t configured — invite link copied to your clipboard. Send it to ${user.email} yourself.`);
    } catch {
      window.prompt(`Email isn’t configured. Copy this invite link and send it to ${user.email}:`, res.link);
      onToast('Invite link created — share it with the user.');
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
            <button type="button" className={item} onClick={() => run(() => onEdit('details'))}>Edit user details</button>
            <button type="button" className={item} onClick={() => run(() => onEdit('privileges'))}>Edit privileges</button>
            <button type="button" className={item} onClick={() => run(sendInvite)}>
              {user.invitedAt ? 'Resend invitation' : 'Send invitation'}
            </button>
            <button
              type="button"
              className={item}
              onClick={() =>
                run(async () => {
                  const pw = window.prompt(`Set a password for ${user.name} (min 8 characters). Share it with them so they can sign in with their email + this password. Prefer "Send invitation" — it lets them choose their own.`);
                  if (!pw) return;
                  if (pw.length < 8) { onToast('Password must be at least 8 characters.'); return; }
                  const ok = await setUserPassword(user.id, pw);
                  onToast(ok ? `Password set for ${user.name}. They can now sign in with email + password.` : 'Could not set password.');
                })
              }
            >
              {user.hasPassword ? 'Change password' : 'Set password'}
            </button>
            {/* The phone that is genuinely gone, and the recovery codes with
                it. This CLEARS the second factor — it never reveals one — so
                the person is put back where they started, able to enrol again.
                Offered only when there is something to clear. */}
            {user.totpEnabled && (
              <button
                type="button"
                className={item}
                onClick={() =>
                  run(async () => {
                    if (!window.confirm(`Reset two-step sign-in for ${user.name}?\n\nThey will sign in with just their password until they set it up again. Do this only if they have lost both their phone and their recovery codes.`)) return;
                    try {
                      await resetTotpFor(user.id);
                      onToast(`Two-step sign-in reset for ${user.name}.`);
                    } catch {
                      onToast('Could not reset two-step sign-in.');
                    }
                  })
                }
              >
                Reset two-step sign-in
              </button>
            )}
            {user.deactivated ? (
              <button type="button" className={cn(item, 'text-emerald-600')} onClick={() => run(() => { setUserActive(user.id, true); onToast(`${user.name} reactivated.`); })}>Reactivate user</button>
            ) : (
              <button type="button" className={cn(item, 'text-destructive')} onClick={() => run(() => { setUserActive(user.id, false); onToast(`${user.name} deactivated.`); })}>Deactivate user</button>
            )}
            <button
              type="button"
              className={cn(item, 'text-destructive')}
              onClick={() => run(() => { if (window.confirm(`Remove ${user.name}?`)) { removeUser(user.id); onToast(`${user.name} removed.`); } })}
            >
              Remove user
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function Users() {
  const [params] = useSearchParams();
  const [tab, setTab] = useState(params.get('tab') === 'pending' ? 'pending' : 'active');
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [multiOpen, setMultiOpen] = useState(false);
  const [edit, setEdit] = useState(null); // { user, mode }
  const [toast, setToast] = useState('');
  const users = useUsers();

  const showToast = (msg) => setToast(msg);

  // Summarise an add result: warn about emails that already exist, and report
  // whether the invitation was emailed (or that mail isn't configured).
  const reportAdd = (r) => {
    const dups = r?.duplicates || [];
    const linked = r?.linked || [];
    const invites = r?.invites || [];
    // Somebody who already existed elsewhere now works here too: one person,
    // one login, two entities. Say so plainly — "already a user, not added
    // again" was the old answer and it was a refusal, not a result.
    if (linked.length) {
      const who = linked.map((l) => `${l.name || l.email}${l.role ? ` (${l.role})` : ''}`).join(', ');
      showToast(`${who} now also works in this entity — they keep their existing login.`);
      return;
    }
    if (dups.length) {
      // One email = one person across the whole business (sign-in is by email),
      // so name the organisation that already has them rather than just refusing.
      const who = dups
        .map((d) => (d.organisationName ? `${d.email} (already in ${d.organisationName})` : d.email))
        .join(', ');
      // A practice colleague is reached through client access, not through a
      // client's own roster — pointing at the wrong page is worse than silence.
      showToast(
        dups.some((d) => d.practice)
          ? `${who} is on the practice team — give them access to this client from Colleagues.`
          : `Already a user: ${who} — not added again.`,
      );
      return;
    }
    const sent = invites.filter((i) => i.sent);
    const notSent = invites.filter((i) => !i.sent);
    if (sent.length && !notSent.length) {
      showToast(`Added — invitation emailed to ${sent.map((i) => i.email).join(', ')}.`);
    } else if (notSent.length) {
      // The invite couldn't be emailed. Surface WHY (the server returns the SMTP
      // error / not-configured reason) and copy the shareable link so the admin
      // can send it by hand instead of guessing.
      const links = notSent.filter((i) => i.link).map((i) => i.link);
      const who = notSent.map((i) => i.email).join(', ');
      const raw = notSent.map((i) => i.error).find(Boolean) || '';
      const reason = /not[_ ]configured|not[_ ]connected/i.test(raw)
        ? 'email isn’t set up — connect the mailbox in Settings → Email'
        : raw
          ? `the mail server rejected it (${raw})`
          : 'the mail server didn’t accept it';
      if (links.length) {
        navigator.clipboard?.writeText(links.join('\n')).catch(() => {});
        showToast(
          `Added ${who}, but the invite email didn’t go out — ${reason}. Invite link${links.length === 1 ? '' : 's'} copied to your clipboard so you can send it directly.`
        );
      } else {
        showToast(`Added ${who}, but the invite email didn’t go out — ${reason}.`);
      }
    } else {
      showToast('User(s) added.');
    }
  };
  const handleAddUser = async (form, notify = true, message = '', orgName = '') =>
    reportAdd(await addUser(form, notify, message, orgName).catch(() => null));
  const handleAddUsers = async (list, notify = true, message = '', orgName = '') =>
    reportAdd(await addUsers(list, notify, message, orgName).catch(() => null));

  const filtered = users.filter(
    (u) =>
      u.name.toLowerCase().includes(query.toLowerCase()) ||
      (u.email || '').toLowerCase().includes(query.toLowerCase())
  );
  const pendingCount = users.filter((u) => u.pending && !u.deactivated).length;
  // Anyone active can be someone's direct manager (the approver claims route to)
  // — except the general account, which is a place for unassigned documents to
  // land, not a person who can approve anything.
  const managerOptions = users.filter((m) => !m.deactivated && !m.pending && !m.general);
  const projectOptions = useXeroProjectOptions();
  // The roster is tenant-specific — the server returns only the selected
  // organisation's people — so a row without its own stored company name is
  // shown under that organisation rather than a blank dash.
  const { data: organisations = [] } = useOrganisations();
  const activeOrg = organisations.find((o) => o.id === getActiveOrganisationId()) || organisations[0];
  const workspaceCompany = activeOrg?.name || '';
  // The practice's own entity (the primary org, CYBM) has no separate "Users" —
  // its people are the practice team. A colleague viewing it is sent to
  // Colleagues instead of an empty roster.
  const navigate = useNavigate();
  const { membership, googleEnabled } = useAuth();
  const redirectToColleagues = activeOrg?.isPrimary && isPracticeTeam(membership, googleEnabled);
  useEffect(() => {
    if (redirectToColleagues) navigate('/colleagues', { replace: true });
  }, [redirectToColleagues, navigate]);
  const rows = filtered.filter((u) => {
    if (tab === 'pending') return u.pending && !u.deactivated;
    if (tab === 'deactivated') return u.deactivated;
    return !u.deactivated && !u.pending; // active
  });

  // While redirecting a colleague off the practice's own entity, render nothing.
  if (redirectToColleagues) return <AppShell><div /></AppShell>;

  return (
    <AppShell>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Users</h1>
          {activeOrg && (
            <p className="mt-0.5 text-sm text-muted-foreground">
              People in {activeOrg.name}. Switch organisation to manage another entity&apos;s users.
            </p>
          )}
        </div>
        <button type="button" onClick={() => setAddOpen(true)} className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted">
          Add a user
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
            { key: 'pending', label: `Pending${pendingCount ? ` (${pendingCount})` : ''}` },
            { key: 'deactivated', label: 'Deactivated' },
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
          <button type="button" onClick={() => setMultiOpen(true)} className="inline-flex h-8 items-center rounded-md border px-3 text-sm transition-colors hover:bg-muted">
            Add multiple users
          </button>
          <div className="relative hidden sm:block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="h-8 w-48 rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
          </div>
          <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Settings">
            <Settings2 className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr className="text-muted-foreground">
              <th className="px-3 py-2.5 font-medium">Name</th>
              <th className="px-3 py-2.5 font-medium">Email</th>
              <th className="px-3 py-2.5 font-medium">Company</th>
              <th className="px-3 py-2.5 font-medium">Login access</th>
              <th className="px-3 py-2.5 font-medium">Role</th>
              <th className="px-3 py-2.5 font-medium">Direct manager</th>
              <th className="px-3 py-2.5 font-medium">Project (PIC)</th>
              <th className="px-3 py-2.5 font-medium">Last login</th>
              <th className="px-3 py-2.5 font-medium">Manage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className="border-b last:border-0 transition-colors hover:bg-muted/40">
                <td className="whitespace-nowrap px-3 py-3 font-medium">
                  {u.name}
                  {/* The row created with the organisation itself. Saying so
                      here is the only place it's explained — otherwise it reads
                      as a colleague nobody remembers adding. */}
                  {u.general && (
                    <span
                      className="ml-2 rounded border px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground"
                      title="Created with the organisation. Documents added by CY colleagues belong to this account unless another user is chosen as owner."
                    >
                      Default owner
                    </span>
                  )}
                  {/* Adding somebody CREATES their row — that is what lets them
                      own documents and be claimed for before they ever sign in.
                      Without saying so, a person who has never been through the
                      invitation reads as an active user, and the admin is left
                      wondering how they got here. */}
                  {/* Their row lives in another entity — they work here too.
                      One person, one login; the role shown is the one they hold
                      HERE, which is often not the one they hold at home. */}
                  {u.homeOrgName && (
                    <span
                      className="ml-2 rounded border px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground"
                      title={`Belongs to ${u.homeOrgName} and also works here. Their role here is set on this page; their role there is not.`}
                    >
                      Also in {u.homeOrgName}
                    </span>
                  )}
                  {!u.general && u.login === 'Yes' && u.lastLogin === '—' && (
                    <span
                      className="ml-2 rounded border px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground"
                      title={
                        u.invitedAt
                          ? 'Invited, but has never signed in. Invitation links are one-time and expire — use Resend invitation if theirs no longer works. They can also sign in with Google using this address.'
                          : 'Has login access but has never signed in. Send them an invitation, or they can sign in with Google using this address.'
                      }
                    >
                      {u.invitedAt ? 'Invited' : 'Never signed in'}
                    </span>
                  )}
                </td>
                <td className="px-3 py-3 text-muted-foreground">{u.email || '—'}</td>
                <td className="px-3 py-3 text-muted-foreground">{u.companyName || workspaceCompany || '—'}</td>
                <td className="px-3 py-3">{u.login}</td>
                <td className="whitespace-nowrap px-3 py-3">{u.role}</td>
                <td className="px-3 py-3">
                  <select
                    value={u.managerId || ''}
                    onChange={async (e) => {
                      await updateUser(u.id, { managerId: e.target.value });
                      showToast(e.target.value ? `Direct manager set for ${u.name}.` : `Direct manager cleared for ${u.name}.`);
                    }}
                    className="h-8 w-44 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">— None —</option>
                    {managerOptions.filter((m) => m.id !== u.id).map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-3">
                  <ComboSelect
                    size="xs"
                    className="w-40"
                    aria-label="Project"
                    value={u.project || ''}
                    options={['', ...projectOptions]}
                    format={(p) => p || '— None —'}
                    emptyLabel="— None —"
                    onChange={async (v) => {
                      await updateUser(u.id, { project: v });
                      showToast(v ? `Project ${v} set for ${u.name}.` : `Project cleared for ${u.name}.`);
                    }}
                  />
                </td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">{u.lastLogin}</td>
                <td className="px-3 py-3">
                  {u.pending ? (
                    <button
                      type="button"
                      onClick={async () => { await approveUser(u.id); showToast(`${u.name} approved.`); }}
                      className="inline-flex h-8 items-center rounded-md bg-foreground px-3 text-xs font-medium text-background transition-opacity hover:opacity-90"
                    >
                      Approve
                    </button>
                  ) : (
                    <ManageMenu user={u} onEdit={(mode) => setEdit({ user: u, mode })} onToast={showToast} />
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-16 text-center text-sm text-muted-foreground">
                  {tab === 'deactivated'
                    ? 'No deactivated users.'
                    : tab === 'pending'
                      ? 'No pending join requests.'
                      : activeOrg
                        ? `No users in ${activeOrg.name} yet — add one to get started.`
                        : 'No users found.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Showing {rows.length} of {rows.length} items</p>}

      <AddUserModal open={addOpen} onClose={() => setAddOpen(false)} onAdd={handleAddUser} />
      <AddMultipleUsersModal open={multiOpen} onClose={() => setMultiOpen(false)} onAdd={handleAddUsers} />
      <EditUserModal
        key={edit ? `${edit.user.id}-${edit.mode}` : 'closed'}
        open={Boolean(edit)}
        mode={edit?.mode}
        user={edit?.user}
        onClose={() => setEdit(null)}
      />
    </AppShell>
  );
}
