import { cn } from '@/lib/utils';

// How much of a workspace's book to look at: the work still outstanding, or the
// same tab with the finished documents left in.
//
// It began in the Costs tab and is now the Sales tab's as well, so it lives
// here rather than being copied — the two are the same control answering the
// same question of two books, and a second copy would drift in the small ways
// that matter: which side is the default, whether the counts are of this tab or
// of the whole book, what the active pill looks like.
//
// `counts` is each scope's reach ON THE TAB IT IS DRAWN ON, never across the
// whole book — a count that answered for another tab is a number the list
// beside it contradicts — and the caller works that out, because only the
// caller knows which tab it is.
export default function ScopeToggle({
  scope,
  setScope,
  counts,
  // Only the far side is named per workspace ("All costs" / "All sales"). The
  // near side is "Unpublished" in both, because that is what it means in both:
  // nothing has carried these figures into Xero yet.
  allLabel = 'All costs',
  label = 'Which costs to show',
}) {
  const scopes = [
    { key: 'unpublished', label: 'Unpublished' },
    { key: 'all', label: allLabel },
  ];
  return (
    <div className="mb-3 inline-flex rounded-md border p-0.5" role="group" aria-label={label}>
      {scopes.map((s) => {
        const active = scope === s.key;
        return (
          <button
            key={s.key}
            type="button"
            aria-pressed={active}
            onClick={() => setScope(s.key)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded px-3 text-sm transition-colors',
              active
                ? 'bg-foreground font-medium text-background'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {s.label}
            <span
              className={cn(
                'rounded-full px-1.5 text-xs',
                active ? 'bg-background/20 text-background' : 'bg-muted text-muted-foreground'
              )}
            >
              {counts[s.key] ?? 0}
            </span>
          </button>
        );
      })}
    </div>
  );
}
