import { createContext, useContext, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Receipt,
  ShoppingCart,
  Tag,
  Landmark,
  Archive,
  Plus,
  HelpCircle,
  ChevronDown,
  Rocket,
  Users,
  History,
  Settings,
  LogOut,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import AddDocumentsDrawer from './AddDocumentsDrawer';

// Primary workspaces (matches Dext's left rail: Costs / Sales / Bank / Vault).
const NAV = [
  { to: '/costs', label: 'Costs', icon: ShoppingCart },
  { to: '/sales', label: 'Sales', icon: Tag },
  { to: '/bank', label: 'Bank', icon: Landmark },
  { to: '/vault', label: 'Vault', icon: Archive },
];

// Right-aligned top-bar tabs (support channels). Feature Requests now lives as
// a toggle inside the Support Desk board, so it no longer needs its own tab.
const TOP_TABS = [
  { to: '/support', label: 'Support Desk' },
];

const BOTTOM = [
  { label: 'Get started', icon: Rocket },
  { label: 'Users', icon: Users, to: '/users' },
  { label: 'Submission history', icon: History, to: '/submission-history' },
  { label: 'Business settings', icon: Settings, to: '/settings' },
];

// Lets any page open the "Add documents" drawer (e.g. the Costs header button).
const AppShellContext = createContext(null);
export function useAppShell() {
  return useContext(AppShellContext) ?? { openAddDocuments: () => {} };
}

// Header "Add documents" button. Must be rendered *inside* an AppShell's
// children so it reads the live context (not the no-op fallback) — page
// components render above the provider and can't wire the opener themselves.
export function AddDocumentsButton() {
  const { openAddDocuments } = useAppShell();
  return (
    <button
      type="button"
      onClick={openAddDocuments}
      className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
    >
      <Plus className="h-4 w-4" strokeWidth={2} />
      Add documents
    </button>
  );
}

function initialsFrom(user) {
  const source = user?.name || user?.email;
  if (!source) return 'AY';
  const parts = source.replace(/@.*/, '').split(/[.\s_-]+/).filter(Boolean);
  const chars = parts.length > 1 ? parts[0][0] + parts[1][0] : source.slice(0, 2);
  return chars.toUpperCase();
}

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

// App chrome for the signed-in experience. `subnav` renders an optional second
// column (used by Costs for its inbox/expense-claims/suppliers list).
export default function AppShell({ subnav = null, children }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);

  const handleSignOut = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <AppShellContext.Provider value={{ openAddDocuments: () => setAddOpen(true) }}>
      <div className="flex min-h-screen bg-background text-foreground">
        {/* Primary sidebar */}
        <aside className="hidden w-56 shrink-0 flex-col border-r bg-background md:flex">
          <div className="flex h-14 items-center gap-2 border-b px-4">
            <Receipt className="h-5 w-5" />
            <span className="text-sm font-semibold tracking-tight">CYBills</span>
          </div>
          <div className="p-3">
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              <Plus className="h-4 w-4" strokeWidth={2} />
              Add documents
            </button>
          </div>
          <nav className="flex flex-1 flex-col gap-1 px-3">
            {NAV.map((item) => (
              <SidebarLink key={item.to} {...item} />
            ))}
          </nav>
          <div className="flex flex-col gap-1 border-t p-3">
            {BOTTOM.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={item.to ? () => navigate(item.to) : undefined}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <item.icon className="h-4 w-4" strokeWidth={1.75} />
                {item.label}
              </button>
            ))}
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

        {/* Everything right of the primary sidebar */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Global top bar: workspace switcher + help + user */}
          <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 md:px-6">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-semibold">
                C
              </span>
              <button type="button" className="flex items-center gap-1 text-sm font-medium">
                CYBM Workspace
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>
            <div className="ml-auto flex items-center gap-3">
              <nav className="flex items-center gap-1">
                {TOP_TABS.map(({ to, label }) => (
                  <NavLink
                    key={to}
                    to={to}
                    className={({ isActive }) =>
                      cn(
                        'rounded-md px-3 py-1.5 text-sm transition-colors',
                        isActive
                          ? 'bg-muted font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      )
                    }
                  >
                    {label}
                  </NavLink>
                ))}
              </nav>
              <button
                type="button"
                className="text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Help"
              >
                <HelpCircle className="h-5 w-5" strokeWidth={1.75} />
              </button>
              <button type="button" className="flex items-center gap-2 text-sm">
                <span className="flex h-7 w-7 items-center justify-center rounded-full border text-xs font-medium">
                  {initialsFrom(user)}
                </span>
                <span className="hidden sm:inline">{user?.name || user?.email || 'Astrid Yang'}</span>
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>
          </header>

          <div className="flex min-h-0 flex-1">
            {subnav && (
              <aside className="hidden w-60 shrink-0 overflow-auto border-r bg-background lg:block">
                {subnav}
              </aside>
            )}
            <main className="min-w-0 flex-1 overflow-auto p-4 md:p-6">{children}</main>
          </div>
        </div>
      </div>

      <AddDocumentsDrawer open={addOpen} onClose={() => setAddOpen(false)} />
    </AppShellContext.Provider>
  );
}
