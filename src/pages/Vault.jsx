import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Flag, FileText, ChevronDown, Filter, Settings2, LayoutGrid, Folder, ChevronLeft } from 'lucide-react';
import AppShell, { AddDocumentsButton } from '@/components/AppShell';
import VaultSubnav from '@/components/VaultSubnav';
import {
  useVaultFiles,
  useVaultFolders,
  fileTypeBadge,
  addVaultFolder,
  removeVaultFiles,
  moveVaultFiles,
} from '@/lib/vaultStore';
import { recordVaultDownload } from '@/lib/vaultDownloads';
import { cn } from '@/lib/utils';

const TABS = [
  { key: 'folders', label: 'Folders' },
  { key: 'all', label: 'All files' },
  { key: 'review', label: 'To review' },
];

function ToolbarButton({ children, disabled = false, dropdown = false, onClick = () => {} }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm transition-colors',
        disabled ? 'cursor-not-allowed text-muted-foreground/50' : 'hover:bg-muted'
      )}
    >
      {children}
      {dropdown && <ChevronDown className="h-3.5 w-3.5" />}
    </button>
  );
}

function Dropdown({ label, disabled = false, items, small = false }) {
  const [open, setOpen] = useState(false);
  if (!items.length) items = [{ label: 'No folders yet', onClick: () => {}, muted: true }];
  return (
    <div className="relative">
      {small ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm transition-colors hover:bg-muted"
        >
          {label} <ChevronDown className="h-3.5 w-3.5" />
        </button>
      ) : (
        <ToolbarButton disabled={disabled} dropdown onClick={() => !disabled && setOpen((o) => !o)}>
          {label}
        </ToolbarButton>
      )}
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-md border bg-background py-1 shadow-lg">
            {items.map((it, i) => (
              <button
                key={i}
                type="button"
                disabled={it.muted}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
                className={cn(
                  'flex w-full items-center px-3 py-2 text-left text-sm transition-colors',
                  it.muted ? 'text-muted-foreground' : 'hover:bg-muted',
                  it.danger && 'text-destructive'
                )}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Download a CSV manifest of the given files (no file bytes are stored yet).
function downloadManifest(files, name) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Name', 'Type', 'Date added', 'Creator', 'Access'];
  const lines = [header, ...files.map((f) => [f.name, fileTypeBadge(f.name), f.dateAdded, f.creator, f.access])];
  const url = URL.createObjectURL(new Blob([lines.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function Vault() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('folders');
  const [selected, setSelected] = useState(() => new Set());
  const [currentFolder, setCurrentFolder] = useState('');

  const files = useVaultFiles();
  const folders = useVaultFolders();

  // Folders only show (and are navigable) in the Folders tab at the root.
  const showFolders = tab === 'folders' && !currentFolder;
  const fileRows =
    tab === 'review'
      ? files.filter((f) => f.flagged)
      : tab === 'all'
        ? files
        : files.filter((f) => (f.folder || '') === currentFolder);

  const hasSelection = selected.size > 0;
  const selectedFiles = fileRows.filter((f) => selected.has(f.id));
  const clear = () => setSelected(new Set());

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) => (prev.size === fileRows.length ? new Set() : new Set(fileRows.map((r) => r.id))));

  const createFolder = () => {
    const name = window.prompt('New folder name');
    if (name && name.trim()) {
      addVaultFolder(name.trim());
      setTab('folders');
      setCurrentFolder('');
    }
  };
  const del = () => {
    if (hasSelection && window.confirm(`Delete ${selected.size} file(s) from the Vault?`)) {
      removeVaultFiles([...selected]);
      clear();
    }
  };
  const move = (folder) => {
    moveVaultFiles([...selected], folder);
    clear();
  };
  const download = () => {
    downloadManifest(selectedFiles, 'vault-files.csv');
    // Dext keeps the generated archives in the Downloads tab.
    recordVaultDownload({ name: `vault-export-${selectedFiles.length}-files.zip`, count: selectedFiles.length });
  };

  const moveItems = [
    ...folders.map((f) => ({ label: `📁 ${f}`, onClick: () => move(f) })),
    ...(folders.length ? [{ label: 'Remove from folder', onClick: () => move('') }] : []),
  ];

  return (
    <AppShell subnav={<VaultSubnav />}>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Vault</h1>
        <AddDocumentsButton />
      </div>

      <div className="mb-4 flex items-center gap-6 border-b">
        {TABS.map((t) => {
          const active = tab === t.key;
          const count = t.key === 'review' ? files.filter((f) => f.flagged).length : null;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setTab(t.key);
                setCurrentFolder('');
                clear();
              }}
              className={cn(
                '-mb-px flex items-center gap-2 border-b-2 pb-3 pt-1 text-sm transition-colors',
                active ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {t.label}
              {count != null && (
                <span className={cn('rounded-full px-1.5 text-xs', active ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground')}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ToolbarButton onClick={createFolder}>Create folder</ToolbarButton>
        <ToolbarButton disabled={!hasSelection} onClick={download}>Download</ToolbarButton>
        <Dropdown label="Move" disabled={!hasSelection} items={moveItems} />
        <ToolbarButton disabled={!hasSelection} onClick={del}>Delete</ToolbarButton>
        <Dropdown
          label="Actions"
          disabled={!hasSelection}
          items={[
            { label: 'Download', onClick: download },
            { label: 'Delete', onClick: del, danger: true },
          ]}
        />
        <div className="ml-auto flex items-center gap-1">
          <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Filter">
            <Filter className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Settings">
            <Settings2 className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Grid view">
            <LayoutGrid className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
        {currentFolder ? (
          <button type="button" onClick={() => { setCurrentFolder(''); clear(); }} className="flex items-center gap-1 hover:text-foreground">
            <ChevronLeft className="h-4 w-4" /> CYBM Workspace
          </button>
        ) : (
          <>
            <Folder className="h-4 w-4" strokeWidth={1.75} />
            CYBM Workspace
          </>
        )}
        {currentFolder && <span className="text-foreground">/ {currentFolder}</span>}
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr className="text-muted-foreground">
              <th className="w-24 px-3 py-2.5">
                <input type="checkbox" checked={fileRows.length > 0 && selected.size === fileRows.length} onChange={toggleAll} className="h-4 w-4 accent-black" />
              </th>
              <th className="px-3 py-2.5 font-medium">Name</th>
              <th className="px-3 py-2.5 font-medium">Tags</th>
              <th className="px-3 py-2.5 font-medium">Date added</th>
              <th className="px-3 py-2.5 font-medium">Creator</th>
              <th className="px-3 py-2.5 font-medium">Access</th>
              <th className="px-3 py-2.5 font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {showFolders &&
              folders.map((name) => (
                <tr
                  key={`folder-${name}`}
                  onClick={() => { setCurrentFolder(name); clear(); }}
                  className="cursor-pointer border-b transition-colors hover:bg-muted/40"
                >
                  <td className="px-3 py-3" />
                  <td className="flex items-center gap-2 px-3 py-3 font-medium">
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                    {name}
                  </td>
                  <td colSpan={5} className="px-3 py-3 text-muted-foreground">
                    {files.filter((f) => f.folder === name).length} file(s)
                  </td>
                </tr>
              ))}
            {fileRows.map((f) => (
              <tr
                key={f.id}
                onClick={() => navigate(`/vault/${f.id}`)}
                className="cursor-pointer border-b last:border-0 transition-colors hover:bg-muted/40"
              >
                <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-2">
                    <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f.id)} className="h-4 w-4 accent-black" />
                    <Flag className={cn('h-3.5 w-3.5', f.flagged ? 'fill-foreground text-foreground' : 'text-muted-foreground/60')} strokeWidth={1.75} />
                    <span className="rounded bg-muted px-1 py-0.5 text-[10px] font-semibold text-muted-foreground">{fileTypeBadge(f.name)}</span>
                  </div>
                </td>
                <td className="flex items-center gap-2 px-3 py-3">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className="truncate">{f.name}</span>
                </td>
                <td className="px-3 py-3 text-muted-foreground">{f.folder ? `📁 ${f.folder}` : '—'}</td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">{f.dateAdded}</td>
                <td className="whitespace-nowrap px-3 py-3">{f.creator}</td>
                <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{f.access}</td>
                <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                  <Dropdown
                    small
                    label="Actions"
                    items={[
                      { label: 'Download', onClick: () => downloadManifest([f], `${f.name}.csv`) },
                      { label: 'Delete', onClick: () => { if (window.confirm(`Delete ${f.name}?`)) removeVaultFiles([f.id]); }, danger: true },
                    ]}
                  />
                </td>
              </tr>
            ))}
            {fileRows.length === 0 && !showFolders && (
              <tr>
                <td colSpan={7} className="px-4 py-16 text-center text-sm text-muted-foreground">No files here.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Showing {fileRows.length} of {fileRows.length} items{showFolders && folders.length ? ` · ${folders.length} folder(s)` : ''}
      </p>
    </AppShell>
  );
}
