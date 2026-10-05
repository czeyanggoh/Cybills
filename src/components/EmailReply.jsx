import { useState } from 'react';
import { CornerUpLeft, Loader2, Send } from 'lucide-react';
import { sendReply } from '@/lib/mailbox';

// Answering a mail from the page it is being read on.
//
// A document that arrived as a link with nothing behind it, or as a photo too
// dark to read, ends with somebody asking the sender for something — and that
// used to mean leaving CYBills to find the email again in a mailbox CYBills's
// addresses do not have. Drawn under the message on the document's Email tab
// and on the Email tab's own thread, from the same component, so the two cannot
// offer different things for one mail.
//
// `target` names what is being answered: `{ billId }` from a document,
// `{ messageId }` from the thread. The server works out the rest.

const when = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('en-SG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const field =
  'h-8 w-full rounded-md border bg-background px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring';

export default function EmailReply({ target, replies = [], replyAddress = '', replyEnabled = false, onSent }) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(replyAddress);
  const [cc, setCc] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const start = () => {
    setTo(replyAddress);
    setError('');
    setOpen(true);
  };

  async function send() {
    setBusy(true);
    setError('');
    try {
      await sendReply({ ...target, to, cc, body });
      setBody('');
      setCc('');
      setShowCc(false);
      setOpen(false);
      await onSent?.();
    } catch (err) {
      // What was typed stays: a reply that failed to send is still a reply
      // somebody wrote.
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {/* What has already been said back, oldest first. Shown whether or not a
          reply can be sent now: it is the record of what the sender was told. */}
      {replies.map((r) => (
        <div key={r.id} className="rounded-md border bg-muted/30 px-3 py-2">
          <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
            <CornerUpLeft className="h-3.5 w-3.5 shrink-0 self-center" />
            <span className="font-medium text-foreground">{r.byName || r.by || 'Somebody here'} replied</span>
            <span>to {[...(r.to || []), ...(r.cc || [])].join(', ')}</span>
            <span className="ml-auto">{when(r.at)}</span>
          </p>
          <p className="mt-1.5 whitespace-pre-wrap text-sm">{r.text}</p>
        </div>
      ))}

      {!open ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={start}
            disabled={!replyEnabled}
            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted/60 disabled:opacity-60"
          >
            <CornerUpLeft className="h-3.5 w-3.5" /> {replies.length ? 'Reply again' : 'Reply'}
          </button>
          {!replyEnabled && (
            <span className="text-xs text-muted-foreground">
              No mailbox is connected to send from — the practice connects one under Business settings &rarr; Email.
            </span>
          )}
        </div>
      ) : (
        <div className="space-y-2 rounded-md border px-3 py-3">
          <label className="grid grid-cols-[2.5rem_1fr] items-center gap-x-2 text-sm">
            <span className="text-muted-foreground">To</span>
            <span className="flex items-center gap-2">
              <input
                type="text"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="name@example.com"
                className={field}
              />
              {!showCc && (
                <button
                  type="button"
                  onClick={() => setShowCc(true)}
                  className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Add Cc
                </button>
              )}
            </span>
          </label>
          {showCc && (
            <label className="grid grid-cols-[2.5rem_1fr] items-center gap-x-2 text-sm">
              <span className="text-muted-foreground">Cc</span>
              <input
                type="text"
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                placeholder="Separate addresses with commas"
                className={field}
              />
            </label>
          )}
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            autoFocus
            placeholder="Write your reply…"
            className="w-full rounded-md border bg-background px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          {/* Said before the click, because it is the part nobody would guess:
              the mail does not come from the person typing it. */}
          <p className="text-xs text-muted-foreground">
            Sent from CYBills&rsquo;s own mailbox with your name under it and the original message quoted. Their answer
            comes back to the address they wrote to, so anything they attach is filed here, and a copy reaches you.
          </p>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={send}
              disabled={busy || !body.trim() || !to.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              {busy ? 'Sending…' : 'Send reply'}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
