import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { HardDrive, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { isPracticeTeam, useStorageStatus } from '@/lib/practiceStore';

// A storage problem, said where the practice will see it.
//
// For weeks every document CYBills received was kept only on the server's own
// disk — the bucket refused its key, the upload fell back exactly as designed,
// and the only trace was a line in a log nobody reads. So whatever the server's
// storage status names as a problem (a refusing bucket, files still on local
// disk, a backup that has not run) is shown here to the practice team, on every
// page, until it is fixed. Dismissing it hides it for this page view only.
export default function StorageBanner() {
  const { membership, googleEnabled } = useAuth();
  const onTeam = isPracticeTeam(membership, googleEnabled);
  const { data } = useStorageStatus(onTeam);
  const [dismissed, setDismissed] = useState(false);
  const navigate = useNavigate();

  const problems = data?.problems ?? [];
  if (!onTeam || dismissed || !problems.length) return null;

  return (
    <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm">
      <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">File storage needs attention</p>
        <ul className="mt-0.5 space-y-0.5 text-muted-foreground">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        onClick={() => navigate('/clients#storage')}
        className="shrink-0 rounded-md bg-foreground px-3 py-1 text-xs font-medium text-background hover:opacity-90"
      >
        Details
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
