import FlagMenu from '@/components/FlagMenu';
import ReceiptViewer from '@/components/ReceiptViewer';
import { useCategoryDisplayMode, formatCategory } from '@/lib/categoryDisplay';
import { formatDate } from '@/lib/date';
import { cn } from '@/lib/utils';

// The document list, as CARDS, for phones.
//
// The table this stands in for is a thousand pixels wide — sensible on a
// desktop, useless on a 390px screen, where it pushed the whole page sideways
// and left Supplier, Category and Total off the edge. You could see Status,
// User and Date: the three columns that tell you least.
//
// A card is not a narrower table. It drops the grid and shows what identifies a
// document — who it is from, when, what it cost — with the account code and the
// status underneath, so a row is legible without scrolling anywhere. Editing a
// field in place is a desktop job; here a tap opens the document, which is the
// screen with every field on it.
export default function DocCardList({
  rows,
  selected,
  onToggle,
  onOpen,
  // The one action a card carries besides opening: delete on the Costs inbox,
  // remove-from-claim on a claim. Passed in as { icon, label, title, onClick }
  // rather than assumed, because they are not the same act.
  action,
  // How the caller labels a row's state (status tag, "Needs: …"). Passed in
  // rather than rebuilt here, so the card can't drift from the table.
  badge,
  emptyLabel = 'Nothing here yet.',
}) {
  const mode = useCategoryDisplayMode();
  if (!rows.length) {
    return <p className="rounded-lg border px-4 py-8 text-center text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <ul className="space-y-2">
      {rows.map((d) => {
        const ticked = selected.has(d.id);
        return (
          <li
            key={d.id}
            className={cn(
              'rounded-lg border transition-colors',
              ticked ? 'border-foreground bg-muted/40' : 'bg-background'
            )}
          >
            <div className="flex items-start gap-3 p-3">
              {/* A 44px target — a 16px checkbox is not tappable. */}
              <label className="-m-1.5 flex min-h-11 min-w-11 shrink-0 items-center justify-center p-1.5">
                <span className="sr-only">Select {d.supplier}</span>
                <input
                  type="checkbox"
                  checked={ticked}
                  onChange={() => onToggle(d.id)}
                  className="h-5 w-5 accent-black"
                />
              </label>

              <button
                type="button"
                onClick={() => onOpen(d)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className={cn('min-w-0 break-words text-sm', d.unread ? 'font-semibold' : 'font-medium')}>
                    {d.supplier}
                  </span>
                  <span className="shrink-0 text-right text-sm font-semibold tabular-nums">
                    {d.currency} {d.total}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="tabular-nums">{formatDate(d.date)}</span>
                  {Number(String(d.tax ?? '').replace(/[^0-9.-]/g, '')) > 0 && (
                    <span className="tabular-nums">Tax {d.tax}</span>
                  )}
                </div>
                <div className="mt-1.5 break-words text-xs text-muted-foreground">
                  {formatCategory(d.category, mode)}
                </div>
              </button>
            </div>

            <div className="flex items-center gap-1 border-t px-2 py-1.5">
              <FlagMenu id={d.id} />
              <ReceiptViewer itemIds={d.id} />
              {badge && <span className="ml-1 min-w-0 truncate">{badge(d)}</span>}
              <span className="ml-auto" />
              {action && (
                <button
                  type="button"
                  onClick={() => action.onClick(d)}
                  aria-label={`${action.label} ${d.supplier}`}
                  title={action.title || action.label}
                  className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-destructive"
                >
                  <action.icon className="h-4 w-4" strokeWidth={1.75} />
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
