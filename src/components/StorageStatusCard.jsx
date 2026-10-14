import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { HardDrive, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { canManagePractice, useStorageStatus, runStorageTask } from '@/lib/practiceStore';
import { formatBytes } from '@/lib/mailbox';

const when = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

// Where the documents and the records are kept, on the practice's Clients page:
// the bucket the files go to and whether it is answering, how many files are
// still only on the server's own disk, and the last nightly backup — with the
// two jobs behind them (server storageCare.ts) runnable now by whoever runs the
// practice, rather than waiting for the next half-hourly tick.
export default function StorageStatusCard() {
  const { membership, googleEnabled } = useAuth();
  const manage = canManagePractice(membership, googleEnabled);
  const { data, isLoading } = useStorageStatus(true);
  const qc = useQueryClient();
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  const run = async (task) => {
    setBusy(task);
    setNote('');
    try {
      const out = await runStorageTask(task);
      qc.setQueryData(['practice-storage'], out.status);
      if (out.error) setNote(out.error);
      else if (task === 'move') setNote(out.moved ? `Moved ${out.moved} file${out.moved === 1 ? '' : 's'} into the bucket.` : 'Nothing left to move.');
      else setNote(`Backed up ${out.files} record files (${formatBytes(out.bytes)}).`);
    } catch (err) {
      setNote(err.message);
    } finally {
      setBusy('');
    }
  };

  if (isLoading || !data) return null;
  const healthy = !data.problems.length;
  const missing = data.move?.missing?.length ?? 0;

  return (
    <div id="storage" className="mb-5 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <HardDrive className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
        <h2 className="text-sm font-semibold">File storage &amp; backups</h2>
        {healthy ? (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" /> Working
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" /> Needs attention
          </span>
        )}
      </div>

      {!healthy && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm">
          {data.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Documents are stored in</dt>
          <dd className="font-medium">{data.r2Enabled ? `R2 bucket “${data.bucket}”` : 'The server’s own disk'}</dd>
          {data.health?.lastFailureAt && (
            <dd className="text-muted-foreground">Last refusal {when(data.health.lastFailureAt)}</dd>
          )}
        </div>
        <div>
          <dt className="text-muted-foreground">Still only on the server’s disk</dt>
          <dd className="font-medium">{data.localFiles} file{data.localFiles === 1 ? '' : 's'}</dd>
          {data.move?.movedTotal > 0 && (
            <dd className="text-muted-foreground">{data.move.movedTotal} moved into the bucket so far</dd>
          )}
          {missing > 0 && (
            <dd className="text-muted-foreground">{missing} record{missing === 1 ? ' names a file' : 's name files'} no longer on disk</dd>
          )}
        </div>
        <div>
          <dt className="text-muted-foreground">Last backup of the records</dt>
          <dd className="font-medium">
            {data.backup?.lastAt ? `${when(data.backup.lastAt)} · ${formatBytes(data.backup.lastBytes)}` : 'Never'}
          </dd>
          <dd className="text-muted-foreground">Nightly, kept 30 days</dd>
        </div>
      </dl>

      {manage && data.r2Enabled && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {data.localFiles > 0 && (
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => run('move')}
              className="h-8 rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              {busy === 'move' ? 'Moving…' : 'Move files into the bucket now'}
            </button>
          )}
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() => run('backup')}
            className="h-8 rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {busy === 'backup' ? 'Backing up…' : 'Back up now'}
          </button>
          {note && <span className="text-xs text-muted-foreground">{note}</span>}
        </div>
      )}
    </div>
  );
}
