import { useEffect, useState } from 'react';
import { X, AlertTriangle, MessageCircle } from 'lucide-react';
import { getApprovalGroup, setApprovalGroup, requestApprovalByWhatsapp } from '@/lib/claimStore';
import ApproverSelect from '@/components/ApproverSelect';
import { useApprovers } from '@/lib/useApprovers';
import { cn } from '@/lib/utils';

const MAX = 10; // the server's limit for one request

const totalOf = (c) => (c.transactions || []).reduce((n, t) => n + Number(t.total || 0), 0);
const money = (currency, n) => `${currency || 'SGD'} ${Number(n || 0).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// "Send to WhatsApp for approval". The claims' PDFs and one message with a link
// go to the entity's approval group; whoever may approve opens the link and
// decides them in CYBills, all at once or one by one.
//
// Which group is the entity's own setting. A Business Admin chooses it here,
// from the groups CYWorkspace has linked to this organisation; everybody else
// is only told which group it is.
export default function ClaimWhatsappModal({ open, onClose, claims = [], onSent }) {
  const [info, setInfo] = useState(null); // { group, canManage, linked, candidates?, candidatesError? }
  const [loading, setLoading] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { rows, pick: pickApprover, reset } = useApprovers(claims);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError('');
    setNote('');
    setChoosing(false);
    reset();
    setLoading(true);
    getApprovalGroup(true)
      .then((r) => { if (alive) setInfo(r); })
      .catch((e) => { if (alive) { setInfo(null); setError(e.message || 'The approval group could not be read.'); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open]);

  if (!open) return null;

  const group = info?.group || null;
  const candidates = info?.candidates || [];
  const tooMany = claims.length > MAX;
  // A claim being asked about for the first time goes to ONE of the claimant's
  // direct managers; one already awaiting keeps the approver it has.
  const toChoose = rows.filter((r) => r.claim.approvalStatus !== 'awaiting_approval' && r.managers.length > 1);
  const unchosen = toChoose.some((r) => !r.approverId);
  const canSend = Boolean(group) && claims.length > 0 && !tooMany && !unchosen && !busy;

  const pick = async (chatId) => {
    setError('');
    try {
      const r = await setApprovalGroup(chatId);
      setInfo((i) => ({ ...(i || {}), group: r.group }));
      setChoosing(false);
    } catch (e) {
      setError(e.message || 'That group could not be saved.');
    }
  };

  const send = async () => {
    setBusy(true);
    setError('');
    try {
      const approvers = Object.fromEntries(toChoose.map((r) => [r.claim.id, r.approverId]));
      const r = await requestApprovalByWhatsapp(claims.map((c) => c.id), note.trim(), approvers);
      onSent?.(r);
    } catch (e) {
      setError(e.message || 'The claims could not be sent.');
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={busy ? undefined : onClose} aria-hidden="true" />
      <div className="relative w-full max-w-md overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">Send to WhatsApp for approval</h2>
          <button type="button" disabled={busy} onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3 p-6">
          <p className="text-sm text-muted-foreground">
            Each claim&rsquo;s PDF is posted to the group, followed by one message with a link. The approver opens the link and approves in CYBills.
          </p>

          <div className="rounded-md border p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">WhatsApp group</span>
              {loading ? (
                <span className="text-muted-foreground">Checking…</span>
              ) : (
                <span className="flex min-w-0 items-center gap-2">
                  <span className={cn('min-w-0 truncate font-medium', !group && 'text-muted-foreground')}>{group ? group.name : 'None chosen'}</span>
                  {info?.canManage && !choosing && (
                    <button type="button" onClick={() => setChoosing(true)} className="shrink-0 text-xs underline underline-offset-2 hover:opacity-80">
                      {group ? 'Change' : 'Choose'}
                    </button>
                  )}
                </span>
              )}
            </div>
            {choosing && (
              <div className="mt-3 space-y-1.5">
                {info?.candidatesError && <p className="text-xs text-destructive">{info.candidatesError}</p>}
                {!info?.linked && <p className="text-xs text-muted-foreground">This entity is not linked to a Xero organisation, so it has no groups to choose from.</p>}
                {info?.linked && !info?.candidatesError && candidates.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No group is linked to this organisation yet. In CYWorkspace&rsquo;s WhatsApp inbox, add CYBot to the group and link the group to this organisation, then come back.
                  </p>
                )}
                {candidates.map((g) => (
                  <button
                    key={g.chatId}
                    type="button"
                    onClick={() => pick(g.chatId)}
                    className={cn('flex w-full items-center justify-between rounded-md border px-3 py-1.5 text-left text-sm transition-colors hover:bg-muted', group?.chatId === g.chatId && 'border-foreground')}
                  >
                    <span className="min-w-0 truncate">{g.name}</span>
                    {group?.chatId === g.chatId && <span className="shrink-0 text-xs text-muted-foreground">Current</span>}
                  </button>
                ))}
                <button type="button" onClick={() => setChoosing(false)} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
              </div>
            )}
            {!loading && !group && !info?.canManage && (
              <p className="mt-2 text-xs text-muted-foreground">Ask a Business Admin to choose the group here first.</p>
            )}
          </div>

          {claims.length > 0 && (
            <ul className="max-h-44 space-y-1.5 overflow-auto rounded-md border p-3 text-sm">
              {claims.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate">{c.claimFor || 'Unnamed'} <span className="text-muted-foreground">· {c.name}</span></span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{money(c.currency, totalOf(c))}</span>
                </li>
              ))}
            </ul>
          )}

          {toChoose.length > 0 && (
            <div className="space-y-1.5 rounded-md border p-3 text-sm">
              <p className="text-xs text-muted-foreground">More than one direct manager. Choose who approves:</p>
              <ul className="max-h-44 space-y-1.5 overflow-auto">
                {toChoose.map(({ claim, managers, approverId }) => (
                  <li key={claim.id} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate">{claim.claimFor} <span className="text-muted-foreground">· {claim.name}</span></span>
                    <ApproverSelect claim={claim} managers={managers} value={approverId} onChange={(v) => pickApprover(claim.id, v)} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <label htmlFor="wa-note" className="mb-1 block text-xs text-muted-foreground">Note to the approver (optional)</label>
            <textarea
              id="wa-note"
              value={note}
              maxLength={500}
              rows={2}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Expenses claim for approval. Thanks"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          {tooMany && (
            <div className="flex items-start gap-2 rounded-md border border-amber-600/30 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>At most {MAX} claims go in one request. Untick some and send the rest as a second request.</span>
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button type="button" disabled={busy} onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSend}
            onClick={send}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90',
              !canSend && 'opacity-50'
            )}
          >
            <MessageCircle className="h-4 w-4" />
            {busy ? 'Sending…' : `Send ${claims.length} claim${claims.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
