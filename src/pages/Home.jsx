import { useQuery } from '@tanstack/react-query';
import { Receipt } from 'lucide-react';

// Pings the backend /api/health so the landing page doubles as a
// front-to-back smoke test. Shows the server status once it resolves.
function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const res = await fetch('/api/health');
      if (!res.ok) throw new Error(`health check failed: ${res.status}`);
      return res.json();
    },
    retry: false,
  });
}

export default function Home() {
  const { data, isLoading, isError } = useHealth();

  const status = isLoading
    ? 'checking…'
    : isError
      ? 'unreachable'
      : `ok · ${data?.service ?? 'server'}`;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6">
      <div className="flex items-center gap-3">
        <Receipt className="h-8 w-8 text-primary" />
        <h1 className="text-3xl font-semibold tracking-tight">CYBills</h1>
      </div>
      <p className="text-muted-foreground">Billing workspace — cybills.cy-bm.sg</p>
      <div className="text-sm rounded-md border px-3 py-1.5">
        backend: <span className="font-mono">{status}</span>
      </div>
    </div>
  );
}
