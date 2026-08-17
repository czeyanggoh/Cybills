import { useState } from 'react';
import { X, Search, Trash2, Flag } from 'lucide-react';
import { useList, addToList, removeFromList, setListVisible } from '@/lib/listsStore';
import { useFlags, updateFlag } from '@/lib/flagsStore';
import { cn } from '@/lib/utils';

// Inner sub-nav for Business settings → Lists (mirrors Dext).
const SUBNAV = [
  { key: 'visibility', label: 'List visibility' },
  { key: 'categories', label: 'Categories' },
  { key: 'taxRates', label: 'Tax rates' },
  { key: 'projects', label: 'Projects' },
  { key: 'projects2', label: 'Projects 2' },
  { key: 'payment', label: 'Payment methods' },
  { key: 'flags', label: 'Flags' },
];

function VisibleToggle({ on, onToggle }) {
  return (
    <button type="button" onClick={onToggle} className="flex items-center gap-2">
      <span className={cn('flex h-5 w-9 items-center rounded-full p-0.5 transition-colors', on ? 'justify-end bg-foreground' : 'justify-start border')}>
        <span className={cn('h-4 w-4 rounded-full', on ? 'bg-background' : 'bg-muted-foreground/50')} />
      </span>
      <span className="text-sm text-muted-foreground">{on ? 'Yes' : 'No'}</span>
    </button>
  );
}

