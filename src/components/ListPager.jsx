import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PAGE_SIZES, pageOf, pageForSize } from '@/lib/listPage';

// The foot of a long list: where it is, how many a page, and the way to the
// next page. See listPage.js for why the table shows a page and the list does
// not. Drawn only where there is more than one page's worth to choose between —
// a list of ten needs none of it.
export default function ListPager({ total, size, setSize, page, setPage, noun = 'documents', prefix = '' }) {
  const at = pageOf(total, size, page);
  const per = size || 0;
  const paged = total > Math.min(...PAGE_SIZES.filter(Boolean));
  const step = per || total;
  const btn =
    'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40';
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
      <span>
        {prefix}
        {at.end === total && at.start === 0
          ? `Showing ${total} of ${total} ${noun}`
          : `Showing ${at.start + 1}–${at.end} of ${total} ${noun}`}
      </span>
      {paged && (
        <>
          <div className="inline-flex items-center gap-1" role="group" aria-label="Rows per page">
            <span className="mr-1">Per page</span>
            {PAGE_SIZES.map((s) => {
              const active = per === s;
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setSize(s);
                    setPage(pageForSize(at.start, s));
                  }}
                  className={cn(
                    'h-7 rounded-md px-2 tabular-nums transition-colors',
                    active ? 'bg-foreground font-medium text-background' : 'hover:bg-muted hover:text-foreground'
                  )}
                >
                  {s || 'All'}
                </button>
              );
            })}
          </div>
          {at.pages > 1 && (
            <div className="ml-auto inline-flex items-center gap-2">
              <button type="button" className={btn} disabled={at.page === 0} onClick={() => setPage(at.page - 1)}>
                <ChevronLeft className="h-3.5 w-3.5" />
                Previous {step}
              </button>
              <span className="tabular-nums">
                Page {at.page + 1} of {at.pages}
              </span>
              <button
                type="button"
                className={btn}
                disabled={at.page >= at.pages - 1}
                onClick={() => setPage(at.page + 1)}
              >
                {total > at.end ? `Next ${Math.min(step, total - at.end)}` : 'Next'}
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
