import { cn } from '@/lib/utils';

// Left sub-nav column for the Costs workspace (shared by the inbox + detail).
const SUBNAV = [
  { label: 'Costs inbox', count: 78, active: true },
  { label: 'Expense claims', count: 62 },
  { label: 'Supplier statements' },
];

export default function CostsSubnav() {
  return (
    <div className="flex flex-col p-3 text-sm">
      <p className="px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Costs
      </p>
      {SUBNAV.map((item) => (
        <button
          key={item.label}
          type="button"
          className={cn(
            'flex items-center justify-between rounded-md px-3 py-2 text-left transition-colors',
            item.active
              ? 'bg-muted font-medium text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          )}
        >
          {item.label}
          {item.count != null && (
            <span
              className={cn(
                'rounded-full px-1.5 text-xs',
                item.active ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'
              )}
            >
              {item.count}
            </span>
          )}
        </button>
      ))}
      <div className="my-2 h-px bg-border" />
      <button
        type="button"
        className="rounded-md px-3 py-2 text-left text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        Suppliers
      </button>
    </div>
  );
}
