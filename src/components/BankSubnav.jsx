import { useNavigate, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';

// Left sub-nav column for the Bank workspace.
const SUBNAV = [
  { label: 'Transactions', to: '/bank' },
  { label: 'Statements', to: '/bank/statements' },
  { label: 'Accounts', to: '/bank/accounts' },
];

export default function BankSubnav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <div className="flex flex-col p-3 text-sm">
      <p className="px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Bank</p>
      {SUBNAV.map((item) => {
        const active = pathname === item.to;
        return (
          <button
            key={item.label}
            type="button"
            onClick={() => navigate(item.to)}
            className={cn(
              'flex items-center justify-between rounded-md px-3 py-2 text-left transition-colors',
              active
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
