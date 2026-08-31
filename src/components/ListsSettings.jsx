import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X, Search, Trash2, Flag } from 'lucide-react';
import { addToList, removeFromList, renameInList, setListVisible, setMetaField, useHiddenSet, useList, useMeta } from '@/lib/listsStore';
import { useFlags, updateFlag } from '@/lib/flagsStore';
import { useOrganisations, useXeroTracking, useXeroCategories, useTargetAccounts, updateXeroCategoryDescription, getActiveOrganisationId, isStandaloneOrg, useXeroPaymentMethods, useManagedTaxRates } from '@/lib/organisations';
import { useCategoryAccounts, setCategoryAccount } from '@/lib/categoryAccounts';
import { useReviewInstructions, saveReviewInstructions } from '@/lib/reviewInstructions';
import { useProjectLabels, setProjectLabels, DEFAULT_PROJECT_LABELS, singular } from '@/lib/projectLabels';
import { cn } from '@/lib/utils';
import { useAutoSave } from '@/lib/useAutoSave';
import SaveStatus from '@/components/SaveStatus';

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

// One category's Description, written straight back to Xero when the user stops
// typing. Longer debounce than a local field — every save is a round trip to
// Xero through the relay, so we wait for a real pause.
function CategoryDescriptionCell({ category, orgId, onSaved }) {
  const [draft, setDraft] = useState(category.description || '');
  const [error, setError] = useState('');
  useEffect(() => { setDraft(category.description || ''); }, [category.description]);
  const status = useAutoSave(
    draft,
    async (value) => {
      setError('');
      try {
        const updated = await updateXeroCategoryDescription(orgId, category.id, {
          name: category.name,
          code: category.code,
          description: value,
        });
        onSaved(category.id, (updated && updated.description) ?? value);
      } catch (err) {
        setError((err && err.message) || 'Update failed');
        throw err; // keeps the status on 'error' — retried on the next edit
      }
    },
    { delay: 1200 },
  );
  return (
    <div>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Add a description…"
        className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {error ? (
        <p className="mt-1 text-xs text-destructive">{error}</p>
      ) : (
        <SaveStatus status={status} className="mt-1" />
      )}
    </div>
  );
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
  // Visibility is CYBills-side (Xero has no such flag), keyed by account CODE —
  // the one field the categories endpoint and the accounts endpoint share, so a
  // category switched off here also leaves the document pickers and the
  // extractor's allowed list.
  const hidden = useHiddenSet('categories');
  // Adopt a saved description into the react-query cache so the row doesn't
  // snap back to the old text on the next render.
  const adopt = (id, description) =>
    qc.setQueryData(['xero-categories', orgId], (prev) =>
      (/** @type {any[]} */ (prev) || []).map((x) => (x.id === id ? { ...x, description } : x)));

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
  const visKey = (c) => c.code || c.name;


  return (
    <div>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        Categories are your connected Xero organisation’s expense accounts. Edit a <span className="font-medium text-foreground">Description</span> and it writes straight back to Xero on its own. Switch{' '}
        <span className="font-medium text-foreground">Visible</span> off to drop a category from the document pickers and stop CYBills coding anything to it — the account stays untouched in Xero.
      </p>
      <div className="mb-3 flex items-center">
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name or code" className="h-8 w-64 rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[620px] text-sm">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            {/* Description is the greedy column (w-full) so it fills the row; the
                others shrink to their content. */}
            <tr><th className="whitespace-nowrap px-3 py-2.5 font-medium">Code</th><th className="whitespace-nowrap px-3 py-2.5 font-medium">Name</th><th className="w-full px-3 py-2.5 font-medium">Description</th><th className="whitespace-nowrap px-3 py-2.5 font-medium">Visible</th></tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-b align-top last:border-0 hover:bg-muted/40">
                <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{c.code || '—'}</td>
                <td className="px-3 py-3 font-medium">{c.name}</td>
                <td className="px-3 py-2">
                  <CategoryDescriptionCell category={c} orgId={orgId} onSaved={adopt} />
                </td>
                <td className="px-3 py-3">
                  <VisibleToggle on={!hidden.has(visKey(c))} onToggle={() => setListVisible('categories', visKey(c), hidden.has(visKey(c)))} />
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

// Categories for a BRIDGE entity — one with no Xero of its own, so there is no
// chart to read. The list is CYBills' own: the seed from the client's claim
// form plus whatever this entity adds, each row switchable off.
//
// The "Posts to" column is the whole reason a bridge can publish at all. A claim
// raised here is paid out of the PARENT's ledger, and Xero needs an account
// code — so each plain name is mapped once, here, by whoever knows both sides.
// A category with no mapping is not silently dropped at publish time: the claim
// is refused and the category named.
function CategoriesFromList({ organisation }) {
  const rows = useList('categories');
  const map = useCategoryAccounts();
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [bulkCode, setBulkCode] = useState('');
  const { selected, toggle, clear } = useSelection();

  // The parent is named by the SERVER, not looked up in this user's own list of
  // entities: the people administering a bridge entity usually can't open its
  // parent, so searching that list found nothing and the tab announced that no
  // parent was set — on an entity that plainly had one.
  const parentName = organisation.parentName || '';
  const { data, isLoading, isError } = useTargetAccounts(organisation.id);
  const accounts = data?.accounts ?? [];
  // NOT expense accounts only. A reimbursement arrangement is very often booked
  // to a clearing account — "Reimbursements - ST Engineering" is a LIABILITY,
  // money owed to the people claiming — and filtering to expense types hid the
  // one account this entity is supposed to use, from a list of sixty it isn't.
  // A Xero bill line can post to any account except a bank one.
  const postable = accounts.filter((a) => String(a.type || '').toUpperCase() !== 'BANK');
  const isExpense = (a) => ['EXPENSE', 'OVERHEADS', 'DIRECTCOSTS'].includes(String(a.type || '').toUpperCase());
  const asOption = (a) => ({ code: a.code, label: `${a.code} - ${a.name}` });
  // Expenses first, because that is what most categories want; everything else
  // is still there, under its own heading, for the ones that don't.
  // The accounts this entity ALREADY posts to come first, most-used first. A
  // bridge arrangement books to one or two accounts out of a chart of sixty, so
  // after the first choice the right one should never have to be hunted for
  // again — and which one that is belongs to the entity, not to a hard-coded
  // list of somebody's account codes.
  const useCount = new Map();
  for (const code of Object.values(map)) {
    const key = String(code || '');
    if (key) useCount.set(key, (useCount.get(key) || 0) + 1);
  }
  const usedOptions = postable
    .filter((a) => useCount.has(String(a.code)))
    .sort((a, b) => (useCount.get(String(b.code)) || 0) - (useCount.get(String(a.code)) || 0)
      || String(a.code).localeCompare(String(b.code)))
    .map(asOption);
  const rest = postable.filter((a) => !useCount.has(String(a.code)));
  const expenseOptions = rest.filter(isExpense).map(asOption);
  const otherOptions = rest.filter((a) => !isExpense(a)).map(asOption);
  const options = [...usedOptions, ...expenseOptions, ...otherOptions];
  const group = (label, list) =>
    list.length > 0 && (
      <optgroup label={label}>
        {list.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
      </optgroup>
    );
  const optionGroups = (
    <>
      {group('Used here', usedOptions)}
      {group('Expenses', expenseOptions)}
      {group('Other accounts', otherOptions)}
    </>
  );

  const q = query.trim().toLowerCase();
  const filtered = rows.filter((r) => !q || r.name.toLowerCase().includes(q));
  // Every category posting to one account is the normal case, not the exception
  // — a bridge entity's whole expense line often lands in a single one. Setting
  // 23 dropdowns by hand to the same value is the kind of work nobody finishes.
  const applyBulk = (code) => {
    const targets = selected.size ? filtered.filter((r) => selected.has(r.id)) : filtered;
    targets.forEach((r) => setCategoryAccount(r.name, code));
    clear();
    setBulkCode('');
  };
  const allShown = filtered.length > 0 && filtered.every((r) => selected.has(r.id));

  return (
    <div>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{organisation.name}</span> has no accounting
        connection of its own, so its categories are plain names rather than a chart of accounts —
        the ones the people claiming here already recognise. Set{' '}
        <span className="font-medium text-foreground">Posts to</span> to say which{' '}
        {parentName ? <span className="font-medium text-foreground">{parentName}</span> : 'parent entity'}{' '}
        account each one becomes when a claim is published. A category with no account can’t be
        published — the claim is refused and says which ones need mapping, rather than posting for
        less than it’s worth.
      </p>
      <Toolbar
        hasSelection={selected.size > 0}
        onDelete={() => { removeFromList('categories', [...selected]); clear(); }}
        query={query}
        setQuery={setQuery}
      >
        <button type="button" onClick={() => setAddOpen(true)} className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted">Add category</button>
        {options.length > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">
              {selected.size ? `Posts to (${selected.size} selected)` : 'Posts to (all shown)'}
            </span>
            <select
              value={bulkCode}
              onChange={(e) => { if (e.target.value) applyBulk(e.target.value); }}
              className="h-8 w-56 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Set them all to…</option>
              {optionGroups}
            </select>
          </label>
        )}
      </Toolbar>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="w-10 px-3 py-2.5">
                <input
                  type="checkbox"
                  aria-label="Select all categories"
                  checked={allShown}
                  onChange={() => (allShown ? clear() : filtered.forEach((r) => { if (!selected.has(r.id)) toggle(r.id); }))}
                  className="h-4 w-4 accent-black"
                />
              </th>
              <th className="w-full px-3 py-2.5 font-medium">Name</th>
              <th className="whitespace-nowrap px-3 py-2.5 font-medium">Posts to</th>
              <th className="whitespace-nowrap px-3 py-2.5 font-medium">Visible</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-b align-middle last:border-0 hover:bg-muted/40">
                <td className="px-3 py-3"><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} className="h-4 w-4 accent-black" /></td>
                <td className="px-3 py-3 font-medium">{r.name}</td>
                <td className="px-3 py-2">
                  {options.length ? (
                    <select
                      value={map[r.name] || ''}
                      onChange={(e) => setCategoryAccount(r.name, e.target.value)}
                      className="h-9 w-64 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="">Not mapped</option>
                      {optionGroups}
                    </select>
                  ) : (
                    // The parent's chart is what fills this dropdown, so when it
                    // can't be loaded the mapping already saved still has to be
                    // legible — otherwise a mapped category looks unmapped.
                    <span className="text-xs text-muted-foreground">
                      {isLoading
                        ? 'Loading accounts…'
                        : map[r.name]
                          ? `Account ${map[r.name]}${isError ? ' — accounts unavailable, so it can’t be changed here' : ''}`
                          : `Couldn’t load ${parentName || 'the parent entity'}’s accounts.`}
                    </span>
                  )}
                </td>
                <td className="px-3 py-3"><VisibleToggle on={r.visible} onToggle={() => setListVisible('categories', r.id, !r.visible)} /></td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">No categories{q ? ' match your search' : ''}.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Showing {filtered.length} of {rows.length} categories · {rows.filter((r) => r.visible && !map[r.name]).length} not mapped to an account
      </p>
      <AddDialog
        open={addOpen}
        title="Add category"
        fields={[{ key: 'name', label: 'Name', placeholder: 'e.g. Transport - Taxi' }]}
        required={['name']}
        onClose={() => setAddOpen(false)}
        onAdd={(f) => addToList('categories', { name: f.name.trim(), code: '' })}
      />
    </div>
  );
}

