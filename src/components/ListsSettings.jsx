import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X, Search, Trash2, Flag } from 'lucide-react';
import { addToList, removeFromList, setListVisible } from '@/lib/listsStore';
import { useFlags, updateFlag } from '@/lib/flagsStore';
import { useOrganisations, useXeroTracking, useXeroCategories, updateXeroCategoryDescription, getActiveOrganisationId, useXeroPaymentMethods, useManagedTaxRates } from '@/lib/organisations';
import { useReviewInstructions, saveReviewInstructions } from '@/lib/reviewInstructions';
import { cn } from '@/lib/utils';

// Inner sub-nav for Business settings → Lists (mirrors Dext).
const SUBNAV = [
  { key: 'visibility', label: 'List visibility' },
  { key: 'categories', label: 'Categories' },
  { key: 'review', label: 'Review instructions' },
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

// Categories = the active org's Xero expense accounts. Each Description is
// editable here and written straight back to Xero. Pulled live per org (so CYBM
// shows CYBM's chart). Name/Code come from Xero and are read-only.
function CategoriesFromXero() {
  const qc = useQueryClient();
  const { data: organisations = [] } = useOrganisations();
  const orgId = (organisations.find((o) => o.id === getActiveOrganisationId()) || organisations[0])?.id || '';
  const { data: categories, isLoading, isError, error } = useXeroCategories(orgId);
  const [query, setQuery] = useState('');
  const [edits, setEdits] = useState({}); // id -> edited description
  const [status, setStatus] = useState({}); // id -> 'saving' | 'saved' | 'error'
  const [errMsg, setErrMsg] = useState({}); // id -> message

  const notice = (msg) => (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-10 text-sm text-muted-foreground">{msg}</div>
  );
  if (!orgId) return notice('No Xero organisation is linked yet — connect one under Connections to load categories.');
  if (isLoading) return notice('Loading categories from Xero…');
  if (isError) {
    return notice(/** @type {any} */ (error)?.code === 'xero_not_configured'
      ? 'Xero isn’t connected on the server yet.'
      : 'Could not load categories from Xero.');
  }

  const q = query.trim().toLowerCase();
  const rows = (categories || []).filter((c) => !q || c.name.toLowerCase().includes(q) || (c.code || '').toLowerCase().includes(q));
  const descOf = (c) => (edits[c.id] !== undefined ? edits[c.id] : c.description);
  const dirty = (c) => edits[c.id] !== undefined && edits[c.id] !== c.description;
  const setDesc = (id, v) => { setEdits((e) => ({ ...e, [id]: v })); setStatus((s) => ({ ...s, [id]: undefined })); };

  const save = async (c) => {
    setStatus((s) => ({ ...s, [c.id]: 'saving' }));
    try {
      const updated = await updateXeroCategoryDescription(orgId, c.id, { name: c.name, code: c.code, description: edits[c.id] });
      qc.setQueryData(['xero-categories', orgId], (prev) => (/** @type {any[]} */ (prev) || []).map((x) => (x.id === c.id ? { ...x, description: (updated && updated.description) ?? edits[c.id] } : x)));
      setEdits((e) => { const n = { ...e }; delete n[c.id]; return n; });
      setStatus((s) => ({ ...s, [c.id]: 'saved' }));
    } catch (err) {
      setErrMsg((m) => ({ ...m, [c.id]: (err && err.message) || 'Update failed' }));
      setStatus((s) => ({ ...s, [c.id]: 'error' }));
    }
  };

  return (
    <div>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        Categories are your connected Xero organisation’s expense accounts. Edit a <span className="font-medium text-foreground">Description</span> and Save to write it straight back to Xero.
      </p>
      <div className="mb-3 flex items-center">
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name or code" className="h-8 w-64 rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[440px] text-sm">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            {/* Description is the greedy column (w-full) so it fills the row; the
                others shrink to their content. */}
            <tr><th className="whitespace-nowrap px-3 py-2.5 font-medium">Code</th><th className="whitespace-nowrap px-3 py-2.5 font-medium">Name</th><th className="w-full px-3 py-2.5 font-medium">Description</th><th className="w-24 px-3 py-2.5" /></tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-b align-top last:border-0 hover:bg-muted/40">
                <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{c.code || '—'}</td>
                <td className="px-3 py-3 font-medium">{c.name}</td>
                <td className="px-3 py-2">
                  <input value={descOf(c)} onChange={(e) => setDesc(c.id, e.target.value)} placeholder="Add a description…" className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                  {status[c.id] === 'error' && <p className="mt-1 text-xs text-destructive">{errMsg[c.id]}</p>}
                  {status[c.id] === 'saved' && <p className="mt-1 text-xs text-muted-foreground">Saved to Xero.</p>}
                </td>
                <td className="px-3 py-2">
                  <button type="button" onClick={() => save(c)} disabled={!dirty(c) || status[c.id] === 'saving'} className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50">
                    {status[c.id] === 'saving' ? 'Saving…' : 'Save'}
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">No categories{q ? ' match your search' : ''}.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Showing {rows.length} of {(categories || []).length} categories</p>
    </div>
  );
}

function TaxRatesList() {
  // The live Xero purchase rates (seed fallback) — the SAME source the cost/sales
  // pickers use — so switching a rate's Visible off here removes it there.
  const rows = useManagedTaxRates();
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
        <table className="w-full min-w-[560px] text-sm">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            <tr><th className="w-10 px-3 py-2.5" /><th className="px-3 py-2.5 font-medium">Name</th><th className="px-3 py-2.5 font-medium">Code</th><th className="px-3 py-2.5 font-medium">Rate %</th><th className="px-3 py-2.5 font-medium">Visible</th></tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-b last:border-0 hover:bg-muted/40">
                <td className="px-3 py-3"><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} className="h-4 w-4 accent-black" /></td>
                <td className="px-3 py-3 font-medium">{r.name}</td>
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

