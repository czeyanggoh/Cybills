import { useState } from 'react';
import { setWhatsappDisappearing } from '@/lib/whatsapp';

// Disappearing messages on a collection group.
//
// WhatsApp's own group setting: every message sent into the group is removed
// from everyone's phone after seven days. A collection group is a PIPE rather
// than a record — a bill is in the shared bucket and filed as a cost document
// within seconds of arriving, and none of that lives in WhatsApp — so the chat
// clearing itself loses nothing anybody accounts from. What it stops is a
// client's paperwork accumulating for ever on the phone of everybody who has
// ever been in the group, which is the one copy nobody here can delete.
//
// Seven days rather than 24 hours because a document that failed to file has to
// still be in the chat when somebody comes looking for it. The route holds the
// durations and answers with the wording, so this prints what the group IS
// rather than working it out again.
//
// Not offered on an ADOPTED conversation: that group is the client's own,
// merely pointed at CYBills, and setting their messages to delete themselves
// from an accounting app is the same species of act as taking it apart. The
// server refuses it too.
export default function WhatsappDisappearing({ channel, canManage, onDone }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  if (!channel || channel.status !== 'open' || channel.adopted || !canManage) return null;

  // What CYBills last set. Absent is not "off": WhatsApp's default is off, but
  // somebody may have set it from inside the group and CYBills was never told,
  // so nothing is claimed either way until the button has been pressed.
  const set = channel.disappearing;
  const already = set?.seconds === 604800;

  const apply = async () => {
    setBusy(true);
    setNote(null);
    try {
      const out = await setWhatsappDisappearing({ submissionId: channel.submissionId });
      setNote({ ok: true, text: `Messages sent into this group now disappear after ${out.label}.` });
      onDone?.(out);
    } catch (err) {
      setNote({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={apply}
        disabled={busy}
        className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
      >
        {busy
          ? 'Setting disappearing messages…'
          : already
            ? 'Set messages to disappear after 7 days again'
            : 'Set messages to disappear after 7 days'}
      </button>
      {/* Said under the button rather than instead of it: the setting can be
          changed from inside WhatsApp by anybody in the group, so this is the
          last thing CYBills set, not a reading of the group as it is now. */}
      {!note && set && (
        <p className="text-xs text-muted-foreground">
          Last set here to {set.label} on {new Date(set.setAt).toLocaleDateString()}.
        </p>
      )}
      {note && (
        <p className={note.ok ? 'text-xs text-emerald-700 dark:text-emerald-400' : 'text-xs text-destructive'}>
          {note.text}
        </p>
      )}
    </div>
  );
}
