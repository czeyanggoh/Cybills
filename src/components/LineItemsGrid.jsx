import { useState } from 'react';
import { Loader2, Maximize2, Plus, Search, Sparkles, Trash2, X } from 'lucide-react';
import ComboSelect from '@/components/ComboSelect';
import { formatCategory } from '@/lib/categoryDisplay';
import { cn } from '@/lib/utils';

// A document's per-line breakdown. One grid, rendered in two places: inline in
// the Details tab, where it shares the panel with everything else, and in the
// full-screen editor below, where a long invoice can actually be read. Both are
// the same component so the columns can never drift apart.

const num = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;

// A line's tracking-category picker. Blank is meaningful — it means "whatever
// the document says" — so the empty option says so rather than reading as an
// unfilled field.
function LineProjectSelect({ value, options, placeholder = 'None', onChange }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'h-8 w-full min-w-[8rem] rounded border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
        !value && 'text-muted-foreground'
      )}
    >
      <option value="">{placeholder}</option>
      {Array.from(new Set([value, ...options].filter(Boolean))).map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );
}

export function LineItemsGrid({
  rows,
  total,
  onUpdate,
  onRemove,
  categoryOptions = [],
  catMode,
  lineProjects = [],
  project2Options = [],
  docProject = '',
  // Row indexes to show, in order. Omitted = all of them. The grid always edits
  // by the row's REAL index, so filtering can never write to the wrong line.
  visible = null,
  expanded = false,
}) {
  if (!rows.length) return null;
  const lineTotal = rows.reduce((s, li) => s + num(li.total), 0);
  const outBy = num(total) - lineTotal;
  const labelSpan = 4 + (lineProjects.length > 0 ? 1 : 0) + (project2Options.length > 0 ? 1 : 0);
  const shown = visible ?? rows.map((_, i) => i);

  return (
    <div className={cn('overflow-x-auto rounded-md border', expanded && 'h-full overflow-y-auto')}>
      <table className="w-full text-sm">
        <thead className={cn(expanded && 'sticky top-0 z-10')}>
          <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <th className="bg-muted/40 px-2 py-2 font-medium">Description</th>
            <th className="bg-muted/40 px-2 py-2 font-medium">Category</th>
            {lineProjects.length > 0 && <th className="bg-muted/40 px-2 py-2 font-medium">Project</th>}
            {project2Options.length > 0 && <th className="bg-muted/40 px-2 py-2 font-medium">Project 2</th>}
            <th className="bg-muted/40 px-2 py-2 text-right font-medium">Net</th>
            <th className="bg-muted/40 px-2 py-2 text-right font-medium">Tax</th>
            <th className="bg-muted/40 px-2 py-2 text-right font-medium">Total</th>
            <th className="w-8 bg-muted/40" />
          </tr>
        </thead>
        <tbody>
          {shown.map((i) => {
            const li = rows[i];
            return (
              <tr key={i} className="border-b last:border-0 align-top">
                <td className="px-2 py-1.5">
                  <input
                    value={li.description || ''}
                    onChange={(e) => onUpdate(i, { description: e.target.value })}
                    className={cn(
                      'h-8 w-full rounded border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      expanded ? 'min-w-[18rem]' : 'min-w-[9rem]'
                    )}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <ComboSelect
                    size="sm"
                    aria-label="Line item category"
                    value={li.category || ''}
                    options={Array.from(new Set([li.category, ...categoryOptions].filter(Boolean)))}
                    onChange={(v) => onUpdate(i, { category: v })}
                    format={(c) => formatCategory(c, catMode)}
                  />
                </td>
                {lineProjects.length > 0 && (
                  <td className="px-2 py-1.5">
                    <LineProjectSelect
                      value={li.project || ''}
                      options={lineProjects}
                      placeholder={docProject ? 'Same as document' : 'None'}
                      onChange={(v) => onUpdate(i, { project: v })}
                    />
                  </td>
                )}
                {project2Options.length > 0 && (
                  <td className="px-2 py-1.5">
                    <LineProjectSelect
                      value={li.project2 || ''}
                      options={project2Options}
                      onChange={(v) => onUpdate(i, { project2: v })}
                    />
                  </td>
                )}
                {['net', 'tax', 'total'].map((f) => (
                  <td key={f} className="px-2 py-1.5">
                    <input
                      value={li[f] || ''}
                      inputMode="decimal"
                      onChange={(e) => onUpdate(i, { [f]: e.target.value })}
                      className="h-8 w-20 rounded border bg-background px-2 text-right text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </td>
                ))}
                <td className="px-1 py-1.5 text-center">
                  <button type="button" onClick={() => onRemove(i)} aria-label="Remove line" className="text-muted-foreground transition-colors hover:text-destructive">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            );
          })}
          {shown.length === 0 && (
            <tr>
              <td colSpan={labelSpan + 2} className="px-2 py-6 text-center text-xs text-muted-foreground">
                No line matches that search.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot className={cn(expanded && 'sticky bottom-0')}>
          <tr className="border-t bg-muted/20 text-xs">
            <td className="bg-muted/20 px-2 py-2 font-medium" colSpan={labelSpan}>Item total</td>
            <td className="bg-muted/20 px-2 py-2 text-right font-semibold">{lineTotal.toFixed(2)}</td>
            <td className="bg-muted/20" />
          </tr>
          <tr className="bg-background text-xs">
            <td className={cn('bg-background px-2 py-2 font-medium', Math.abs(outBy) > 0.005 && 'text-destructive')} colSpan={labelSpan}>
              Out by
            </td>
            <td className={cn('bg-background px-2 py-2 text-right font-semibold', Math.abs(outBy) > 0.005 && 'text-destructive')}>
              {outBy.toFixed(2)}
            </td>
            <td className="bg-background" />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// The Extract / Create / Expand row that sits under the grid.
export function LineItemsActions({ onExtract, onAdd, onExpand, extracting, visionEnabled, canExpand }) {
  return (
    <>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onExtract}
          disabled={extracting || !visionEnabled}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {extracting ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Extracting…</> : <><Sparkles className="h-3.5 w-3.5" /> Extract line items</>}
        </button>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
        >
          <Plus className="h-3.5 w-3.5" /> Create line item
        </button>
        {canExpand && (
          <button
            type="button"
            onClick={onExpand}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
          >
            <Maximize2 className="h-3.5 w-3.5" /> Expand
          </button>
        )}
      </div>
      {!visionEnabled && (
        <p className="mt-1 text-xs text-muted-foreground">
          Line-item extraction needs a reader API key on the server (
          <span className="font-mono">ANTHROPIC_API_KEY</span> or{' '}
          <span className="font-mono">OPENAI_API_KEY</span>). You can still add lines manually.
        </p>
      )}
    </>
  );
}

// Full-screen line-item editor. The Details panel is a third of the window and
// the grid scrolls sideways inside it, which is no way to check fourteen rows
// against the paper they came from — so this gives the table the whole window,
// with the document above it and a search for finding one row among many.
// Every edit goes straight back to the same state the panel edits, so there is
// nothing to save and Done just closes it.
export function LineItemsEditor({ open, onClose, title, preview, actions, ...grid }) {
  const [showPreview, setShowPreview] = useState(true);
  const [q, setQ] = useState('');
  if (!open) return null;

  const needle = q.trim().toLowerCase();
  const visible = needle
    ? grid.rows
        .map((li, i) => i)
        .filter((i) => `${grid.rows[i].description || ''} ${grid.rows[i].category || ''}`.toLowerCase().includes(needle))
    : null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <h2 className="truncate text-base font-semibold tracking-tight">Line items{title ? ` · ${title}` : ''}</h2>
        <span className="text-xs text-muted-foreground">{grid.rows.length} line{grid.rows.length === 1 ? '' : 's'}</span>
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search lines"
            className="h-8 w-52 rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        {preview && (
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
          >
            {showPreview ? 'Hide document' : 'Show document'}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          <X className="h-3.5 w-3.5" /> Done
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {preview && showPreview && <div className="h-[38%] min-h-0 shrink-0 overflow-auto">{preview}</div>}
        <div className="min-h-0 flex-1">
          <LineItemsGrid {...grid} visible={visible} expanded />
        </div>
        {/* Adding or re-reading a line shouldn't mean closing the editor first. */}
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
