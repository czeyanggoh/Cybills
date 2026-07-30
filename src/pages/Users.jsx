import { useState } from 'react';
import { Search, ChevronDown, Settings2, CheckCircle2 } from 'lucide-react';
import AppShell from '@/components/AppShell';
import AddUserModal from '@/components/AddUserModal';
import AddMultipleUsersModal from '@/components/AddMultipleUsersModal';
import EditUserModal from '@/components/EditUserModal';
import { useUsers, addUser, addUsers, setUserActive, removeUser, setUserPassword } from '@/lib/userStore';
import { cn } from '@/lib/utils';

// Per-row "Manage" dropdown (Edit details / privileges, resend, reset,
// (de)activate, remove).
function ManageMenu({ user, onEdit, onToast }) {
  const [open, setOpen] = useState(false);
  const item = 'flex w-full items-center px-3 py-2 text-left text-sm transition-colors hover:bg-muted';
  const run = (fn) => { setOpen(false); fn(); };

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
            <button type="button" className={item} onClick={() => run(() => onToast(`Invitation resent to ${user.email || user.name}.`))}>Resend Invitation</button>
            <button
              type="button"
              className={item}
              onClick={() =>
                run(async () => {
                  const pw = window.prompt(`Set a password for ${user.name} (min 6 characters). Share it with them so they can sign in with their email + this password.`);
                  if (!pw) return;
                  if (pw.length < 6) { onToast('Password must be at least 6 characters.'); return; }
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
  const [tab, setTab] = useState('active');
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [multiOpen, setMultiOpen] = useState(false);
  const [edit, setEdit] = useState(null); // { user, mode }
  const [toast, setToast] = useState('');
  const users = useUsers();

  const showToast = (msg) => setToast(msg);

  const filtered = users.filter(
    (u) =>
      u.name.toLowerCase().includes(query.toLowerCase()) ||
      (u.email || '').toLowerCase().includes(query.toLowerCase())
  );
  const rows = filtered.filter((u) => (tab === 'active' ? !u.deactivated : u.deactivated));

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
              <th className="px-3 py-2.5 font-medium">Login access</th>
              <th className="px-3 py-2.5 font-medium">Role</th>
              <th className="px-3 py-2.5 font-medium">Last login</th>
              <th className="px-3 py-2.5 font-medium">Manage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className="border-b last:border-0 transition-colors hover:bg-muted/40">
                <td className="whitespace-nowrap px-3 py-3 font-medium">{u.name}</td>
                <td className="px-3 py-3 text-muted-foreground">{u.email || '—'}</td>
                <td className="px-3 py-3">{u.login}</td>
                <td className="whitespace-nowrap px-3 py-3">{u.role}</td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">{u.lastLogin}</td>
                <td className="px-3 py-3">
                  <ManageMenu user={u} onEdit={(mode) => setEdit({ user: u, mode })} onToast={showToast} />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-16 text-center text-sm text-muted-foreground">
                  {tab === 'deactivated' ? 'No deactivated users.' : 'No users found.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Showing {rows.length} of {rows.length} items</p>}

      <AddUserModal open={addOpen} onClose={() => setAddOpen(false)} onAdd={addUser} />
      <AddMultipleUsersModal open={multiOpen} onClose={() => setMultiOpen(false)} onAdd={addUsers} />
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