// Which Categories tab this entity gets: a bridge entity keeps its own list,
// everything else reads its Xero chart.
function Categories() {
  const { data: organisations = [] } = useOrganisations();
  const organisation = organisations.find((o) => o.id === getActiveOrganisationId()) || null;
  if (isStandaloneOrg(organisation)) return <CategoriesFromList organisation={organisation} />;
  return <CategoriesFromXero />;
}

// The "when to use" rule for one row. Free text the org writes itself — it rides
// along to the extractor, which may pick the row whose rule clearly matches the
// document. Used by Tax rates (where the arithmetic fallback only ever reaches
// the standard-rated codes and No Tax) and by Projects (where the fallback is
// the uploader's own assigned project). Auto-saved, keyed by name.
function RulesCell({ row, kind = 'taxRates', placeholder = 'When should this code be used?' }) {
  const [draft, setDraft] = useState(row.rules || '');
  // Re-sync when the stored value changes underneath us (another tab, a refetch).
  useEffect(() => { setDraft(row.rules || ''); }, [row.rules]);
  const status = useAutoSave(draft, (v) => setMetaField(kind, row.id, 'rules', v.trim()));
  return (
    <div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={2}
        placeholder={placeholder}
        className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />
      <SaveStatus status={status} className="mt-1" />
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
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        Tax rates come from your connected Xero organisation. Write a{' '}
        <span className="font-medium text-foreground">When to use</span> rule to teach CYBills when a
        code applies — e.g. “Overseas supplier billing services performed in Singapore — reverse
        charge.” Documents matching a rule are coded to it automatically; codes with no rule are only
        auto-picked when the printed GST matches a standard rate.
      </p>
      <Toolbar
        hasSelection={selected.size > 0}
        onDelete={() => { removeFromList('taxRates', [...selected]); clear(); }}
        query={query}
        setQuery={setQuery}
      >
        <button type="button" onClick={() => setAddOpen(true)} className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted">Add tax rate</button>
      </Toolbar>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            {/* "When to use" is the greedy column (w-full); the rest shrink. */}
            <tr><th className="w-10 px-3 py-2.5" /><th className="whitespace-nowrap px-3 py-2.5 font-medium">Name</th><th className="whitespace-nowrap px-3 py-2.5 font-medium">Code</th><th className="whitespace-nowrap px-3 py-2.5 font-medium">Rate %</th><th className="w-full min-w-[280px] px-3 py-2.5 font-medium">When to use</th><th className="whitespace-nowrap px-3 py-2.5 font-medium">Visible</th></tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-b align-top last:border-0 hover:bg-muted/40">
                <td className="px-3 py-3"><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} className="h-4 w-4 accent-black" /></td>
                <td className="px-3 py-3 font-medium">{r.name}</td>
                <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{r.code}</td>
                <td className="px-3 py-3 tabular-nums">{Number(r.rate).toFixed(1)}</td>
                <td className="px-3 py-2"><RulesCell row={r} /></td>
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
        fields={[{ key: 'name', label: 'Name' }, { key: 'code', label: 'Code' }, { key: 'rate', label: 'Rate %', type: 'number', placeholder: '0.0' }, { key: 'rules', label: 'When to use (optional)', placeholder: 'When should this code be used?' }]}
        required={['name', 'code']}
        onClose={() => setAddOpen(false)}
        onAdd={(f) => {
          const name = f.name.trim();
          addToList('taxRates', { name, id: (f.code || '').trim().toUpperCase(), code: (f.code || '').trim().toUpperCase(), rate: Number(f.rate) || 0 });
          if ((f.rules || '').trim()) setMetaField('taxRates', name, 'rules', f.rules.trim());
        }}
      />
    </div>
  );
}

