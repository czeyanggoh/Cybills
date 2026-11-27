import { useState } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import ApproverSelect from '@/components/ApproverSelect';
import { useApprovers } from '@/lib/useApprovers';
import { cn } from '@/lib/utils';

// "Submit for approval" dialog. Each claim goes to ONE of the claimant's direct
// managers (Users for a client entity's own staff, Colleagues for the
// practice's own team): the only one there is, or the one picked here where
// there are several. Claims whose claimant has no manager are blocked.
// `claims` are the selected claim objects; `onSubmit([{ id, approverId }])`
// submits the ones that have a manager.
export default function ClaimApprovalModal({ open, onClose, onSubmit, claims = [] }) {
  const { rows, pick, reset } = useApprovers(claims);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const routable = rows.filter((r) => r.managers.length);
  const missing = rows.filter((r) => !r.managers.length);
  const unchosen = routable.some((r) => !r.approverId);
  const blocked = routable.length === 0 || unchosen || busy;

  const close = () => {
    reset();
    onClose();
  };
  const submit = async () => {
    setBusy(true);
    await onSubmit(routable.map((r) => ({ id: r.claim.id, approverId: r.approverId })));
    reset();
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={close} aria-hidden="true" />
      <div className="relative w-full max-w-md overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">Submit for approval</h2>
          <button type="button" onClick={close} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3 p-6">
          <p className="text-sm text-muted-foreground">
            Each claim is sent to one of the claimant&rsquo;s <span className="font-medium text-foreground">direct managers</span> for approval. Where there are several, choose which one. Managers are set per person in <span className="font-medium text-foreground">Users</span>, or in <span className="font-medium text-foreground">Colleagues</span> for the practice&rsquo;s own team.
          </p>
          {routable.length > 0 && (
            <ul className="max-h-52 space-y-1.5 overflow-auto rounded-md border p-3 text-sm">
              {routable.map(({ claim, managers, approverId }) => (
                <li key={claim.id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate">
                    {claim.claimFor}
                    {claims.length > 1 && claim.name && <span className="text-muted-foreground"> · {claim.name}</span>}
                  </span>
                  <ApproverSelect claim={claim} managers={managers} value={approverId} onChange={(v) => pick(claim.id, v)} />
                </li>
              ))}
            </ul>
          )}
          {missing.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-amber-600/30 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {missing.length === 1
                  ? <><span className="font-medium">{missing[0].claim.claimFor}</span> has no direct manager set, so that claim can&rsquo;t be submitted.</>
                  : <><span className="font-medium">{missing.length} claimants</span> have no direct manager set, so their claims can&rsquo;t be submitted.</>}
                {' '}Set one in Users first.
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button type="button" onClick={close} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
            Cancel
          </button>
          <button
            type="button"
            disabled={blocked}
            onClick={submit}
            className={cn(
              'inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90',
              blocked && 'opacity-50'
            )}
          >
            {busy ? 'Submitting…' : `Submit${routable.length ? ` ${routable.length}` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
