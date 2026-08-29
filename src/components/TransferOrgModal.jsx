import { useEffect, useMemo, useState } from 'react';
import { X, CheckCircle2, ArrowRightLeft } from 'lucide-react';
import { useOrganisations, getActiveOrganisationId, switchOrganisationTo } from '@/lib/organisations';
import { transferBills, TRANSFER_SKIP_REASON } from '@/lib/bills';

// "This one is in the wrong client's book."
//
// A colleague who works across several entities uploads into whichever one
// happens to be open, so a Red Alpha invoice lands in CY Business Management's
// Costs. The document says whose it is on its face — the "Bill To" block — and
// the server compares that against the entities this person may open (see
// src/lib/tenantMatch.js). This dialog is where the answer gets acted on.
//
// It is a confirmation, not a form. The destination is already known for the
// documents that raised it; the picker exists for the other direction — moving
// something the reader said nothing about, or overruling a match that named the
// wrong entity. Either way the move is spelt out first, because it takes a
// document out of one client's book, which is not somewhere you look for it.
export default function TransferOrgModal({ open, docs = [], onClose, onDone }) {
  const { data: organisations = [] } = useOrganisations();
  const activeId = getActiveOrganisationId();
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { moved, skipped, organisation }

  // Where these documents say they belong. Several documents can point at
  // several entities; one move goes to one place, so the dialog opens on the
  // entity the most of them name and the rest are left for a second pass — a
  // silent split across two books would be worse than two obvious rounds.
  const suggested = useMemo(() => {
    const tally = new Map();
    for (const d of docs) {
      const id = d?.misfiledTo?.orgId;
      if (id) tally.set(id, (tally.get(id) ?? 0) + 1);
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1]);
  }, [docs]);

  const elsewhere = organisations.filter((o) => o.id !== activeId);

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError('');
    setResult(null);
    setTargetId(suggested[0]?.[0] || elsewhere[0]?.id || '');
    // `suggested` and `elsewhere` are derived from props that are stable while
    // the dialog is open; re-running on them would fight the user's own choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const target = organisations.find((o) => o.id === targetId) || null;
  // Only the documents that are actually going: the picker can name an entity
  // some of the selection was never said to belong to, and moving those too
  // would be a bulk action doing more than it says.
  const going = useMemo(() => {
    if (!targetId) return [];
    // Nothing was suggested at all (a hand-picked move) → everything selected.
    if (!suggested.length) return docs;
    const matching = docs.filter((d) => d?.misfiledTo?.orgId === targetId);
    return matching.length ? matching : docs;
  }, [docs, targetId, suggested]);
  const leftBehind = docs.length - going.length;

  const move = async () => {
    if (!targetId || !going.length) return;
    setBusy(true);
    setError('');
    try {
      const res = await transferBills(going.map((d) => d.id), targetId);
      setResult(res);
      onDone?.(res);
    } catch (err) {
      setError(err.message === 'transfer_failed' ? 'The move did not go through. Try again.' : err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const selectClass =
    'h-9 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-md flex-col overflow-y-auto rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">Move to another client entity</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {result ? (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <CheckCircle2 className="h-10 w-10 text-green-600" />
            <p className="text-sm">
              {result.moved.length} document{result.moved.length === 1 ? '' : 's'} moved to{' '}
              <span className="font-medium">{result.organisation?.name}</span>.
            </p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {result.moved.length === 1 ? 'It is' : 'They are'} in that entity&rsquo;s To review, waiting for a
              category from its own chart of accounts.
            </p>
            {/* Never a bare count: the documents that refused are the ones
                somebody has to do something else about. */}
            {result.skipped?.length > 0 && (
              <ul className="w-full space-y-1 rounded-md border border-amber-600/30 bg-amber-50 px-3 py-2 text-left text-xs text-amber-800">
                {result.skipped.map((s) => {
                  const doc = docs.find((d) => d.id === s.id);
                  return (
                    <li key={s.id}>
                      <span className="font-medium">{doc?.supplier || doc?.displayId || s.id}</span> stayed here —{' '}
                      {TRANSFER_SKIP_REASON[s.reason] || s.reason}.
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="mt-2 flex items-center gap-2">
              {result.moved.length > 0 && result.organisation?.id && (
                <button
                  type="button"
                  onClick={() => switchOrganisationTo(result.organisation.id, '/costs')}
                  className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted"
                >
                  Open {result.organisation.name}
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-3 p-6">
              {suggested.length > 0 ? (
                <p className="text-sm text-muted-foreground">
                  {docs.length === 1 ? (
                    <>
                      <span className="font-medium text-foreground">{docs[0].supplier}</span> is billed to{' '}
                      <span className="font-medium text-foreground">{docs[0].billedTo}</span>, which is{' '}
                      {docs[0].misfiledTo?.name} — not the entity it was uploaded into.
                    </>
                  ) : (
                    <>
                      {docs.length} documents are billed to a client entity other than the one they were uploaded
                      into.
                    </>
                  )}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Move {docs.length} document{docs.length === 1 ? '' : 's'} into another client entity&rsquo;s Costs
                  book.
                </p>
              )}

              {elsewhere.length === 0 ? (
                <p className="text-sm text-destructive">
                  You only have access to one client entity, so there is nowhere to move these.
                </p>
              ) : (
                <label className="flex items-center gap-3 text-sm">
                  <span className="w-20 shrink-0 text-muted-foreground">Move to</span>
                  <div className="relative flex-1">
                    <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className={selectClass}>
                      {elsewhere.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                          {suggested.some(([id]) => id === o.id) ? ' — where these are billed' : ''}
                        </option>
                      ))}
                    </select>
                    <ArrowRightLeft className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  </div>
                </label>
              )}

              {leftBehind > 0 && (
                <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {leftBehind} of the selected document{leftBehind === 1 ? ' is' : 's are'} billed to a different
                  entity and will stay here. Move those in a second round.
                </p>
              )}

              {/* Said before the move, not discovered afterwards: a category and
                  a tax code are names out of THIS entity's own Xero lists, and
                  they mean something else (or nothing) in another chart. */}
              <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                The document itself comes across whole — supplier, dates, figures, line items and its file. What is
                cleared is everything that only meant something here: the category, tax code, project, customer and
                payment account all name this entity&rsquo;s own Xero lists. {going.length === 1 ? 'It lands' : 'They land'}{' '}
                in {target?.name || 'the other entity'}&rsquo;s To review to be coded there.
              </p>

              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>

            <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !targetId || !going.length}
                onClick={move}
                className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy
                  ? 'Moving…'
                  : `Move ${going.length} document${going.length === 1 ? '' : 's'}${target ? ` to ${target.name}` : ''}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