// Which of the two a project tab shows, and the control that renames it.
// An entity with Xero reads its tracking categories from there and can't invent
// options here; a bridge entity keeps the list itself. Either way the LABEL is
// the entity's, because the word is about what the list is FOR, not where it
// comes from.
function ProjectsTab({ index, bridge, label }) {
  return (
    <div>
      <ListNameField index={index} label={label} />
      {bridge ? <ProjectsFromList index={index} label={label} /> : <ProjectsFromXero index={index} />}
    </div>
  );
}

// Rename the list itself. "Projects" is Xero's word for a tracking category and
// is right for an entity that has one; Red Alpha's holds secondment PO numbers,
// and a column called Projects sent people looking for something that is not
// there. Only the word changes — the field stays `project` on the document, in
// the API, in the CSV headers and in the Xero tracking category it posts to.
function ListNameField({ index, label }) {
  const key = index === 0 ? 'project' : 'project2';
  const fallback = index === 0 ? DEFAULT_PROJECT_LABELS.project : DEFAULT_PROJECT_LABELS.project2;
  const [value, setValue] = useState(label);
  const ref = useRef(null);
  useEffect(() => { setValue(label); }, [label]);
  const commit = () => {
    const next = value.trim() || fallback;
    setValue(next);
    if (next !== label) setProjectLabels({ [key]: next });
  };
  return (
    <label className="mb-4 flex flex-wrap items-center gap-3 text-sm">
      <span className="text-muted-foreground">What this entity calls this list</span>
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          // Commit outright rather than leaning on blur to do it: Enter is how
          // most people finish a field, and a rename that needs a click
          // somewhere else to take is a rename that looks like it didn't.
          if (e.key === 'Enter') { e.preventDefault(); commit(); ref.current?.blur(); }
          if (e.key === 'Escape') { setValue(label); ref.current?.blur(); }
        }}
        placeholder={fallback}
        aria-label="List name"
        className="h-9 w-56 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <span className="text-xs text-muted-foreground">
        Shown wherever this list appears. Blank goes back to &ldquo;{fallback}&rdquo;.
      </span>
    </label>
  );
}

