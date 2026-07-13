import { useState } from 'react';
import { ShoppingCart, Search, ChevronDown, Filter } from 'lucide-react';
import AppShell, { AddDocumentsButton } from '@/components/AppShell';
import CostsSubnav from '@/components/CostsSubnav';
import { cn } from '@/lib/utils';

const TABS = ['Inbox', 'Processing', 'Archive'];

export default function SupplierStatements() {
  const [tab, setTab] = useState('Inbox');

  return (
    <AppShell subnav={<CostsSubnav />}>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Supplier statements</h1>
        <AddDocumentsButton />
      </div>

      <div className="mb-4 flex items-center gap-6 border-b">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              '-mb-px border-b-2 pb-3 pt-1 text-sm transition-colors',
              tab === t
                ? 'border-foreground font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" disabled className="inline-flex h-8 cursor-not-allowed items-center rounded-md border px-3 text-sm text-muted-foreground/50">
          Mark as reconciled
        </button>
        <button type="button" disabled className="inline-flex h-8 cursor-not-allowed items-center rounded-md border px-3 text-sm text-muted-foreground/50">
          Archive
        </button>
        <button type="button" disabled className="inline-flex h-8 cursor-not-allowed items-center rounded-md border px-3 text-sm text-muted-foreground/50">
          Delete
        </button>
        <div className="relative ml-auto hidden sm:block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input type="text" placeholder="Search" className="h-8 w-52 rounded-md border bg-background pl-8 pr-16 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
          <button type="button" className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground">
            Advanced <ChevronDown className="h-3 w-3" />
          </button>
        </div>
        <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Filter">
          <Filter className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>

      <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-xl border">
          <ShoppingCart className="h-8 w-8 text-muted-foreground" strokeWidth={1.5} />
        </div>
        <p className="text-lg font-semibold tracking-tight">This workspace is for supplier statements.</p>
        <p className="max-w-md text-sm text-muted-foreground">
          Use the supplier statements workspace to upload and reconcile your supplier statements.
        </p>
      </div>
    </AppShell>
  );
}