// Generic add dialog — `fields` is [{key,label,placeholder,type}]; required keys
// must be filled.
function AddDialog({ open, title, fields, required, onClose, onAdd }) {
  const [form, setForm] = useState({});
  if (!open) return null;
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const canAdd = required.every((k) => String(form[k] || '').trim());
  const submit = () => { onAdd(form); setForm({}); onClose(); };
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-lg overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex h-14 items-center justify-between border-b px-6">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <div className="space-y-4 p-6">
          {fields.map((f) => (
            <label key={f.key} className="grid grid-cols-[120px_1fr] items-center gap-4 text-sm">
              <span>{f.label} {required.includes(f.key) && <span className="text-destructive">*</span>}</span>
              <input
                value={form[f.key] || ''}
                onChange={(e) => set(f.key, e.target.value)}
                placeholder={f.placeholder || ''}
                inputMode={f.type === 'number' ? 'decimal' : undefined}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-muted">Cancel</button>
          <button type="button" onClick={submit} disabled={!canAdd} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">Add</button>
        </div>
      </div>
    </div>
  );
}

function Toolbar({ children, onDelete, hasSelection, query, setQuery }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {children}
      <button type="button" disabled={!hasSelection} onClick={onDelete} className={cn('inline-flex h-8 items-center rounded-md border px-3 text-sm transition-colors', hasSelection ? 'hover:bg-muted' : 'cursor-not-allowed text-muted-foreground/50')}>
        Delete
      </button>
      <div className="relative ml-auto hidden sm:block">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name" className="h-8 w-56 rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
      </div>
    </div>
  );
}

function useSelection() {
  const [selected, setSelected] = useState(() => new Set());
  const toggle = (id) => setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clear = () => setSelected(new Set());
  return { selected, toggle, clear };
}

function CategoriesList() {
  const rows = useList('categories');
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const { selected, toggle, clear } = useSelection();
  const q = query.trim().toLowerCase();
  const filtered = rows.filter((r) => !q || r.name.toLowerCase().includes(q));

  return (
    <div>
      <Toolbar
        hasSelection={selected.size > 0}
        onDelete={() => { removeFromList('categories', [...selected]); clear(); }}
        query={query}
        setQuery={setQuery}
      >
        <button type="button" onClick={() => setAddOpen(true)} className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted">Add category</button>
      </Toolbar>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            <tr><th className="w-10 px-3 py-2.5" /><th className="px-3 py-2.5 font-medium">Name</th><th className="px-3 py-2.5 font-medium">Code</th><th className="px-3 py-2.5 font-medium">Visible</th></tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-b last:border-0 hover:bg-muted/40">
                <td className="px-3 py-3"><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} className="h-4 w-4 accent-black" /></td>
                <td className="px-3 py-3 font-medium">{r.name}</td>
                <td className="px-3 py-3 text-muted-foreground">{r.code || '—'}</td>
                <td className="px-3 py-3"><VisibleToggle on={r.visible} onToggle={() => setListVisible('categories', r.id, !r.visible)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Showing {filtered.length} of {filtered.length} items</p>
      <AddDialog open={addOpen} title="Add category" fields={[{ key: 'name', label: 'Name' }, { key: 'code', label: 'Code' }]} required={['name']} onClose={() => setAddOpen(false)} onAdd={(f) => addToList('categories', { name: f.name.trim(), code: (f.code || '').trim() })} />
    </div>
  );
}

function TaxRatesList() {
  const rows = useList('taxRates');
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const { selected, toggle, clear } = useSelection();
  const q = query.trim().toLowerCase();
  const filtered = rows.filter((r) => !q || r.name.toLowerCase().includes(q));

  return (
    <div>
      <Toolbar
        hasSelection={selected.size > 0}
        onDelete={() => { removeFromList('taxRates', [...selected]); clear(); }}
        query={query}
        setQuery={setQuery}
      >
        <button type="button" onClick={() => setAddOpen(true)} className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted">Add tax rate</button>
      </Toolbar>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            <tr><th className="w-10 px-3 py-2.5" /><th className="px-3 py-2.5 font-medium">Name</th><th className="px-3 py-2.5 font-medium">ID</th><th className="px-3 py-2.5 font-medium">Code</th><th className="px-3 py-2.5 font-medium">Rate %</th><th className="px-3 py-2.5 font-medium">Visible</th></tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-b last:border-0 hover:bg-muted/40">
                <td className="px-3 py-3"><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} className="h-4 w-4 accent-black" /></td>
                <td className="px-3 py-3 font-medium">{r.name}</td>
                <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{r.id}</td>
                <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{r.code}</td>
                <td className="px-3 py-3 tabular-nums">{Number(r.rate).toFixed(1)}</td>
                <td className="px-3 py-3"><VisibleToggle on={r.visible} onToggle={() => setListVisible('taxRates', r.id, !r.visible)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Showing {filtered.length} of {filtered.length} items</p>
      <AddDialog
        open={addOpen}
        title="Add tax rate"
        fields={[{ key: 'name', label: 'Name' }, { key: 'code', label: 'Code' }, { key: 'rate', label: 'Rate %', type: 'number', placeholder: '0.0' }]}
        required={['name', 'code']}
        onClose={() => setAddOpen(false)}
        onAdd={(f) => addToList('taxRates', { name: f.name.trim(), id: (f.code || '').trim().toUpperCase(), code: (f.code || '').trim().toUpperCase(), rate: Number(f.rate) || 0 })}
      />
    </div>
  );
}

function ProjectsList() {
  const rows = useList('projects');
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const { selected, toggle, clear } = useSelection();
  const q = query.trim().toLowerCase();
  const filtered = rows.filter((r) => !q || r.name.toLowerCase().includes(q));

  return (
    <div>
      <Toolbar
        hasSelection={selected.size > 0}
        onDelete={() => { removeFromList('projects', [...selected]); clear(); }}
        query={query}
        setQuery={setQuery}
      >
        <button type="button" onClick={() => setAddOpen(true)} className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted">Add project</button>
        <button type="button" className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted">Set user defaults</button>
      </Toolbar>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[480px] text-sm">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            <tr><th className="w-10 px-3 py-2.5" /><th className="px-3 py-2.5 font-medium">Name</th><th className="px-3 py-2.5 font-medium">Visible</th></tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-b last:border-0 hover:bg-muted/40">
                <td className="px-3 py-3"><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} className="h-4 w-4 accent-black" /></td>
                <td className="px-3 py-3 font-medium">{r.name}</td>
                <td className="px-3 py-3"><VisibleToggle on={r.visible} onToggle={() => setListVisible('projects', r.id, !r.visible)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Showing {filtered.length} of {filtered.length} items</p>
      <AddDialog open={addOpen} title="Add project" fields={[{ key: 'name', label: 'Name' }]} required={['name']} onClose={() => setAddOpen(false)} onAdd={(f) => addToList('projects', { name: f.name.trim() })} />
    </div>
  );
}

// Colour → Tailwind text colour for the flag icon. Full class strings so the
// JIT compiler keeps them.
const FLAG_COLOR_CLASS = {
  orange: 'text-orange-500',
  yellow: 'text-yellow-500',
  green: 'text-green-500',
  blue: 'text-blue-500',
  purple: 'text-purple-500',
};

function FlagsList() {
  const flags = useFlags();
  return (
    <div>
      <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
        Use additional flags to help organise the Costs and Sales inbox. Rename a flag or hide the ones you don&apos;t use.
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            <tr><th className="w-20 px-3 py-2.5 font-medium">Colour</th><th className="px-3 py-2.5 font-medium">Label</th><th className="w-40 px-3 py-2.5 font-medium">Visible</th></tr>
          </thead>
          <tbody>
            {flags.map((f) => (
              <tr key={f.color} className="border-b last:border-0 hover:bg-muted/40">
                <td className="px-3 py-3"><Flag className={cn('h-4 w-4', FLAG_COLOR_CLASS[f.color] || 'text-muted-foreground')} fill="currentColor" /></td>
                <td className="px-3 py-3">
                  <input
                    value={f.label}
                    onChange={(e) => updateFlag(f.color, { label: e.target.value })}
                    placeholder={f.color}
                    className="h-9 w-full max-w-md rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </td>
                <td className="px-3 py-3"><VisibleToggle on={f.visible} onToggle={() => updateFlag(f.color, { visible: !f.visible })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Placeholder({ label }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-10 text-sm text-muted-foreground">
      <Trash2 className="hidden" />
      {label} settings are managed from Categories, Tax rates and Projects for now.
    </div>
  );
}

export default function ListsSettings() {
  const [tab, setTab] = useState('categories');
  const TITLES = Object.fromEntries(SUBNAV.map((s) => [s.key, s.label]));

  return (
    <div className="flex gap-6">
      <div className="w-48 shrink-0">
        <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lists</p>
        <div className="flex flex-col text-sm">
          {SUBNAV.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setTab(s.key)}
              className={cn('rounded-md px-3 py-2 text-left transition-colors', tab === s.key ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="mb-4 text-lg font-semibold tracking-tight">{TITLES[tab]}</h2>
        {tab === 'categories' ? <CategoriesList /> : tab === 'taxRates' ? <TaxRatesList /> : tab === 'projects' ? <ProjectsList /> : tab === 'flags' ? <FlagsList /> : <Placeholder label={TITLES[tab]} />}
      </div>
    </div>
  );
}
