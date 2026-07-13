import { cn } from '@/lib/utils';

// Sub-nav for the Vault workspace (single-page for now; Files is active).
const ITEMS = [
  { key: 'files', label: 'Files', active: true },
  { key: 'tags', label: 'Tags' },
  { key: 'downloads', label: 'Downloads' },
];

export default function VaultSubnav() {
  return (
    <div className="flex flex-col p-3 text-sm">
      <p className="px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Vault
      </p>
      {ITEMS.map((item) => (
        <button
          key={item.key}
          type="button"
          className={cn(
            'rounded-md px-3 py-2 text-left transition-colors',
            item.active
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
        className="rounded-md px-3 py-2 text-left text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        Vault sync
      </button>
    </div>
  );
}
