import { Check, Loader2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

// The one place auto-save reports itself. Sits where a Save button used to, so
// the answer to "did that stick?" is always in the same spot. Renders nothing
// until something actually happens.
export default function SaveStatus({ status, className = '' }) {
  if (!status || status === 'idle') return null;
  const map = {
    saving: { icon: Loader2, text: 'Saving…', tone: 'text-muted-foreground', spin: true },
    saved: { icon: Check, text: 'Saved', tone: 'text-muted-foreground' },
    error: { icon: AlertCircle, text: 'Couldn’t save — we’ll retry on your next change', tone: 'text-destructive' },
  };
  const { icon: Icon, text, tone, spin } = map[status] ?? map.saved;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', tone, className)}>
      <Icon className={cn('h-3.5 w-3.5', spin && 'animate-spin')} />
      {text}
    </span>
  );
}