// Projects = a Xero tracking category. `index` 0 → the first tracking category
// (Projects), 1 → the second (Projects 2). The rows are that category's tracking
// options, pulled live from the ACTIVE organisation's Xero — so each org shows
// its own tracking (e.g. CYBM's, not another entity's). Read-only here; options
// are managed in Xero.
function ProjectsFromXero({ index }) {
  const { data: organisations = [] } = useOrganisations();
  const orgId = (organisations.find((o) => o.id === getActiveOrganisationId()) || organisations[0])?.id || '';
  const { data: categories, isLoading, isError, error } = useXeroTracking(orgId);
  const [query, setQuery] = useState('');

  const notice = (msg) => (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-10 text-sm text-muted-foreground">{msg}</div>
  );

  if (!orgId) return notice('No Xero organisation is linked yet — connect one under Connections to load tracking categories.');
  if (isLoading) return notice('Loading tracking categories from Xero…');
  if (isError) {
    return notice(/** @type {any} */ (error)?.code === 'xero_not_configured'
      ? 'Xero isn’t connected on the server yet.'
      : 'Could not load tracking categories from Xero.');
  }
  const cat = (categories || [])[index];
  if (!cat) return notice(`The connected Xero organisation has no ${index === 0 ? 'first' : 'second'} tracking category.`);

  const q = query.trim().toLowerCase();
  const options = cat.options.filter((o) => !q || o.name.toLowerCase().includes(q));

  return (
    <div>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        Tracking category <span className="font-medium text-foreground">{cat.name}</span>, synced from the connected Xero organisation. Its options are managed in Xero.
      </p>
      <div className="mb-3 flex items-center">
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name" className="h-8 w-56 rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[360px] text-sm">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            <tr><th className="px-3 py-2.5 font-medium">Option</th></tr>
          </thead>
          <tbody>
            {options.map((o) => (
              <tr key={o.id} className="border-b last:border-0 hover:bg-muted/40">
                <td className="px-3 py-3 font-medium">{o.name}</td>
              </tr>
            ))}
            {options.length === 0 && (
              <tr><td className="px-3 py-8 text-center text-muted-foreground">No options{q ? ' match your search' : ' in this tracking category'}.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Showing {options.length} of {cat.options.length} options</p>
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

// Organisation-level context + GST/coding overrides for the extraction AI. A
// business overview + rules, passed to the model alongside each document and the
// Xero chart of accounts. Saved per organisation.
function ReviewInstructions() {
  const { data: organisations = [] } = useOrganisations();
  const org = organisations.find((o) => o.id === getActiveOrganisationId()) || organisations[0];
  const orgId = org ? org.id : '';
  const { text, setText, loading } = useReviewInstructions(orgId);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setSaving(true);
    await saveReviewInstructions(orgId, text);
    setSaving(false);
    setSaved(true);
  };

  if (!orgId) {
    return (
      <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-10 text-sm text-muted-foreground">
        No organisation is linked yet — connect one under Connections first.
      </div>
    );
  }

  return (
    <div>
      <p className="mb-3 max-w-3xl text-sm text-muted-foreground">
        A high-level overview of {org && org.name ? org.name : 'this organisation'}’s business, plus any GST and coding overrides. This is passed to the AI alongside each uploaded document and the Xero chart of accounts, so it picks the best account code and applies your GST rules. Saved per organisation.
      </p>
      <textarea
        value={loading ? '' : text}
        onChange={(e) => { setText(e.target.value); setSaved(false); }}
        rows={16}
        placeholder={loading ? 'Loading…' : 'e.g. Excellence A.S runs a beauty facial and cosmetic retail business. The outlets are at Vivocity and CK Tangs. Vendor name should be the other identified party.\n\nGST overriding instructions — discard the GST amount and substitute "0" for: any activity involving a motor vehicle; medical treatment for employees; …'}
        className="w-full rounded-lg border bg-background p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="mt-3 flex items-center justify-end gap-3">
        {saved && <span className="text-sm text-muted-foreground">Saved.</span>}
        <button
          type="button"
          onClick={save}
          disabled={saving || loading}
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save instructions'}
        </button>
      </div>
    </div>
  );
}

// Read-only list of the payment methods derived from Xero (bank + payment-
// enabled accounts). The document "Payment method" dropdown uses the same source.
function PaymentMethodsFromXero() {
  const methods = useXeroPaymentMethods();
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Payment methods come from your linked Xero organisation — every bank account and any account
        enabled for payments. Manage them in Xero; they refresh here automatically.
      </p>
      {methods.length === 0 ? (
        <div className="rounded-lg border bg-muted/30 px-4 py-10 text-sm text-muted-foreground">
          No payment methods yet. Connect a Xero organisation with bank or payment-enabled accounts,
          or add one from a document’s Payment method field.
        </div>
      ) : (
        <ul className="divide-y rounded-lg border">
          {methods.map((m) => (
            <li key={m.label} className="px-4 py-2.5 text-sm">{m.label}</li>
          ))}
        </ul>
      )}
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
        {tab === 'categories' ? <CategoriesFromXero /> : tab === 'review' ? <ReviewInstructions /> : tab === 'taxRates' ? <TaxRatesList /> : tab === 'projects' ? <ProjectsFromXero index={0} /> : tab === 'projects2' ? <ProjectsFromXero index={1} /> : tab === 'flags' ? <FlagsList /> : tab === 'payment' ? <PaymentMethodsFromXero /> : <Placeholder label={TITLES[tab]} />}
      </div>
    </div>
  );
}
