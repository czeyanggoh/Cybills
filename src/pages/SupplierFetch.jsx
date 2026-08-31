import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Check, Plug, ArrowRight } from 'lucide-react';
import AppShell from '@/components/AppShell';
import CostsSubnav from '@/components/CostsSubnav';
import { COSTS_LABEL } from '@/lib/workspaceNames';
import { FETCH_SUPPLIERS, useSupplierConnections, toggleSupplier, fetchBillsFrom } from '@/lib/supplierFetch';
import { cn } from '@/lib/utils';

// "Auto-fetch bills from online suppliers" — connect suppliers, then pull this
// month's invoice from each straight into the Costs inbox.
export default function SupplierFetch() {
  const navigate = useNavigate();
  const conns = useSupplierConnections();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const connected = FETCH_SUPPLIERS.filter((s) => conns[s.id]);

  const fetchAll = async () => {
    if (!connected.length || busy) return;
    setBusy(true);
    setNote('');
    try {
      const { added, skipped } = await fetchBillsFrom(connected);
      setNote(
        added
          ? `Fetched ${added} bill${added === 1 ? '' : 's'} into the ${COSTS_LABEL} inbox${skipped ? ` · ${skipped} already fetched this month` : ''}.`
          : `Nothing new — all ${skipped} connected supplier bill${skipped === 1 ? '' : 's'} already fetched this month.`
      );
    } catch {
      setNote('Could not fetch bills. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell subnav={<CostsSubnav />}>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Fetch bills</h1>
        <button
          type="button"
          onClick={fetchAll}
          disabled={!connected.length || busy}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} />
          {busy ? 'Fetching…' : 'Fetch latest bills'}
        </button>
      </div>

      <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
        Connect your online suppliers and CYBills pulls each new invoice straight into your {COSTS_LABEL}
        inbox — no uploading. It fetches one bill per connected supplier per month.
      </p>

      {note && (
        <div className="mb-4 flex items-center gap-2 rounded-md border bg-muted px-3 py-2 text-sm text-foreground">
          <Check className="h-4 w-4 shrink-0" /> {note}
          <button
            type="button"
            onClick={() => navigate('/costs')}
            className="ml-auto inline-flex items-center gap-1 text-sm font-medium hover:underline"
          >
            View inbox <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {FETCH_SUPPLIERS.map((s) => {
          const on = Boolean(conns[s.id]);
          return (
            <div key={s.id} className="flex items-center justify-between rounded-lg border p-4">
              <div className="min-w-0">
                <div className="font-medium">{s.name}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{s.kind} · posts to {s.category}</div>
              </div>
              <button
                type="button"
                onClick={() => toggleSupplier(s.id)}
                className={cn(
                  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors',
                  on ? 'border-foreground bg-foreground text-background hover:opacity-90' : 'hover:bg-muted'
                )}
              >
                {on ? <><Check className="h-3.5 w-3.5" /> Connected</> : <><Plug className="h-3.5 w-3.5" /> Connect</>}
              </button>
            </div>
          );
        })}
      </div>

      {!connected.length && (
        <p className="mt-4 text-sm text-muted-foreground">Connect at least one supplier to fetch bills.</p>
      )}
    </AppShell>
  );
}
