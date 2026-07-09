import { useLocation } from 'react-router-dom';
import AppShell from '@/components/AppShell';

// Placeholder for the sidebar workspaces that aren't built yet (Sales, Bank,
// Suppliers, Reports). Keeps the app shell consistent instead of dead-ending.
export default function ComingSoon() {
  const { pathname } = useLocation();
  const name = pathname.replace('/', '');
  const title = name.charAt(0).toUpperCase() + name.slice(1);

  return (
    <AppShell title={title}>
      <div className="flex h-[60vh] flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">This workspace is coming soon.</p>
      </div>
    </AppShell>
  );
}
