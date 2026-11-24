import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, ExternalLink, XCircle } from 'lucide-react';
import AppShell from '@/components/AppShell';
import { getApprovalRequest, approveClaim, rejectClaim, formatClaimDate, formatClaimStamp } from '@/lib/claimStore';
import { getActiveOrganisationId, switchOrganisationTo } from '@/lib/organisations';
import { cn } from '@/lib/utils';

const totalOf = (c) => (c.transactions || []).reduce((n, t) => n + Number(t.total || 0), 0);
const money = (currency, n) => `${currency || 'SGD'} ${Number(n || 0).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function StatusPill({ claim }) {
  const s = claim.approvalStatus;
  const label = s === 'approved' ? `Approved${claim.decidedBy ? ` by ${claim.decidedBy}` : ''}` : s === 'rejected' ? `Rejected${claim.decidedBy ? ` by ${claim.decidedBy}` : ''}` : s === 'awaiting_approval' ? 'Awaiting approval' : 'Not submitted';
  return (
    <span
      className={cn(
        'inline-flex whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium',
        s === 'approved' ? 'bg-foreground text-background' : s === 'rejected' ? 'border border-destructive text-destructive' : 'border border-foreground/40'
      )}
    >
      {label}
    </span>
  );
}

// What the link in the WhatsApp group opens: the claims of ONE approval
// request, to be approved together or one at a time. Every decision goes
// through the claim's own approve / reject route, so who may decide is exactly
// who could on the claim's own page; the buttons are drawn only for them.
export default function ClaimApprovals() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [ticked, setTicked] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [rejecting, setRejecting] = useState(null); // claim id
  const [reason, setReason] = useState('');

  const load = useCallback(async (retick = false) => {
    try {
      const r = await getApprovalRequest(id);
      // The link names its entity (?org=), but opened another way the page may
      // be standing in a different one: every decision is scoped to the open
      // entity, so move there first.
      if (r.request?.entityId && getActiveOrganisationId() !== r.request.entityId) {
        switchOrganisationTo(r.request.entityId, `/approvals/${id}`);
        return;
      }
      setData(r);
      setError('');
      if (retick) setTicked(new Set(r.claims.filter((c) => c.canDecide).map((c) => c.id)));
    } catch (e) {
      setError(e.status === 404 ? 'This approval request was not found, or it belongs to an entity you cannot open.' : e.message || 'The request could not be loaded.');
    }
  }, [id]);
  useEffect(() => { load(true); }, [load]);

  const claims = data?.claims || [];
  const decidable = claims.filter((c) => c.canDecide);
  const picked = decidable.filter((c) => ticked.has(c.id));
  const currencies = new Set(picked.map((c) => c.currency || 'SGD'));
  const toggle = (cid) => setTicked((s) => { const n = new Set(s); if (n.has(cid)) n.delete(cid); else n.add(cid); return n; });

  const approvePicked = async () => {
    const n = picked.length;
    if (!n || !window.confirm(`Approve ${n} claim${n === 1 ? '' : 's'}${currencies.size === 1 ? `, ${money([...currencies][0], picked.reduce((t, c) => t + totalOf(c), 0))} in total` : ''}?`)) return;
    setBusy(true);
    setNotice('');
    const failed = [];
    // One at a time: each is its own decision, and each refusal is named.
    for (const c of picked) {
      try {
        await approveClaim(c.id);
      } catch (e) {
        failed.push(`${c.claimFor || c.name}: ${e.serverMessage || (e.code === 'not_approver' ? 'only its approver can approve it' : e.code) || 'could not be approved'}`);
      }
    }
    await load(true);
    setBusy(false);
    setNotice([`${n - failed.length} of ${n} approved.`, ...failed].join(' '));
  };

  const doReject = async () => {
    const c = claims.find((x) => x.id === rejecting);
    setRejecting(null);
    if (!c) return;
    setBusy(true);
    setNotice('');
    try {
      await rejectClaim(c.id, reason.trim());
      setNotice(`${c.claimFor || c.name}: rejected.`);
    } catch (e) {
      setNotice(`${c.claimFor || c.name}: ${e.serverMessage || e.code || 'could not be rejected'}`);
    }
    await load(true);
    setBusy(false);
  };

  const req = data?.request;
  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl">
        <h1 className="text-xl font-semibold tracking-tight">Expense claims for approval</h1>
        {error && <p className="mt-4 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{error}</p>}
        {!data && !error && <p className="mt-4 text-sm text-muted-foreground">Loading…</p>}
        {req && (
          <>
            <p className="mt-1 text-sm text-muted-foreground">
              {[req.entityName, req.requestedBy ? `requested by ${req.requestedBy}` : '', formatClaimStamp(req.at), req.groupName ? `sent to “${req.groupName}”` : ''].filter(Boolean).join(' · ')}
            </p>
            {req.note && <p className="mt-3 rounded-md border bg-muted px-3 py-2 text-sm">{req.note}</p>}
            {notice && <p className="mt-3 rounded-md border bg-muted px-3 py-2 text-sm">{notice}</p>}

            <ul className="mt-4 divide-y rounded-md border">
              {claims.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3">
                  {c.canDecide ? (
                    <input type="checkbox" checked={ticked.has(c.id)} onChange={() => toggle(c.id)} disabled={busy} className="h-4 w-4" aria-label={`Select ${c.name}`} />
                  ) : (
                    <span className="w-4" />
                  )}
                  <div className="min-w-0 flex-1 basis-56">
                    <div className="truncate text-sm font-medium">{c.claimFor || 'Unnamed'}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {c.name} · {formatClaimDate(c.endDate || c.claimDate) || 'no date'} · {(c.transactions || []).length} item{(c.transactions || []).length === 1 ? '' : 's'}
                    </div>
                    {c.approvalStatus === 'rejected' && c.decisionReason && <div className="text-xs text-destructive">Reason: {c.decisionReason}</div>}
                  </div>
                  <span className="text-sm font-medium tabular-nums">{money(c.currency, totalOf(c))}</span>
                  <StatusPill claim={c} />
                  <Link to={`/expense-claims/${c.id}`} className="inline-flex items-center gap-1 text-xs underline underline-offset-2 hover:opacity-80">
                    Open <ExternalLink className="h-3 w-3" />
                  </Link>
                  {c.canDecide && (
                    <button type="button" disabled={busy} onClick={() => { setReason(''); setRejecting(c.id); }} className="inline-flex items-center gap-1 text-xs text-destructive hover:opacity-80">
                      <XCircle className="h-3.5 w-3.5" /> Reject
                    </button>
                  )}
                </li>
              ))}
              {claims.length === 0 && <li className="px-3 py-4 text-sm text-muted-foreground">None of the claims in this request are yours to see.</li>}
            </ul>
            {req.hidden > 0 && claims.length > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">{req.hidden} more claim{req.hidden === 1 ? '' : 's'} in this request {req.hidden === 1 ? 'is' : 'are'} not yours to see.</p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              {decidable.length > 0 ? (
                <>
                  <button
                    type="button"
                    disabled={!picked.length || busy}
                    onClick={approvePicked}
                    className={cn(
                      'inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90',
                      (!picked.length || busy) && 'opacity-50'
                    )}
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    {busy ? 'Working…' : picked.length === decidable.length && picked.length > 1 ? `Approve all ${picked.length}` : `Approve ${picked.length || ''}`.trim()}
                  </button>
                  {picked.length > 0 && currencies.size === 1 && (
                    <span className="text-sm text-muted-foreground">{money([...currencies][0], picked.reduce((t, c) => t + totalOf(c), 0))} ticked</span>
                  )}
                </>
              ) : claims.some((c) => c.approvalStatus === 'awaiting_approval') ? (
                <span className="text-sm text-muted-foreground">These claims are waiting on their approver. You are not the approver of any of them.</span>
              ) : claims.length > 0 ? (
                <span className="text-sm text-muted-foreground">Nothing here is waiting for a decision.</span>
              ) : null}
            </div>
          </>
        )}
      </div>

      {rejecting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-foreground/20" onClick={() => setRejecting(null)} aria-hidden="true" />
          <div className="relative w-full max-w-sm rounded-lg bg-background p-5 shadow-xl">
            <h2 className="text-base font-semibold">Reject this claim?</h2>
            <label htmlFor="reject-reason" className="mb-1 mt-3 block text-xs text-muted-foreground">Reason (the claimant is told)</label>
            <textarea id="reject-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" data-escape-close onClick={() => setRejecting(null)} className="inline-flex h-9 items-center rounded-md border px-4 text-sm hover:bg-muted">Cancel</button>
              <button type="button" onClick={doReject} className="inline-flex h-9 items-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground hover:opacity-90">Reject</button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
