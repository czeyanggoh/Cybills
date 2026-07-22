import { useNavigate, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';

// Sub-nav for the Vault workspace.
const ITEMS = [
  { key: 'files', label: 'Files', to: '/vault' },
  { key: 'tags', label: 'Tags', to: '/vault/tags' },
  { key: 'downloads', label: 'Downloads', to: '/vault/downloads' },
];

export default function VaultSubnav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Files is active for the list and any document detail (/vault/:id).
  const isActive = (to) =>
    to === '/vault'
      ? pathname === '/vault' || (pathname.startsWith('/vault/') && !['/vault/tags', '/vault/downloads'].includes(pathname))
      : pathname === to;

  return (
    <div className="flex flex-col p-3 text-sm">
      <p className="px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Vault
      </p>
      {ITEMS.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => navigate(item.to)}
          className={cn(
            'rounded-md px-3 py-2 text-left transition-colors',
            isActive(item.to)
              ? 'bg-muted font-medium text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          )}
        >
          {item.label}
        </button>
      ))}
      <div className="my-2 h-px bg-border" />
      <button
        type="button"
        onClick={() => navigate('/settings?section=vault')}
        className="rounded-md px-3 py-2 text-left text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        Vault sync
      </button>
    </div>
  );
}
