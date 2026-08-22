import { useCallback, useEffect, useState } from 'react';
import { ShoppingCart, FileText, ExternalLink, Trash2 } from 'lucide-react';
import AppShell, { AddDocumentsButton } from '@/components/AppShell';
import CostsSubnav from '@/components/CostsSubnav';
import { fetchBills, billFileUrl, updateBill, notifyBillsChanged, BILLS_CHANGED_EVENT } from '@/lib/bills';
import { nameForEmail } from '@/lib/userStore';

// Supplier statements: files uploaded via the Add-documents "Supplier statements"
// tab (kind='supplier_statement'). Stored server-side like bills but kept out of
// the Costs pipeline — no extraction/readiness, just a list to keep + open.
function useStatements() {
  const [rows, setRows] = useState([]);
  const reload = useCallback(async () => {
    const bills = await fetchBills();
    setRows(
      bills
        .filter((b) => b.kind === 'supplier_statement' && b.status !== 'deleted')
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    );
  }, []);
  useEffect(() => {
    reload();
    window.addEventListener(BILLS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(BILLS_CHANGED_EVENT, reload);
  }, [reload]);
  return rows;
}

function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '—';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${m[3]} ${MON[Number(m[2]) - 1]} ${m[1]}`;
}

export default function SupplierStatements() {
  const rows = useStatements();

  const remove = async (id) => {
    await updateBill(id, { status: 'deleted' }).catch(() => {});
    notifyBillsChanged();
  };

  return (
    <AppShell subnav={<CostsSubnav />}>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Supplier statements</h1>
        <AddDocumentsButton />
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-xl border">
            <ShoppingCart className="h-8 w-8 text-muted-foreground" strokeWidth={1.5} />
          </div>
          <p className="text-lg font-semibold tracking-tight">No supplier statements yet.</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Use <span className="font-medium text-foreground">Add documents → Supplier statements</span> to
            upload a statement. It’s stored here for reconciliation.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-muted-foreground">
                <th className="px-4 py-2 font-medium">Document</th>
                <th className="px-4 py-2 font-medium">Uploaded by</th>
                <th className="px-4 py-2 font-medium">Date added</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} className="border-b last:border-0">
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-2">
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{b.fileName || 'Statement'}</span>
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {b.owner || b.createdBy ? nameForEmail(b.owner || b.createdBy) || b.owner || b.createdBy : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{fmtDate(b.createdAt)}</td>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center justify-end gap-1">
                      {b.hasFile && (
                        <a
                          href={billFileUrl(b.id)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors hover:bg-muted"
                        >
                          <ExternalLink className="h-3.5 w-3.5" /> Open
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => remove(b.id)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                        aria-label="Delete statement"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
