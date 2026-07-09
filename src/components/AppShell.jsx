import { NavLink, useNavigate } from 'react-router-dom';
import {
  Receipt,
  ShoppingCart,
  Landmark,
  Users,
  BarChart3,
  Search,
  Settings,
  LogOut,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';

// Two-letter avatar initials from an email/name, falling back to "AY".
function initialsFrom(user) {
  const source = user?.name || user?.email;
  if (!source) return 'AY';
  const parts = source.replace(/@.*/, '').split(/[.\s_-]+/).filter(Boolean);
  const chars = parts.length > 1 ? parts[0][0] + parts[1][0] : source.slice(0, 2);
  return chars.toUpperCase();
}

// Dext-inspired workspaces, rendered black & white / minimalist (see the
// design-style house rule). Costs is the signature screen; the rest are stubs.
const NAV = [
  { to: '/costs', label: 'Costs', icon: Receipt },
  { to: '/sales', label: 'Sales', icon: ShoppingCart },
  { to: '/bank', label: 'Bank', icon: Landmark },
  { to: '/suppliers', label: 'Suppliers', icon: Users },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
];

function SidebarLink({ to, label, icon: Icon }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
          isActive
            ? 'bg-muted font-medium text-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        )
      }
    >
      <Icon className="h-4 w-4" strokeWidth={1.75} />
      {label}
    </NavLink>
  );
}

// App chrome for the signed-in experience: fixed left sidebar + top bar, with
// the page rendered into the scrollable main column.
export default function AppShell({ title, actions = null, children }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Sidebar */}
      <aside className="hidden w-56 shrink-0 flex-col border-r bg-background md:flex">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <Receipt className="h-5 w-5" />
          <span className="text-sm font-semibold tracking-tight">CYBills</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-3">
          {NAV.map((item) => (
            <SidebarLink key={item.to} {...item} />
          ))}
        </nav>
        <div className="flex flex-col gap-1 border-t p-3">
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Settings className="h-4 w-4" strokeWidth={1.75} />
            Settings
          </button>
          {user && (
            <button
              type="button"
              onClick={handleSignOut}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <LogOut className="h-4 w-4" strokeWidth={1.75} />
              Sign out
            </button>
          )}
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-4 border-b px-4 md:px-6">
          <h1 className="text-sm font-semibold tracking-tight">{title}</h1>
          <div className="relative ml-auto hidden sm:block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search"
              className="h-9 w-56 rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          {actions}
          <div
            title={user?.email ?? 'Signed in (demo)'}
            className="flex h-8 w-8 items-center justify-center rounded-full border text-xs font-medium"
          >
            {initialsFrom(user)}
          </div>
        </header>
        <main className="min-w-0 flex-1 overflow-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
