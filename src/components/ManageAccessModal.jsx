import { useState } from 'react';
import { X, ChevronDown, Search } from 'lucide-react';

export const GENERAL_ACCESS = ['Practice & Admin users only', 'Everyone can view', 'Everyone can edit'];
export const USER_ACCESS = ['No access', 'Can view', 'Can edit'];

function Select({ value, options, onChange, className = '' }) {
  return (
    <div className={`relative ${className}`}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full appearance-none rounded-md border bg-background px-3 pr-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

// "Manage access" — Dext's per-document access dialog: a general access level
// plus optional per-user overrides.
export default function ManageAccessModal({ open, fileName, generalAccess, userAccess, users, onClose, onGeneral, onUser }) {
  const [q, setQ] = useState('');
  if (!open) return null;

  const filtered = users.filter((u) => u.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-6">
          <h2 className="truncate pr-4 text-base font-semibold tracking-tight">Manage access for {fileName}</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          <p className="mb-4 text-sm text-muted-foreground">
            Access settings applied here will automatically apply to all subfolders and files within
            this folder.
          </p>

          <div className="mb-6 grid grid-cols-1 gap-2 sm:grid-cols-[160px_1fr] sm:items-center">
            <span className="text-sm">General access</span>
            <Select value={generalAccess} options={GENERAL_ACCESS} onChange={onGeneral} />
          </div>

          <p className="mb-2 text-sm font-medium">Customise access for users</p>
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search for a user"
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <div className="overflow-hidden rounded-lg border">
            <div className="grid grid-cols-[1fr_200px] border-b bg-muted/40 px-4 py-2.5 text-sm font-medium text-muted-foreground">
              <span>User</span>
              <span>Access</span>
            </div>
            <div className="max-h-72 overflow-auto">
              {filtered.map((u) => (
                <div key={u.id} className="grid grid-cols-[1fr_200px] items-center border-b px-4 py-3 last:border-0">
                  <span className="truncate pr-3 text-sm">{u.name}</span>
                  <Select value={userAccess[u.id] || 'No access'} options={USER_ACCESS} onChange={(v) => onUser(u.id, v)} />
                </div>
              ))}
              {filtered.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted-foreground">No users match “{q}”.</p>}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end border-t px-6 py-4">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
