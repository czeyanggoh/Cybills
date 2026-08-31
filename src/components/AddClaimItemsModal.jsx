import { useMemo, useState } from 'react';
import { X, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useCostsDocs, rowsFor, missingFields } from '@/lib/costsData';
import { addItemToClaim, docToClaimTxn } from '@/lib/claimStore';
import { updateBill, notifyBillsChanged } from '@/lib/bills';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

// Add items to a claim from the claim itself.
//
// "Add items" used to send you to the Costs inbox to tick documents there and
// come back through "Add to expense claim" — the same job, done from the far
// end, with the claim you were working on left behind. This is that list,
// brought to the claim: the documents that can still go on one, ticked and
// added in place.
//
// What may be offered is exactly what the Costs inbox's own claim action
// allows, so the two can't disagree: a cost document still in the INBOX (an
// archived one was set aside, one already on a claim is somebody else's line,
// a merged one is another document's money) and NOT published to Xero — that
// cost is in the ledger as its own bill, and claiming it as well would pay for
// it twice.
const norm = (s) => String(s ?? '').trim().toLowerCase();

export default function AddClaimItemsModal({ open, onClose, claim, onAdded }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { allDocs } = useCostsDocs();
  const [query, setQuery] = useState('');
  // A claim is one person's expenses, so their own documents are what somebody
  // is nearly always looking for — but only when there ARE any, since defaulting
  // to an empty list would read as "nothing to add".
  const [mine, setMine] = useState(true);
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const candidates = useMemo(
    () => rowsFor(allDocs, 'inbox').filter((d) => !d.xeroInvoiceId),
    [allDocs]
  );
  // Whose documents these are: the owner if one was set, else the uploader —
  // the same name the Costs "User" column shows.
  const claimant = norm(claim?.claimFor);
  const ownDocs = useMemo(
    () => (claimant ? candidates.filter((d) => norm(d.user) === claimant) : []),
    [candidates, claimant]
  );
  const scoped = mine && ownDocs.length ? ownDocs : candidates;

  const q = query.trim().toLowerCase();
  const rows = useMemo(() => {
    const list = q
      ? scoped.filter((d) =>
          [d.supplier, d.category, d.date, d.description, d.displayId, d.user, d.total].some((v) =>
            String(v ?? '').toLowerCase().includes(q)
          )
        )
      : scoped;
    // Newest first: the receipt somebody just uploaded is the one they came here
    // to add.
    return [...list].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }, [scoped, q]);

  if (!open) return null;

  const toggle = (id) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allShown = rows.length > 0 && rows.every((d) => picked.has(d.id));
  const toggleAll = () =>
    setPicked((s) => {
      const n = new Set(s);
      rows.forEach((d) => (allShown ? n.delete(d.id) : n.add(d.id)));
      return n;
    });

  const chosenTotal = [...picked]
    .map((id) => candidates.find((d) => d.id === id))
    .filter(Boolean)
    .reduce((n, d) => n + (Number(String(d.total).replace(/[^0-9.-]/g, '')) || 0), 0);

  const add = async () => {
    const docs = candidates.filter((d) => picked.has(d.id));
    if (!docs.length) return;
    setBusy(true);
    setNote('');
    const actor = user?.name || user?.email || 'You';
    const added = [];
    let failed = false;
    try {
      for (const d of docs) {
        await addItemToClaim(claim.id, docToClaimTxn(d, d, actor));
        added.push(d.id);
      }
    } catch (err) {
      failed = true;
      setNote(
        err?.code === 'claim_locked'
          ? 'This claim is already approved, so items can’t be added to it.'
          : 'Could not add every item to the claim — please try again.'
      );
    }
    // Mark whatever DID land, even after a failure part way through: a document
    // on the claim but still sitting in the inbox is the one state nobody can
    // see is wrong.
    if (added.length) {
      await Promise.all(added.map((id) => updateBill(id, { status: 'expenseclaim' }).catch(() => {})));
      notifyBillsChanged();
      onAdded?.(added.length);
    }
    setBusy(false);
    setPicked(new Set());
    if (!failed) onClose?.();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight">Add items to this claim</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Unclaimed cost documents in your inbox — tick the ones to put on {claim?.claimFor || 'this claim'}&rsquo;s claim.
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b px-6 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search supplier, category, amount"
              className="h-8 w-64 rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          {ownDocs.length > 0 && claim?.claimFor && (
            <div className="inline-flex rounded-md border p-0.5 text-xs">
              {[
                { key: true, label: `${claim.claimFor} (${ownDocs.length})` },
                { key: false, label: `Everyone (${candidates.length})` },
              ].map((t) => (
                <button
                  key={String(t.key)}
                  type="button"
                  onClick={() => setMine(t.key)}
                  className={cn(
                    'rounded px-2.5 py-1 transition-colors',
                    mine === t.key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {rows.length} document{rows.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-muted-foreground">
              {candidates.length === 0
                ? 'Nothing in your Costs inbox can go on a claim right now — documents already published to Xero, archived, or on another claim aren’t offered.'
                : 'No documents match your search.'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 border-b bg-muted/40 text-left text-muted-foreground">
                <tr>
                  <th className="w-10 px-3 py-2.5">
                    <input type="checkbox" checked={allShown} onChange={toggleAll} className="h-4 w-4 accent-black" aria-label="Select all shown" />
                  </th>
                  <th className="px-3 py-2.5 font-normal">Supplier</th>
                  <th className="px-3 py-2.5 font-normal">Date</th>
                  <th className="px-3 py-2.5 font-normal">Category</th>
                  <th className="hidden px-3 py-2.5 font-normal sm:table-cell">User</th>
                  <th className="px-3 py-2.5 text-right font-normal">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const missing = missingFields(d);
                  return (
                    <tr
                      key={d.id}
                      onClick={() => toggle(d.id)}
                      className={cn('cursor-pointer border-b last:border-0 hover:bg-muted/40', picked.has(d.id) && 'bg-muted/60')}
                    >
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={picked.has(d.id)} onChange={() => toggle(d.id)} className="h-4 w-4 accent-black" aria-label={`Select ${d.supplier}`} />
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="font-medium">{d.supplier}</span>
                        {missing.length > 0 && (
                          <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-700">
                            Needs: {missing.join(', ')}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted-foreground">{d.date}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{d.category}</td>
                      <td className="hidden whitespace-nowrap px-3 py-2.5 text-muted-foreground sm:table-cell">{d.user || '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                        {d.currency} {d.total}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {note && <p className="border-t px-6 py-2 text-sm text-destructive">{note}</p>}

        <div className="flex flex-wrap items-center gap-2 border-t px-6 py-4">
          <button
            type="button"
            onClick={() => navigate('/costs')}
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Open the Costs inbox
          </button>
          <span className="ml-auto text-xs text-muted-foreground">
            {picked.size
              ? `${picked.size} selected · ${claim?.currency || 'SGD'} ${chosenTotal.toFixed(2)}`
              : 'Nothing selected'}
          </span>
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
            Cancel
          </button>
          <button
            type="button"
            disabled={!picked.size || busy}
            onClick={add}
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Adding…' : picked.size ? `Add ${picked.size} item${picked.size === 1 ? '' : 's'}` : 'Add items'}
          </button>
        </div>
      </div>
    </div>
  );
}
