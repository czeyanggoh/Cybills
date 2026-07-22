import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Landmark, Search, ChevronDown, Trash2 } from 'lucide-react';
import AppShell, { AddDocumentsButton } from '@/components/AppShell';
import BankSubnav from '@/components/BankSubnav';
import AddBankAccountModal from '@/components/AddBankAccountModal';
import { useBankAccounts, removeBankAccount } from '@/lib/bankAccounts';
import { cn } from '@/lib/utils';

// Shared "No bank accounts yet" empty state. `onIntegrate` routes to the
// Connections settings where an integration is set up.
function EmptyState({ onIntegrate }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Landmark className="mb-4 h-16 w-16 text-muted-foreground/40" strokeWidth={1.25} />
      <h2 className="text-lg font-semibold">No bank accounts yet</h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        You can add your bank accounts automatically by setting up an integration, or by manually
        adding a Bank Account.
      </p>
      <button
        type="button"
        onClick={onIntegrate}
        className="mt-6 inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted"
      >
        Set up an Integration
      </button>
    </div>
  );
}

export default function Bank({ view = 'transactions' }) {
  const navigate = useNavigate();
  const accounts = useBankAccounts();
  const [addOpen, setAddOpen] = useState(false);
  const [stmtTab, setStmtTab] = useState('processed');
  const goIntegrate = () => navigate('/settings?section=connections');

  const TITLES = { transactions: 'Transactions', statements: 'Statements', accounts: 'Bank accounts' };

  return (
    <AppShell subnav={<BankSubnav />}>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">{TITLES[view]}</h1>
        {view === 'accounts' ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
            >
              Add bank account
            </button>
            <AddDocumentsButton />
          </div>
        ) : (
          <AddDocumentsButton />
        )}
      </div>

      {view === 'statements' && (
        <div className="mb-4 flex items-center gap-6 border-b">
          {['processed', 'collected'].map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setStmtTab(t)}
              className={cn(
                '-mb-px border-b-2 pb-3 pt-1 text-sm capitalize transition-colors',
                stmtTab === t
                  ? 'border-foreground font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {view === 'accounts' && (
        <div className="mb-3 flex items-center gap-2">
          <div className="relative ml-auto hidden sm:block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search"
              className="h-8 w-56 rounded-md border bg-background pl-8 pr-16 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 text-xs text-muted-foreground">
              Advanced <ChevronDown className="h-3 w-3" />
            </span>
          </div>
        </div>
      )}

      {/* Accounts with rows → a table; everything else / no accounts → empty state. */}
      {view === 'accounts' && accounts.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5 font-medium">Bank</th>
                <th className="px-3 py-2.5 font-medium">Account name</th>
                <th className="px-3 py-2.5 font-medium">Reference</th>
                <th className="px-3 py-2.5 font-medium">Currency</th>
                <th className="w-12" />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="border-b last:border-0 transition-colors hover:bg-muted/40">
                  <td className="px-3 py-3">{a.bank || '—'}</td>
                  <td className="px-3 py-3 font-medium">{a.name}</td>
                  <td className="px-3 py-3 tabular-nums text-muted-foreground">{a.reference || '—'}</td>
                  <td className="px-3 py-3">{a.currency}</td>
                  <td className="px-2 py-3 text-center">
                    <button
                      type="button"
                      onClick={() => removeBankAccount(a.id)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label="Remove account"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState onIntegrate={goIntegrate} />
      )}

      <AddBankAccountModal open={addOpen} onClose={() => setAddOpen(false)} onAdded={() => setAddOpen(false)} />
    </AppShell>
  );
}