// Projects for an entity with no Xero — the bridge case. There are no tracking
// categories to read, so the list is the entity's own: added, renamed, hidden
// and deleted here, the way its Categories already are.
//
// It exists because the tab could only ever say "Could not load tracking
// categories from Xero" for these entities, which is true and useless: there is
// no Xero to load them from and never will be. Red Alpha's projects are
// secondment PO numbers its own admins keep.
//
// The LABEL is the entity's too (see projectLabels.js) — the stored field stays
// `project` / `project2`, only the word on screen changes.
function ProjectsFromList({ index, label }) {
  const kind = index === 0 ? 'projects' : 'projects2';
  const rows = useList(kind);
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const { selected, toggle, clear } = useSelection();
  const meta = useMeta(kind);

  const q = query.trim().toLowerCase();
  const filtered = rows
    .filter((r) => !q || r.name.toLowerCase().includes(q))
    .map((r) => ({ ...r, rules: meta[r.name]?.rules || '' }));
  const allShown = filtered.length > 0 && filtered.every((r) => selected.has(r.id));
  const one = singular(label);

  return (
    <div>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        This entity has no accounting connection, so {label} is a list it keeps itself — add, rename
        or hide them here and they become the options on every document.
        {index === 0 && (
          <>
            {' '}CYBills allocates a document to the one it plainly belongs to — by name, or by a{' '}
            <span className="font-medium text-foreground">When to use</span> rule you write for the
            cases a name can&rsquo;t settle.
          </>
        )}
      </p>
      <Toolbar
        hasSelection={selected.size > 0}
        onDelete={() => { removeFromList(kind, [...selected]); clear(); }}
        query={query}
        setQuery={setQuery}
      >
        <button type="button" onClick={() => setAddOpen(true)} className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted">Add {one.toLowerCase()}</button>
      </Toolbar>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="w-10 px-3 py-2.5">
                <input
                  type="checkbox"
                  aria-label={`Select all ${label}`}
                  checked={allShown}
                  onChange={() => (allShown ? clear() : filtered.forEach((r) => { if (!selected.has(r.id)) toggle(r.id); }))}
                  className="h-4 w-4 accent-black"
                />
              </th>
              <th className="w-64 whitespace-nowrap px-3 py-2.5 font-medium">Name</th>
              <th className="w-full px-3 py-2.5 font-medium">When to use?</th>
              <th className="whitespace-nowrap px-3 py-2.5 font-medium">Visible</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-b align-middle last:border-0 hover:bg-muted/40">
                <td className="px-3 py-3"><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} className="h-4 w-4 accent-black" /></td>
                <td className="px-3 py-2"><NameCell row={r} kind={kind} /></td>
                <td className="px-3 py-2">
                  <RulesCell row={r} kind={kind} placeholder={`When should this ${one.toLowerCase()} be used?`} />
                </td>
                <td className="px-3 py-3"><VisibleToggle on={r.visible} onToggle={() => setListVisible(kind, r.id, !r.visible)} /></td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">No {label.toLowerCase()}{q ? ' match your search' : ' yet — add the first one'}.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Showing {filtered.length} of {rows.length} items</p>
      <AddDialog
        open={addOpen}
        title={`Add ${one.toLowerCase()}`}
        fields={[{ key: 'name', label: 'Name', placeholder: 'e.g. ASTP 01' }]}
        required={['name']}
        onClose={() => setAddOpen(false)}
        onAdd={(f) => addToList(kind, { name: f.name.trim() })}
      />
    </div>
  );
}

