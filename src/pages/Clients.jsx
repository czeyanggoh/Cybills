import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Building2, ExternalLink, Info } from 'lucide-react';
import AppShell from '@/components/AppShell';
import { useClients, formatUsd, formatTokens } from '@/lib/practiceStore';
import { useOrganisations, setActiveOrganisationId } from '@/lib/organisations';
import { cn } from '@/lib/utils';

// Initials for the account-manager chips, same shape as the top-bar avatar.
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase();
}

function StatCard({ label, value, sub }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

// The practice's client list: every Xero tenant CYBills is connected to, who on
// the team works on it, and what it has cost in AI API usage today and this
// month. The cost is an estimate — it is priced from the tokens each extraction
// actually reported, at the published per-model rates, so it tracks the bill
// without being the bill.
export default function Clients() {
  const [query, setQuery] = useState('');
  const [showRates, setShowRates] = useState(false);
  const navigate = useNavigate();
  const { data, isLoading, error } = useClients();
  // The switcher's list is what the signed-in user may actually open; a practice
  // manager can see clients here that they haven't given themselves access to.
  const { data: mine = [] } = useOrganisations();
  const canOpen = new Set(mine.map((o) => o.id));

  const clients = data?.clients ?? [];
  const usage = data?.usage;
  const practiceName = data?.practice?.name || 'the practice';
  const rows = clients.filter((c) =>
    `${c.name} ${c.tenantName || ''}`.toLowerCase().includes(query.trim().toLowerCase())
  );
  // A bridge entity has no Xero of its own, so the column would read as a bare
  // "—" — indistinguishable from a client whose connection has broken. Say what
  // is actually true of it: its claims land in another entity's ledger.
  const xeroColumn = (c) => {
    if (c.tenantName) return c.tenantName;
    const parent = clients.find((o) => o.id === c.parentOrgId);
    return parent ? `Posts into ${parent.name}` : '—';
  };

  const open = (client) => {
    setActiveOrganisationId(client.id);
    navigate('/costs');
  };

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight">Clients</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Every Xero organisation {practiceName} is connected to, who works on it, and what
          it has cost in AI API usage.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          The practice&apos;s own list — it doesn&apos;t change with the client entity you have open.
          Use <span className="font-medium text-foreground">Open</span> on a row to work inside one.
        </p>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          label="Connected clients"
          value={isLoading ? '—' : clients.length}
          // Not every client is a Xero organisation any more: a bridge entity
          // keeps no books of its own and posts into another entity's.
          sub={
            isLoading
              ? 'Client entities'
              : `${clients.filter((c) => c.tenantId).length} linked to Xero`
          }
        />
        <StatCard
          label="AI API — today"
          value={usage ? formatUsd(usage.today.costUsd) : '—'}
          sub={usage ? `${usage.today.calls} call${usage.today.calls === 1 ? '' : 's'} · ${formatTokens(usage.today.inputTokens + usage.today.outputTokens)} tokens` : ' '}
        />
        <StatCard
          label="AI API — month to date"
          value={usage ? formatUsd(usage.monthToDate.costUsd) : '—'}
          sub={usage ? `${usage.monthToDate.calls} call${usage.monthToDate.calls === 1 ? '' : 's'} · ${formatTokens(usage.monthToDate.inputTokens + usage.monthToDate.outputTokens)} tokens` : ' '}
        />
      </div>

      {usage && (
        <div className="mb-4 rounded-lg border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          <button type="button" onClick={() => setShowRates((v) => !v)} className="flex items-center gap-1.5 font-medium text-foreground">
            <Info className="h-3.5 w-3.5" strokeWidth={1.75} />
            Estimated from token usage — how it&apos;s worked out
          </button>
          <p className="mt-1.5">
            Every extraction records the tokens it used; those are priced at the published
            per-model rates. Days roll over in {usage.timezone}. Prompt-cache reads and writes
            are priced at 0.1× and 1.25× the input rate.
            {usage.unattributed?.monthToDate?.calls > 0 && (
              <> {formatUsd(usage.unattributed.monthToDate.costUsd)} this month was used before a
              client was selected, so it isn&apos;t attributed to a row below (it is still in the
              totals above).</>
            )}
          </p>
          {showRates && (
            <table className="mt-3 w-full max-w-md">
              <thead>
                <tr className="text-left">
                  <th className="py-1 font-medium">Model</th>
                  <th className="py-1 text-right font-medium">Input / MTok</th>
                  <th className="py-1 text-right font-medium">Output / MTok</th>
                </tr>
              </thead>
              <tbody>
                {(usage.rates || []).map((r) => (
                  <tr key={r.model}>
                    <td className="py-0.5 pr-4 font-mono">{r.model}</td>
                    <td className="py-0.5 text-right tabular-nums">${r.input.toFixed(2)}</td>
                    <td className="py-0.5 text-right tabular-nums">${r.output.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="mb-4 flex items-center gap-2">
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search clients"
            className="h-8 w-56 rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[840px] text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr className="text-muted-foreground">
              <th className="px-3 py-2.5 font-medium">Name</th>
              <th className="px-3 py-2.5 font-medium">Xero organisation</th>
              <th className="px-3 py-2.5 font-medium">Account managers</th>
              <th className="px-3 py-2.5 text-right font-medium">API today</th>
              <th className="px-3 py-2.5 text-right font-medium">API month to date</th>
              <th className="px-3 py-2.5 font-medium"> </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-b last:border-0 transition-colors hover:bg-muted/40">
                <td className="px-3 py-3">
                  <span className="flex items-center gap-2 font-medium">
                    <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                    {c.name}
                  </span>
                  {c.isPrimary && <span className="ml-6 text-xs text-muted-foreground">Practice entity</span>}
                </td>
                <td className="px-3 py-3 text-muted-foreground">{xeroColumn(c)}</td>
                <td className="px-3 py-3">
                  {c.colleagues.length ? (
                    <span className="flex flex-wrap items-center gap-1">
                      {c.colleagues.slice(0, 6).map((m) => (
                        <span
                          key={m.id}
                          title={m.allClients ? `${m.name} (all clients)` : m.name}
                          className="flex h-6 w-6 items-center justify-center rounded-full border bg-muted text-[10px] font-medium"
                        >
                          {initials(m.name)}
                        </span>
                      ))}
                      {c.colleagues.length > 6 && (
                        <span className="text-xs text-muted-foreground">+{c.colleagues.length - 6}</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">Nobody assigned</span>
                  )}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {formatUsd(c.usage.today.costUsd)}
                  <span className="block text-xs text-muted-foreground">{c.usage.today.calls} calls</span>
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {formatUsd(c.usage.monthToDate.costUsd)}
                  <span className="block text-xs text-muted-foreground">{c.usage.monthToDate.calls} calls</span>
                </td>
                <td className="px-3 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => open(c)}
                    disabled={!canOpen.has(c.id)}
                    title={canOpen.has(c.id) ? `Open ${c.name}` : 'You don’t have client access to this one'}
                    className={cn(
                      'inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors',
                      canOpen.has(c.id) ? 'hover:bg-muted' : 'cursor-not-allowed opacity-40'
                    )}
                  >
                    Open <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-16 text-center text-sm text-muted-foreground">
                  {error
                    ? 'Only the practice team can see the client list.'
                    : isLoading
                      ? 'Loading clients…'
                      : query
                        ? `No clients match “${query}”.`
                        : 'No clients connected yet — link a Xero organisation to get started.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Showing {rows.length} of {clients.length} clients</p>}
    </AppShell>
  );
}
