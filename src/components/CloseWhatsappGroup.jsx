import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { closeWhatsappChannel } from '@/lib/whatsapp';

// Closing a collection group down.
//
// Two acts, offered side by side on every group because only the person
// pressing knows which they mean:
//
//   Stop collecting  — CYBills forgets it. The group carries on in WhatsApp
//                      with everyone still in it.
//   Delete the group — CYBot removes everyone and leaves.
//
// Both are offered whoever opened the group. One CYBills opened for a colleague
// is usually finished with; a client's own conversation that was merely POINTED
// at CYBills is theirs, and taking it apart from an accounting app would be
// destroying something that was never ours. The panel says which kind this is
// rather than deciding for anybody.
//
// The panel IS the confirmation — it names the group and states the consequence
// before either button exists, which is the only warning worth giving for
// something that happens in front of a client.
export default function CloseWhatsappGroup({ channel, canManage, onClosed }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null); // 'keep' | 'delete'
  const [error, setError] = useState(null);

  if (!channel || channel.status !== 'open' || !canManage) return null;

  const close = async (deleteGroup) => {
    setBusy(deleteGroup ? 'delete' : 'keep');
    setError(null);
    try {
      const out = await closeWhatsappChannel({ submissionId: channel.submissionId, deleteGroup });
      setOpen(false);
      onClosed?.(out);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => { setOpen(true); setError(null); }}
        className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Close this group
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-3 dark:bg-amber-500/10">
      <div className="flex items-start justify-between gap-3">
        <p className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <span className="font-medium">{channel.subject}</span>
            {channel.adopted
              ? ' was already a conversation before CYBills was pointed at it — CYBot didn’t open it.'
              : ' was opened by CYBot for collecting bills.'}
            {' '}The bills already collected and the messages already read stay exactly where they are, either way.
          </span>
        </p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="shrink-0 rounded p-0.5 text-amber-800/70 hover:text-amber-900 dark:text-amber-200/70"
          aria-label="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-2 pl-5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <button
            type="button"
            onClick={() => close(false)}
            disabled={Boolean(busy)}
            className="inline-flex h-8 items-center rounded-md border border-amber-700/40 bg-background px-3 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
          >
            {busy === 'keep' ? 'Stopping…' : 'Stop collecting here'}
          </button>
          <span className="text-xs text-amber-800/80 dark:text-amber-200/70">
            The group stays, and everyone stays in it. Nothing sent into it reaches CYBills again.
          </span>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <button
            type="button"
            onClick={() => close(true)}
            disabled={Boolean(busy)}
            className="inline-flex h-8 items-center rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy === 'delete' ? 'Deleting…' : 'Delete the group'}
          </button>
          {/* Said plainly because it is the half people assume works and it
              doesn't: WhatsApp has no "delete for everyone", and somebody who
              thinks a group vanished from a client's phone will not check. */}
          <span className="text-xs text-amber-800/80 dark:text-amber-200/70">
            CYBot removes everyone and leaves. It stays in their chat list showing they were removed — WhatsApp
            has no way to take it off their phones.
          </span>
        </div>
      </div>

      {error && <p className="pl-5 text-xs text-destructive">{error.message}</p>}
    </div>
  );
}