// An editable name, saved when it loses focus or on Enter. Dext edits these in
// place rather than behind a dialog, and so does the Categories tab's own
// "Posts to" — a rename is a correction, not a decision worth a modal.
function NameCell({ row, kind }) {
  const [value, setValue] = useState(row.name);
  const ref = useRef(null);
  useEffect(() => { setValue(row.name); }, [row.name]);
  const commit = () => {
    const next = value.trim();
    if (!next) { setValue(row.name); return; }
    if (next !== row.name) renameInList(kind, row.id, next);
  };
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); ref.current?.blur(); }
        if (e.key === 'Escape') { setValue(row.name); ref.current?.blur(); }
      }}
      aria-label="Name"
      className="h-9 w-full min-w-[11rem] rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
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
  // Rules live under their own kind per tracking category, so Projects and
  // Projects 2 can't overwrite each other's notes for a same-named option.
  const metaKind = index === 0 ? 'projects' : 'projects2';
  const meta = useMeta(metaKind);

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
  const options = (cat.options || [])
    .filter((o) => !q || String(o.name || '').toLowerCase().includes(q))
    // The rule is CYBills-side (Xero has no such field), keyed by option NAME.
    .map((o) => ({ ...o, id: o.name, rules: meta[o.name]?.rules || '' }));

  return (
    <div>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        Tracking category <span className="font-medium text-foreground">{cat.name}</span>, synced from the connected Xero organisation. Its options are managed in Xero.
        {index === 0 ? (
          <>
            {' '}CYBills allocates a document to the option it plainly belongs to — by name, or by a{' '}
            <span className="font-medium text-foreground">When to use</span> rule you write here for the cases a name can&apos;t settle. Nothing on the document pointing to one? It falls back to the uploader&apos;s own project (Users → Project).
          </>
        ) : (
          <>
            {' '}Rules here are for reference only: a published bill is tagged with the first tracking category, so only those options reach Xero.
          </>
        )}
      </p>
      <div className="mb-3 flex items-center">
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name" className="h-8 w-56 rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="whitespace-nowrap px-3 py-2.5 font-medium">Option</th>
              <th className="w-full px-3 py-2.5 font-medium">When to use?</th>
            </tr>
          </thead>
          <tbody>
            {options.map((o) => (
              <tr key={o.id} className="border-b align-top last:border-0 hover:bg-muted/40">
                <td className="whitespace-nowrap px-3 py-3 font-medium">{o.name}</td>
                <td className="px-3 py-2">
                  <RulesCell row={o} kind={metaKind} placeholder="When should this project be used? e.g. “Documents for this site, client or cost centre”" />
                </td>
              </tr>
            ))}
            {options.length === 0 && (
              <tr><td colSpan={2} className="px-3 py-8 text-center text-muted-foreground">No options{q ? ' match your search' : ' in this tracking category'}.</td></tr>
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
  // Auto-saved like everything else. Held off until the org's text has loaded,
  // so the empty box we show while loading is never written back over it.
  const status = useAutoSave(text, (v) => saveReviewInstructions(orgId, v), {
    delay: 1000,
    enabled: !loading && Boolean(orgId),
  });

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
        onChange={(e) => setText(e.target.value)}
        rows={16}
        placeholder={loading ? 'Loading…' : 'e.g. Excellence A.S runs a beauty facial and cosmetic retail business. The outlets are at Vivocity and CK Tangs. Vendor name should be the other identified party.\n\nGST overriding instructions — discard the GST amount and substitute "0" for: any activity involving a motor vehicle; medical treatment for employees; …'}
        className="w-full rounded-lg border bg-background p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="mt-3 flex items-center justify-end gap-3">
        <SaveStatus status={status} />
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
  const bridge = isStandaloneOrg(
    (useOrganisations().data ?? []).find((o) => o.id === getActiveOrganisationId()),
  );
  // A bridge entity has no tax codes of its own — its claims post with No Tax at
  // the full amount — so a list of them is a list of somebody else's rates.
  const subnav = SUBNAV.filter((s) => !(bridge && s.key === 'taxRates'));
  // The two project lists are named by the entity, so the nav and the heading
  // say what it calls them rather than Xero's word for a tracking category.
  const labels = useProjectLabels();
  const nameFor = (key) => (key === 'projects' ? labels.project : key === 'projects2' ? labels.project2 : null);
  const TITLES = Object.fromEntries(SUBNAV.map((s) => [s.key, nameFor(s.key) || s.label]));

  return (
    <div className="flex gap-6">
      <div className="w-48 shrink-0">
        <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lists</p>
        <div className="flex flex-col text-sm">
          {subnav.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setTab(s.key)}
              className={cn('rounded-md px-3 py-2 text-left transition-colors', tab === s.key ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
            >
              {nameFor(s.key) || s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="mb-4 text-lg font-semibold tracking-tight">{TITLES[tab]}</h2>
        {tab === 'categories' ? <Categories /> : tab === 'review' ? <ReviewInstructions /> : tab === 'taxRates' ? <TaxRatesList /> : tab === 'projects' ? <ProjectsTab index={0} bridge={bridge} label={labels.project} /> : tab === 'projects2' ? <ProjectsTab index={1} bridge={bridge} label={labels.project2} /> : tab === 'flags' ? <FlagsList /> : tab === 'payment' ? <PaymentMethodsFromXero /> : <Placeholder label={TITLES[tab]} />}
      </div>
    </div>
  );
}
