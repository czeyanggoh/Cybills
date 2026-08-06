import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserPlus, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useUsers } from '@/lib/userStore';

// In-app notification to admins that self-signup requests are awaiting approval.
// CYBills has no mail server, so alerts live in the app (same pattern as the
// approval-reminder banner). Shown to admins; in mock/demo mode (no real auth)
// it shows to everyone so the flow is visible. It clears itself once every
// pending request has been approved.
export default function JoinRequestBanner() {
  const { googleEnabled, membership } = useAuth();
  const users = useUsers();
  const [dismissed, setDismissed] = useState(false);
  const navigate = useNavigate();

  const pending = users.filter((u) => u.pending && !u.deactivated);
  const role = membership.user?.role || '';
  const isAdmin = !googleEnabled || ['Business Admin', 'User Admin'].includes(role);

  if (!isAdmin || dismissed || pending.length === 0) return null;

  return (
    <div className="mb-4 flex items-center gap-3 rounded-lg border border-foreground/20 bg-muted/50 px-4 py-2.5 text-sm">
      <UserPlus className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{pending.length}</span> new access request
        {pending.length === 1 ? '' : 's'} awaiting your approval.
      </span>
      <button
        type="button"
        onClick={() => navigate('/users?tab=pending')}
        className="shrink-0 rounded-md bg-foreground px-3 py-1 text-xs font-medium text-background hover:opacity-90"
      >
        Review
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
