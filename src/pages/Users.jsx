import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, ChevronDown, Settings2, CheckCircle2 } from 'lucide-react';
import AppShell from '@/components/AppShell';
import AddUserModal from '@/components/AddUserModal';
import AddMultipleUsersModal from '@/components/AddMultipleUsersModal';
import EditUserModal from '@/components/EditUserModal';
import { useUsers, addUser, addUsers, setUserActive, removeUser, setUserPassword, approveUser, inviteUser, updateUser } from '@/lib/userStore';
import { useOrganisations, getActiveOrganisationId, useXeroProjectOptions } from '@/lib/organisations';
import { cn } from '@/lib/utils';

// Per-row "Manage" dropdown (Edit details / privileges, resend, reset,
// (de)activate, remove).
function ManageMenu({ user, onEdit, onToast }) {
  const [open, setOpen] = useState(false);
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
      <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm transition-colors hover:bg-muted">
        Manage <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute right-0 z-20 mt-1 w-52 overflow-hidden rounded-md border bg-background py-1 shadow-lg">
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
    const invites = r?.invites || [];
    if (dups.length) {
      showToast(`Already a user: ${dups.map((d) => d.email).join(', ')} — not added again.`);
      return;
    }
    const sent = invites.filter((i) => i.sent);
    const notSent = invites.filter((i) => !i.sent);
    if (sent.length && !notSent.length) {
      showToast(`Added — invitation emailed to ${sent.map((i) => i.email).join(', ')}.`);
    } else if (notSent.length) {
      // The mailbox isn't connected (Settings → Email), so the server couldn't
      // email the invite and returned a shareable link instead. Don't bury it —
      // copy it to the clipboard so the admin can paste it to the user directly.
      const links = notSent.filter((i) => i.link).map((i) => i.link);
      const who = notSent.map((i) => i.email).join(', ');
      if (links.length) {
        navigator.clipboard?.writeText(links.join('\n')).catch(() => {});
        showToast(
          `Added ${who}, but email isn’t connected — invite link${links.length === 1 ? '' : 's'} copied to your clipboard. Send it to them, or connect the mailbox in Settings → Email to email invites automatically.`
        );
      } else {
        showToast(`Added ${who}, but email isn’t connected — connect the mailbox in Settings → Email to send invites.`);
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
  // Anyone active can be someone's direct manager (the approver claims route to).
  const managerOptions = users.filter((m) => !m.deactivated && !m.pending);
  const projectOptions = useXeroProjectOptions();
  // Users without an explicit company (seeded / admin-added) belong to the
  // active workspace organisation, so show that rather than a blank dash.
  const { data: organisations = [] } = useOrganisations();
  const activeOrg = organisations.find((o) => o.id === getActiveOrganisationId()) || organisations[0];
  const workspaceCompany = activeOrg?.name || '';
  const rows = filtered.filter((u) => {
    if (tab === 'pending') return u.pending && !u.deactivated;
    if (tab === 'deactivated') return u.deactivated;
    return !u.deactivated && !u.pending; // active
  });

  return (
    <AppShell>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Users</h1>
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
                <td className="whitespace-nowrap px-3 py-3 font-medium">{u.name}</td>
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
                  <select
                    value={u.project || ''}
                    onChange={async (e) => {
                      await updateUser(u.id, { project: e.target.value });
                      showToast(e.target.value ? `Project ${e.target.value} set for ${u.name}.` : `Project cleared for ${u.name}.`);
                    }}
                    className="h-8 w-40 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">— None —</option>
                    {(u.project && !projectOptions.includes(u.project) ? [u.project, ...projectOptions] : projectOptions).map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
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
