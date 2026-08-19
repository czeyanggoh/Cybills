import { useNavigate, useLocation } from 'react-router-dom';
import { useCostsCounts } from '@/lib/costsData';
import { useClaims, pendingApprovalsFor } from '@/lib/claimStore';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

export default function CostsSubnav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const counts = useCostsCounts();
  const claims = useClaims();
  const { user } = useAuth();
  // Claims awaiting the signed-in user's approval — shown as a red badge so a
  // pending approval stays visible even after the reminder banner is dismissed.
  const pendingApprovals = pendingApprovalsFor(claims, user).length;
  // A cost document opened from inside a claim (/costs/<id> where <id> is a
  // claim line item) belongs to Expense claims, so highlight that — not Inbox.
  const costItemId = pathname.startsWith('/costs/') ? pathname.slice('/costs/'.length) : '';
  const itemInClaim =
    Boolean(costItemId) &&
    claims.some((c) => (c.transactions || []).some((t) => String(t.itemId) === costItemId));
  const isActive = (item) => {
    if (item.to === '/costs') {
      return (
        pathname === '/costs' ||
        (pathname.startsWith('/costs/') &&
          pathname !== '/costs/exports' &&
          pathname !== '/costs/fetch' &&
          !itemInClaim)
      );
    }
    if (item.to === '/expense-claims') {
      return pathname === '/expense-claims' || pathname.startsWith('/expense-claims/') || itemInClaim;
    }
    return pathname === item.to;
  };

  // Live counts so the subnav badges match the inbox tab + expense claims list.
  const SUBNAV = [
    { label: 'Costs inbox', count: counts.inbox, to: '/costs' },
    { label: 'Expense claims', count: counts.expenseClaims, pending: pendingApprovals, to: '/expense-claims' },
    { label: 'Supplier statements', to: '/supplier-statements' },
    { label: 'Fetch bills', to: '/costs/fetch' },
    { label: 'Exports', to: '/costs/exports' },
  ];

  return (
    <div className="flex flex-col p-3 text-sm">
      <p className="px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Costs
      </p>
      {SUBNAV.map((item) => {
        const active = Boolean(item.to) && isActive(item);
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
            <span className="flex items-center gap-1">
              {item.pending > 0 && (
                <span
                  title={`${item.pending} claim${item.pending === 1 ? '' : 's'} awaiting your approval`}
                  className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-medium text-white"
                >
                  {item.pending}
                </span>
              )}
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
            </span>
          </button>
        );
      })}
      <div className="my-2 h-px bg-border" />
      <button
        type="button"
        onClick={() => navigate('/suppliers')}
        className={cn(
          'rounded-md px-3 py-2 text-left transition-colors',
          pathname === '/suppliers'
            ? 'bg-muted font-medium text-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        )}
      >
        Suppliers
      </button>
    </div>
  );
}
