import { useLocation } from 'react-router-dom';
import AppShell from '@/components/AppShell';

// Placeholder for the sidebar workspaces that aren't built yet (Sales, Bank,
// Vault). Keeps the app shell consistent instead of dead-ending.
export default function ComingSoon() {
  const { pathname } = useLocation();
  const name = pathname.replace('/', '');
  const title = name.charAt(0).toUpperCase() + name.slice(1);

  return (
    <AppShell>
      <h1 className="mb-6 text-xl font-semibold tracking-tight">{title}</h1>
      <div className="flex h-[50vh] flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">This workspace is coming soon.</p>
      </div>
    </AppShell>
  );
}
