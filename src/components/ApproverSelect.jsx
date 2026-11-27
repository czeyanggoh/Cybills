import { cn } from '@/lib/utils';

// Who one claim goes to: the name where the claimant has a single direct
// manager, a choice where they have several.
export default function ApproverSelect({ claim, managers, value, onChange }) {
  if (managers.length < 2) {
    return <span className="shrink-0 text-muted-foreground">&rarr; {managers[0]?.name}</span>;
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
      &rarr;
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`Approver for ${claim.claimFor || claim.name}`}
        className={cn(
          'h-8 w-44 rounded-md border bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring',
          !value && 'border-amber-600/60'
        )}
      >
        <option value="">Choose approver…</option>
        {managers.map((m) => (
          <option key={m.id} value={m.id}>{m.name}</option>
        ))}
      </select>
    </span>
  );
}
