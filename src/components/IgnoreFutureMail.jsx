import { useState } from 'react';
import { BellOff, Loader2 } from 'lucide-react';
import { ignoreFutureMail } from '@/lib/mailbox';
import { ignoreSubjectFor, isApMailboxForward, originalSenderOf } from '@/lib/apIgnore';

// "Ignore future mail like this", under a document that the CYWS AP Mailbox
// forwarded. The rule is written in CYWorkspace (src/lib/apIgnore.js says why),
// so the next one never reaches CYBills. Scoped to the person this mail was
// forwarded to, or to everything that mailbox forwards into this entity:
// the same sender can be noise for one and a cost for another.
//
// It changes nothing about THIS document; archiving it is offered afterwards as
// its own click, so a rule written by mistake never takes a real cost with it.

const field =
  'h-8 w-full rounded-md border bg-background px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring';

export default function IgnoreFutureMail({ billId, envelope, archived, onArchive }) {
  const forwarded = isApMailboxForward(envelope?.text);
  const [open, setOpen] = useState(false);
  const [sender, setSender] = useState(() => originalSenderOf(envelope?.text, envelope?.from));
  const [subject, setSubject] = useState(() => ignoreSubjectFor(envelope?.subject));
  const [scope, setScope] = useState('person');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);

  if (!forwarded) return null;

  async function save() {
    setBusy(true);
    setError('');
    try {
      const s = sender.trim();
      const out = await ignoreFutureMail(billId, {
        scope,
        ...(s.includes('@') ? { address: s } : { domain: s }),
        subject: subject.trim(),
      });
      setDone(out);
      setOpen(false);
    } catch (e) {
      setError(e.message || 'The rule was not saved.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 px-3 py-2 text-xs">
        <span>
          {done.added ? 'The AP Mailbox will no longer forward' : 'The AP Mailbox already ignores'} mail{' '}
          {done.description ? <>({done.description})</> : 'like this'}
          {done.mailboxes?.length ? <> from {done.mailboxes.join(', ')}</> : null}.
        </span>
        {!archived && onArchive && (
          <button type="button" onClick={onArchive} className="font-medium underline underline-offset-2">
            Archive this one
          </button>
        )}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <BellOff className="h-3.5 w-3.5" /> Ignore future mail like this
      </button>
    );
  }

  return (
    <div className="mt-4 space-y-2 rounded-md border px-3 py-3 text-sm">
      <div className="font-medium">Ignore future mail like this</div>
      <p className="text-xs text-muted-foreground">
        Saved on the CYWorkspace AP Mailbox that forwarded it, so the next one is logged there and never sent to CYBills.
        Every field given must match.
      </p>
      <label className="block text-xs">
        <span className="text-muted-foreground">From (address or domain)</span>
        <input className={field} value={sender} onChange={(e) => setSender(e.target.value)} />
      </label>
      <label className="block text-xs">
        <span className="text-muted-foreground">Subject contains (optional; several, separated by commas)</span>
        <input className={field} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Any subject" />
      </label>
      <fieldset className="space-y-1 text-xs">
        <label className="flex items-center gap-2">
          <input type="radio" checked={scope === 'person'} onChange={() => setScope('person')} />
          Only mail forwarded to {envelope?.to || 'this address'}
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={scope === 'entity'} onChange={() => setScope('entity')} />
          Everything that AP Mailbox forwards to this entity
        </label>
      </fieldset>
      {!subject.trim() && (
        <p className="text-xs text-amber-700">With no subject words, every mail from this sender is ignored, bills included.</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || !sender.trim()}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save rule
        </button>
        <button type="button" onClick={() => setOpen(false)} className="h-8 rounded-md px-3 text-xs" data-escape-close>
          Cancel
        </button>
      </div>
    </div>
  );
}
