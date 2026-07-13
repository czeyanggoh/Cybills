import { useNavigate, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';

// Left sub-nav column for the Sales workspace.
const SUBNAV = [
  { label: 'Sales inbox', count: 2, to: '/sales' },
  { label: 'Customers', to: '/customers' },
];

export default function SalesSubnav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <div className="flex flex-col p-3 text-sm">
      <p className="px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Sales
      </p>
      {SUBNAV.map((item) => {
        const active = Boolean(item.to) && pathname === item.to;
        return (
          <button
            key={item.label}
            type="button"
            onClick={item.to ? () => navigate(item.to) : undefined}
            className={cn(
              'flex items-center justify-between rounded-md px-3 py-2 text-left transition-colors',
              active
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            {item.label}
            {item.count != null && (
              <span
                className={cn(
                  'rounded-full px-1.5 text-xs',
                  active ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
