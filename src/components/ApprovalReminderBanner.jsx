import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BellRing, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useClaims, pendingApprovalsFor } from '@/lib/claimStore';
import { useApprovalReminders } from '@/lib/approvalReminders';

// In-app delivery of approval reminders (CYBills has no mail server): when the
// signed-in user is the assigned approver on any outstanding claim and reminders
// are enabled, show a banner at the top of the app.
export default function ApprovalReminderBanner() {
  const { user } = useAuth();
  const claims = useClaims();
  const reminders = useApprovalReminders();
  const [dismissed, setDismissed] = useState(false);
  const navigate = useNavigate();

  // Matched by name OR email (same rule as the Approve action) so a roster
  // email mismatch can't hide the reminder from the approver.
  const pending = pendingApprovalsFor(claims, user);

  if (!reminders.enabled || dismissed || pending.length === 0) return null;

  return (
    <div className="mb-4 flex items-center gap-3 rounded-lg border border-foreground/20 bg-muted/50 px-4 py-2.5 text-sm">
      <BellRing className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        You have <span className="font-medium">{pending.length}</span> expense claim
        {pending.length === 1 ? '' : 's'} awaiting your approval.
      </span>
      <button
        type="button"
        onClick={() => navigate(pending.length === 1 ? `/expense-claims/${pending[0].id}` : '/expense-claims')}
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
