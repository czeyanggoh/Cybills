import { createContext, useContext, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Receipt,
  ShoppingCart,
  Tag,
  Plus,
  HelpCircle,
  ChevronDown,
  Users,
  User,
  History,
  Download,
  Settings,
  LogOut,
  Check,
  Building2,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import {
  useOrganisations,
  getActiveOrganisationId,
  setActiveOrganisationId,
} from '@/lib/organisations';
import AddDocumentsDrawer from './AddDocumentsDrawer';
import AddOrganisationModal from './AddOrganisationModal';
import RemoveOrganisationModal from './RemoveOrganisationModal';
import ApprovalReminderBanner from './ApprovalReminderBanner';
import JoinRequestBanner from './JoinRequestBanner';

// Primary workspaces (matches Dext's left rail: Costs / Sales / Bank / Vault).
const NAV = [
  { to: '/costs', label: 'Costs', icon: ShoppingCart },
  { to: '/sales', label: 'Sales', icon: Tag },
];

// Right-aligned top-bar tabs (support channels). Feature Requests now lives as
// a toggle inside the Support Desk board, so it no longer needs its own tab.
const TOP_TABS = [
  { to: '/support', label: 'Support Desk' },
];

const BOTTOM = [
  { label: 'Users', icon: Users, to: '/users', adminOnly: true },
  { label: 'Exports', icon: Download, to: '/exports' },
  { label: 'Submission history', icon: History, to: '/submission-history' },
  { label: 'Business settings', icon: Settings, to: '/settings', adminOnly: true },
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

// Workspace switcher (top-left). Lists the organisations linked to Xero
// tenants in cyworkspace, marks the active one (persisted in localStorage —
// it's the default destination when publishing to Xero), and hosts the
// "Add organisation" entry point.
function OrganisationSwitcher() {
  const { data: organisations = [] } = useOrganisations();
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [activeId, setActiveId] = useState(getActiveOrganisationId);

  const active = organisations.find((o) => o.id === activeId) ?? null;
  const label = active?.name || 'CYBM Workspace';

  const select = (id) => {
    setActiveOrganisationId(id);
    setActiveId(id);
    setOpen(false);
  };

  // After an organisation is unlinked, drop it as the active selection and fall
  // back to whichever one remains (or none) so the switcher label stays valid.
  const handleRemoved = (removed) => {
    if (removed.id !== activeId) return;
    const next = organisations.find((o) => o.id !== removed.id) ?? null;
    setActiveOrganisationId(next?.id ?? '');
    setActiveId(next?.id ?? '');
  };

  return (
    <div className="relative flex items-center gap-2">
      <span className="flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-semibold">
        {label.slice(0, 1).toUpperCase()}
      </span>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-sm font-medium"
      >
        {label}
        <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute left-0 top-full z-20 mt-1 w-72 overflow-hidden rounded-md border bg-background py-1 shadow-lg">
            {organisations.length === 0 && (
              <p className="px-3 py-2 text-sm text-muted-foreground">
                No organisations yet. Link one to a Xero organisation to start publishing bills.
              </p>
            )}
            {organisations.map((o) => (
              <div
                key={o.id}
                className="group flex items-center gap-1 px-1 transition-colors hover:bg-muted"
              >
                <button
                  type="button"
                  onClick={() => select(o.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-sm"
                >
                  <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{o.name}</span>
                    {o.tenantName && o.tenantName !== o.name && (
                      <span className="block truncate text-xs text-muted-foreground">{o.tenantName}</span>
                    )}
                  </span>
                  {o.id === activeId && <Check className="h-4 w-4 shrink-0" />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setRemoveTarget(o);
                  }}
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-0 transition-colors hover:bg-background hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                  aria-label={`Remove ${o.name}`}
                  title="Remove organisation"
                >
                  <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                </button>
              </div>
            ))}
            <div className="mt-1 border-t pt-1">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setAddOpen(true);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
              >
                <Plus className="h-4 w-4 text-muted-foreground" strokeWidth={2} />
                Add organisation
              </button>
            </div>
          </div>
        </>
      )}
      <AddOrganisationModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(o) => setActiveId(o.id)}
      />
      <RemoveOrganisationModal
        open={Boolean(removeTarget)}
        organisation={removeTarget}
        onClose={() => setRemoveTarget(null)}
        onRemoved={handleRemoved}
      />
    </div>
  );
}

// App chrome for the signed-in experience. `subnav` renders an optional second
// column (used by Costs for its inbox/expense-claims/suppliers list).
export default function AppShell({ subnav = null, hideSidebar = false, children }) {
  const { user, membership, googleEnabled, signOut } = useAuth();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);

  // Admin-only surfaces (Users, Business settings) are hidden from Standard
  // employees. Mock mode (no real auth) shows everything so the demo works.
  const isAdmin = !googleEnabled || ['Admin', 'Business Admin', 'User Admin'].includes(membership.user?.role);
  const bottomNav = BOTTOM.filter((item) => isAdmin || !item.adminOnly);

  const handleSignOut = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <AppShellContext.Provider value={{ openAddDocuments: () => setAddOpen(true) }}>
      {/* Viewport-locked app shell: the frame stays the height of the window and
          only <main> scrolls, so the sidebar's bottom nav (Get started, Users,
          Business settings, Sign out) is always pinned in view on every tab —
          not pushed below the fold on content-heavy pages like Costs. */}
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        {/* Primary sidebar — hidden in full-width chrome (e.g. Settings, which
            shows its own nav column + a Back link, like Dext). */}
        <aside className={cn('hidden w-56 shrink-0 flex-col border-r bg-background', hideSidebar ? 'hidden' : 'md:flex')}>
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
            {bottomNav.map((item) => (
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
            <OrganisationSwitcher />
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
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setUserMenu((o) => !o)}
                  className="flex items-center gap-2 text-sm"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-full border text-xs font-medium">
                    {initialsFrom(user)}
                  </span>
                  <span className="hidden sm:inline">{user?.name || user?.email || 'Astrid Yang'}</span>
                  <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', userMenu && 'rotate-180')} />
                </button>
                {userMenu && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setUserMenu(false)} aria-hidden="true" />
                    <div className="absolute right-0 z-20 mt-2 w-44 overflow-hidden rounded-md border bg-background py-1 shadow-lg">
                      <button
                        type="button"
                        onClick={() => { setUserMenu(false); navigate('/profile'); }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                      >
                        <User className="h-4 w-4" strokeWidth={1.75} /> Profile
                      </button>
                      {isAdmin && (
                        <button
                          type="button"
                          onClick={() => { setUserMenu(false); navigate('/settings'); }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                        >
                          <Settings className="h-4 w-4" strokeWidth={1.75} /> Business settings
                        </button>
                      )}
                      {user && (
                        <button
                          type="button"
                          onClick={() => { setUserMenu(false); handleSignOut(); }}
                          className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                        >
                          <LogOut className="h-4 w-4" strokeWidth={1.75} /> Sign out
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </header>

          <div className="flex min-h-0 flex-1">
            {subnav && (
              <aside className="hidden w-60 shrink-0 overflow-auto border-r bg-background lg:block">
                {subnav}
              </aside>
            )}
            <main className="min-w-0 flex-1 overflow-auto p-4 md:p-6">
              <JoinRequestBanner />
              <ApprovalReminderBanner />
              {children}
            </main>
          </div>
        </div>
      </div>

      <AddDocumentsDrawer open={addOpen} onClose={() => setAddOpen(false)} />
    </AppShellContext.Provider>
  );
}
