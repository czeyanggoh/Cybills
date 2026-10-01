import { useState } from 'react';
import { Check, Copy, ExternalLink, FolderOpen, RefreshCw } from 'lucide-react';
import { useDriveForUser, connectDriveFolder, checkDriveFolder, disconnectDriveFolder } from '@/lib/drive';
import { folderIdFromLink, driveStatusLabel, FILED_FOLDER_NAME, NOT_FILED_FOLDER_NAME } from '@/lib/driveFolder';
import { cn } from '@/lib/utils';

// A timestamp as somebody reads it back — short, local, unambiguous.
const stamp = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('en-SG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

// The address a folder is shared with. It is what somebody has to type into
// Drive's Share box, so it is printed to be copied, never to be read aloud.
export function DriveRobotAddress({ email }) {
  const [copied, setCopied] = useState(false);
  if (!email) return null;
  const copy = () => {
    navigator.clipboard?.writeText(email).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-9 min-w-0 flex-1 items-center overflow-hidden rounded-md border bg-muted/40 px-3">
        <span className="truncate font-mono text-xs">{email}</span>
      </div>
      <button
        type="button"
        onClick={copy}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

// One connected folder: what it is, what it has filed, what it passed over and
// why, and the two things that can be done to it. Shared by a person's own page
// and Business settings, so the same folder reads the same in both.
export function DriveFolderRow({ folder, canManage, showPerson = false, onChanged }) {
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState(null);
  const [confirming, setConfirming] = useState(false);

  const check = async () => {
    setBusy('check');
    setNote(null);
    try {
      const out = await checkDriveFolder(folder.id);
      if (!out.ok) {
        setNote({ ok: false, text: out.error || 'The folder could not be looked in.' });
      } else {
        const filed = out.filed?.length ?? 0;
        const passed = (out.skipped?.length ?? 0) + (out.failed?.length ?? 0);
        const parts = [
          filed ? `${filed} ${filed === 1 ? 'document' : 'documents'} filed` : 'Nothing new to file',
          out.setAside ? `${out.setAside} that can’t be read moved into “${NOT_FILED_FOLDER_NAME}”` : passed ? `${passed} passed over` : '',
          out.waiting ? `${out.waiting} more waiting for the next look` : '',
        ].filter(Boolean);
        setNote({ ok: true, text: `${parts.join(' · ')}.` });
      }
    } catch (err) {
      setNote({ ok: false, text: err.message });
    } finally {
      setBusy('');
      onChanged?.();
    }
  };

  const disconnect = async () => {
    setBusy('disconnect');
    setNote(null);
    try {
      await disconnectDriveFolder(folder.id);
      onChanged?.();
    } catch (err) {
      setNote({ ok: false, text: err.message });
      setBusy('');
    }
  };

  const passedOver = (folder.files ?? []).filter((f) => f.outcome !== 'filed');
  const trouble = Boolean(folder.lastError);

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cn('font-medium', trouble ? 'text-amber-700 dark:text-amber-400' : 'text-foreground')}>
          {driveStatusLabel(folder)}
        </span>
        <a
          href={folder.link}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-w-0 items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline"
        >
          <span className="truncate">{folder.folderName}</span>
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
        {showPerson && folder.personName ? <span>· files under {folder.personName}</span> : null}
      </div>
      <p>
        {folder.filed ? `${folder.filed} ${folder.filed === 1 ? 'document' : 'documents'} filed so far` : 'Nothing filed yet'}
        {folder.lastCheckedAt ? ` · last looked in ${stamp(folder.lastCheckedAt)}` : ' · not looked in yet'}
        {folder.folderOwner ? ` · owned by ${folder.folderOwner}` : ''}
      </p>
      {folder.lastError && <p className="text-amber-700 dark:text-amber-400">{folder.lastError}</p>}
      {folder.filedNote && <p className="text-amber-700 dark:text-amber-400">{folder.filedNote}</p>}
      {folder.notFiledNote && <p className="text-amber-700 dark:text-amber-400">{folder.notFiledNote}</p>}

      {/* What is sitting in the folder and was NOT filed. Without this a Word
          document saved there is a file nothing ever happens to, with nowhere
          that says why. */}
      {passedOver.length > 0 && (
        <ul className="space-y-0.5">
          {passedOver.map((f) => (
            <li key={f.fileId} className="flex gap-1.5">
              <span className="shrink-0 font-medium text-foreground">{f.name}</span>
              <span className="min-w-0">
                — not filed: {f.reason}
                {f.moved ? ` · moved to “${NOT_FILED_FOLDER_NAME}”` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <button
            type="button"
            onClick={check}
            disabled={Boolean(busy)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-2.5 font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', busy === 'check' && 'animate-spin')} />
            {busy === 'check' ? 'Looking…' : 'Check now'}
          </button>
          {confirming ? (
            <>
              <span>Stop collecting from this folder? Nothing in Drive is touched, and what was filed stays.</span>
              <button
                type="button"
                onClick={disconnect}
                disabled={Boolean(busy)}
                className="inline-flex h-8 items-center rounded-md bg-foreground px-2.5 font-medium text-background hover:opacity-90 disabled:opacity-50"
              >
                {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={Boolean(busy)}
                className="inline-flex h-8 items-center rounded-md border bg-background px-2.5 font-medium text-foreground hover:bg-muted"
              >
                Keep it
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={Boolean(busy)}
              className="inline-flex h-8 items-center rounded-md border bg-background px-2.5 font-medium text-foreground hover:bg-muted disabled:opacity-50"
            >
              Disconnect
            </button>
          )}
        </div>
      )}
      {note && (
        <p className={note.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>{note.text}</p>
      )}
    </div>
  );
}

// "Connect a Google Drive folder" — the third road a person's paperwork can
// travel without anybody signing in, beside their address and their WhatsApp
// group, and the same shape on purpose.
//
// Nothing is made in Drive. The folder is the person's own: they share it with
// CYBills' robot address, and the link pasted here says whose book its contents
// are filed into. Two steps, in the order they have to happen — a link pasted
// before the folder is shared is refused with the instruction to share it.
export default function ConnectDriveFolder({ user }) {
  const [{ folders, enabled, robotEmail, canManage, loading }, reload] = useDriveForUser(user.id);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const who = user.general ? user.companyName || 'this entity' : user.name || 'this person';

  const connect = async (e) => {
    e?.preventDefault?.();
    setError('');
    setNote('');
    // Refused here by the same rule the server applies, so a link of the wrong
    // kind is said to be one before anything is asked of Google.
    if (!folderIdFromLink(link)) {
      setError('That is not a Google Drive folder link. Open the folder in Drive and copy the address from the browser.');
      return;
    }
    setBusy(true);
    try {
      const out = await connectDriveFolder({ userId: user.id, link });
      setLink('');
      setNote(
        out?.unchanged
          ? `“${out.folder?.folderName}” is already connected.`
          : `“${out.folder?.folderName}” is connected. What is already in it is being filed now.`
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      reload();
      // The first look runs as the folder connects; read it back once it has
      // had a moment, so the card shows what was found rather than "not looked
      // in yet".
      setTimeout(reload, 4000);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <FolderOpen className="h-4 w-4" strokeWidth={1.75} /> Connect a Google Drive folder
      </div>
      <p className="text-xs text-muted-foreground">
        PDFs and photos saved into a connected folder are read and filed under {who}, then moved into a
        “{FILED_FOLDER_NAME}” folder inside it — so the folder only ever holds what is still waiting. In there each
        file is renamed with the day it was filed and a running number in front of its own name, so two files of the
        same name can still be told apart. Anything CYBills can’t read (a Word file, a Google Doc) is moved into
        “{NOT_FILED_FOLDER_NAME}” instead, with the reason shown here.
      </p>

      {!enabled && !loading ? (
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Google Drive isn&rsquo;t set up on this deployment yet, so there is nothing to share a folder with.
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">1.</span> In Google Drive, share the folder with this
              address as an <span className="font-medium text-foreground">Editor</span>:
            </p>
            <DriveRobotAddress email={robotEmail} />
          </div>
          <form onSubmit={connect} className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">2.</span> Paste the folder&rsquo;s link:
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={link}
                onChange={(e) => { setLink(e.target.value); setError(''); }}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                aria-label="Google Drive folder link"
                placeholder="https://drive.google.com/drive/folders/…"
                className={cn(
                  'h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  error && 'border-destructive'
                )}
              />
              <button
                type="submit"
                disabled={busy || loading || !enabled || !canManage || !link.trim()}
                className="inline-flex h-9 shrink-0 items-center rounded-md bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </form>
        </>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
      {note && <p className="text-xs text-emerald-700 dark:text-emerald-400">{note}</p>}

      {folders.map((f) => (
        <DriveFolderRow key={f.id} folder={f} canManage={canManage} onChanged={reload} />
      ))}
    </div>
  );
}
