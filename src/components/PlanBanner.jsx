import { useState } from 'react';
import { Gauge, X } from 'lucide-react';
import { useOwnPlan } from '@/lib/practiceStore';

// Said where the people using the entity will see it: this month's documents
// are nearly, or fully, used up. Past the limit a document is still filed but is
// not read, so the person who just sent one must be told why nothing happened.
// Dismissing hides it for this page view only. Hidden for an entity with no plan.
export default function PlanBanner() {
  const { data } = useOwnPlan(true);
  const [dismissed, setDismissed] = useState(false);
  const plan = data?.plan;
  if (!plan || dismissed || plan.state === 'ok') return null;

  const suspended = plan.state === 'suspended';
  const over = plan.state === 'over' || suspended;
  const text = suspended
    ? 'The free trial or subscription for this organisation has ended. New documents are filed but not read. Choose a plan and add your payment details in CYWorkspace (Plan & billing) to carry on.'
    : over
    ? `This month's limit of ${plan.cap} documents has been passed (${plan.used}). New documents are filed but not read until next month, or until the plan is upgraded. Contact CYBM to upgrade.`
    : plan.state === 'at'
      ? `This month's limit of ${plan.cap} documents has been reached. The next document will be filed but not read.`
      : `${plan.used} of ${plan.cap} documents used this month.`;

  return (
    <div className={`mb-4 flex items-start gap-3 rounded-lg border px-4 py-2.5 text-sm ${over ? 'border-red-500/40 bg-red-500/10' : 'border-amber-500/40 bg-amber-500/10'}`}>
      <Gauge className={`mt-0.5 h-4 w-4 shrink-0 ${over ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`} />
      <p className="min-w-0 flex-1">{text}</p>
      <button type="button" onClick={() => setDismissed(true)} aria-label="Dismiss" className="shrink-0 text-muted-foreground hover:text-foreground">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
