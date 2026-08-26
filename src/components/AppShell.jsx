import { createContext, useContext, useEffect, useState } from 'react';
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
  Briefcase,
  UserCog,
  Trash2,
  Menu,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import {
  useOrganisations,
  getActiveOrganisationId,
  setActiveOrganisationId,
} from '@/lib/organisations';
import { canManageBusiness, canManageUsers } from '@/lib/userStore';
import { isPracticeTeam, canManagePractice } from '@/lib/practiceStore';
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

// `requires` names the access each item needs: 'users' (either admin tier),
// 'business' (Business Admin only), 'practiceTeam' (any colleague of the
// practice) or 'practice' (the colleagues who run it). Unset = everyone.
const BOTTOM = [
  { label: 'Clients', icon: Briefcase, to: '/clients', requires: 'practiceTeam' },
  { label: 'Colleagues', icon: UserCog, to: '/colleagues', requires: 'practice' },
  { label: 'Users', icon: Users, to: '/users', requires: 'users' },
  { label: 'Exports', icon: Download, to: '/exports' },
  { label: 'Submission history', icon: History, to: '/submission-history' },
  { label: 'Business settings', icon: Settings, to: '/settings', requires: 'business' },
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

// Live matchMedia, so the shell reacts to a window being dragged narrower
// rather than only to a reload.
function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false; // no matchMedia (SSR/tests) — assume the roomy layout
    }
  });
  useEffect(() => {
    let mq;
    try {
      mq = window.matchMedia(query);
    } catch {
      return undefined;
    }
    const sync = () => setMatches(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [query]);
  return matches;
}

function SidebarLink({ to, label, icon: Icon, showLabel = true }) {
  return (
    <NavLink
      to={to}
      title={showLabel ? undefined : label}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-md py-2 text-sm transition-colors',
          showLabel ? 'px-3' : 'justify-center px-0',
          isActive
            ? 'bg-muted font-medium text-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
      {showLabel && label}
    </NavLink>
  );
}

// Workspace switcher (top-left). Lists the organisations linked to Xero
// tenants in cyworkspace, marks the active one (persisted in localStorage —
// it's the default destination when publishing to Xero), and hosts the
// "Add organisation" entry point.
function OrganisationSwitcher() {
  const { data: organisations = [], isFetching } = useOrganisations();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [activeId, setActiveId] = useState(getActiveOrganisationId);

  const active = organisations.find((o) => o.id === activeId) ?? null;
  const label = active?.name || 'CYBM Workspace';

  // Pin the implied selection. Everywhere else falls back to organisations[0]
  // when nothing is stored, so an unset selection silently means "the first
  // one" — except for per-org settings blobs, which would key to 'default' and
  // then look wiped the day the user first opens this switcher. Writing it down
  // makes every consumer agree on the same org from the start.
  useEffect(() => {
    if (!organisations.length) return;
    // A list being refetched cannot say what is on offer. Adding an entity
    // selects it and refetches at the same moment, so judging the new selection
    // against the OLD list found it missing and bounced straight back to the
    // first entity A→Z — the new one looked as though it had never been created.
    if (isFetching) return;
    // Also covers a selection that is no longer offered — an entity that was
    // unlinked, or one this user's client access no longer includes. Left
    // pinned, every request would carry an org header the server rejects.
    if (activeId && organisations.some((o) => o.id === activeId)) return;
    setActiveOrganisationId(organisations[0].id);
    setActiveId(organisations[0].id);
  }, [activeId, organisations, isFetching]);

  const select = (id) => {
    if (id === activeId) {
      setOpen(false);
      return;
    }
    setActiveOrganisationId(id);
    setActiveId(id);
    setOpen(false);
    // Land in the new organisation's Costs inbox. Staying put would leave you
    // looking at a page scoped to the organisation you just left — worse, a
    // detail route (/costs/:id, /expense-claims/:id) points at a document that
    // doesn't exist over here. Costs is the app's home tab, so switching
    // organisation behaves like opening it fresh.
    navigate('/costs');
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
    <div className="relative flex min-w-0 items-center gap-2">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold">
        {label.slice(0, 1).toUpperCase()}
      </span>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={label}
        className="flex min-w-0 items-center gap-1 text-sm font-medium"
      >
        {/* A client's full registered name ("Red Alpha Cybersecurity Pte. Ltd.")
            wrapped the header onto two lines on a phone. It truncates instead —
            the full name is one tap away in the list below. */}
        <span className="truncate">{label}</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
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
  const [mobileNav, setMobileNav] = useState(false); // phone (<md) nav drawer
  // Tight window → the sidebar drops to an icon rail and flies out under the
  // cursor (Dext's behaviour), so a narrow browser spends its width on the
  // document rather than on two nav columns. Roomy window → nothing changes.
  const tight = useMediaQuery('(max-width: 1279px)');
  const [railHover, setRailHover] = useState(false);
  // Settings (hideSidebar) still needs its OWN nav column — the sub-nav now lives
  // inside this sidebar, so hiding the whole thing left Business settings with no
  // tabs. In that mode show a dedicated, always-expanded column of just the
  // sub-nav (which carries its own Back link); no rail, no primary/bottom nav.
  const settingsCol = hideSidebar && Boolean(subnav);
  const flyout = tight && railHover && !settingsCol; // expanded, floating over the content
  const showLabels = !tight || railHover || settingsCol;

  // Admin surfaces are hidden from those who can't use them: Business settings
  // is Business Admin only, Users is either admin tier. A signed-in user's real
  // role decides this; mock mode (no real auth) shows everything so the demo
  // works.
  const canBusiness = canManageBusiness(membership, googleEnabled);
  const canUsers = canManageUsers(membership, googleEnabled);
  // The practice surfaces belong to CYBM's own team: Clients to any colleague,
  // Colleagues to the ones who run the practice. A client's own staff never see
  // either — from inside a client entity, the practice doesn't exist.
  const allowed = {
    business: canBusiness,
    users: canUsers,
    practiceTeam: isPracticeTeam(membership, googleEnabled),
    practice: canManagePractice(membership, googleEnabled),
  };
  const bottomNav = BOTTOM.filter((item) => !item.requires || allowed[item.requires]);
  // Prefer the CYBills roster identity (managed in Users) over the raw session,
  // whose name comes from the Google profile — which may differ (e.g. a Google
  // account named "Astrid Yang" signed in under a different roster user).
  const displayUser = membership?.user || user;

  const handleSignOut = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <AppShellContext.Provider value={{ openAddDocuments: () => setAddOpen(true) }}>
      {/* Viewport-locked app shell: the frame stays the height of the window and
          only <main> scrolls, so the sidebar's bottom nav (Users, Exports,
          Submission history, Business settings, Sign out) is always pinned in
          view on every tab —
          not pushed below the fold on content-heavy pages like Costs. */}
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        {/* Primary sidebar — hidden in full-width chrome (e.g. Settings, which
            shows its own nav column + a Back link, like Dext). */}
        <aside
          onMouseEnter={() => setRailHover(true)}
          onMouseLeave={() => setRailHover(false)}
          className={cn(
            'relative hidden shrink-0 flex-col border-r bg-background transition-[width] duration-150',
            tight && !settingsCol ? 'w-14' : 'w-56',
            hideSidebar && !subnav ? 'hidden' : 'md:flex',
          )}
        >
          {/* Collapsed, this fills the rail. Hovered, it lifts out of the flow
              and floats over the content at full width — the rail keeps its
              place, so nothing reflows underneath. */}
          <div
            className={cn(
              'flex h-full flex-col',
              flyout && 'absolute inset-y-0 left-0 z-40 w-56 border-r bg-background shadow-xl',
            )}
          >
            <div className={cn('flex h-14 shrink-0 items-center gap-2 border-b', showLabels ? 'px-4' : 'justify-center px-0')}>
              <Receipt className="h-5 w-5 shrink-0" />
              {showLabels && <span className="text-sm font-semibold tracking-tight">CYBills</span>}
            </div>
            {!settingsCol && (
              <div className={cn('shrink-0', showLabels ? 'p-3' : 'px-2 py-3')}>
                <button
                  type="button"
                  onClick={() => setAddOpen(true)}
                  title={showLabels ? undefined : 'Add documents'}
                  className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
                >
                  <Plus className="h-4 w-4 shrink-0" strokeWidth={2} />
                  {showLabels && 'Add documents'}
                </button>
              </div>
            )}
            {!settingsCol && (
              <nav className={cn('flex flex-col gap-1', showLabels ? 'px-3' : 'px-2')}>
                {NAV.map((item) => (
                  <SidebarLink key={item.to} {...item} showLabel={showLabels} />
                ))}
              </nav>
            )}
            {/* The section's own nav (Costs inbox, Expense claims…) sits INSIDE
                this column rather than in a second one beside it — one list to
                read, and the content gets the width back. Collapsed to the rail
                it would be labels in 56px, so it waits for the fly-out. */}
            {showLabels && subnav && (
              <div className={cn('min-h-0 flex-1 overflow-auto border-t', !settingsCol && 'mt-2')}>{subnav}</div>
            )}
            {!settingsCol && (
            <div className={cn('flex flex-col gap-1 border-t', showLabels ? 'p-3' : 'px-2 py-3', !(showLabels && subnav) && 'mt-auto')}>
              {bottomNav.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={item.to ? () => navigate(item.to) : undefined}
                  title={showLabels ? undefined : item.label}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                    showLabels ? 'px-3' : 'justify-center px-0',
                  )}
                >
                  <item.icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                  {showLabels && item.label}
                </button>
              ))}
              {user && (
                <button
                  type="button"
                  onClick={handleSignOut}
                  title={showLabels ? undefined : 'Sign out'}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                    showLabels ? 'px-3' : 'justify-center px-0',
                  )}
                >
                  <LogOut className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                  {showLabels && 'Sign out'}
                </button>
              )}
            </div>
            )}
          </div>
        </aside>

        {/* Everything right of the primary sidebar */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Global top bar: workspace switcher + help + user */}
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 md:gap-3 md:px-6">
            {/* Phone (<md): the sidebar is hidden, so this is the only way to
                navigate. Opens a full nav drawer. */}
            <button
              type="button"
              onClick={() => setMobileNav(true)}
              className="-ml-1 flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" strokeWidth={1.75} />
            </button>
            <OrganisationSwitcher />
            <div className="ml-auto flex shrink-0 items-center gap-2 md:gap-3">
              <nav className="hidden items-center gap-1 sm:flex">
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
                    {initialsFrom(displayUser)}
                  </span>
                  <span className="hidden sm:inline">{displayUser?.name || displayUser?.email || 'Account'}</span>
                  <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', userMenu && 'rotate-180')} />
                </button>
                {userMenu && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setUserMenu(false)} aria-hidden="true" />
                    <div className="absolute right-0 z-20 mt-2 w-64 overflow-hidden rounded-md border bg-background py-1 shadow-lg">
                      {/* Which account this actually is. The name alone can't
                          answer it — a Google profile and a CYBills roster row
                          can read the same, and signing in as somebody else
                          then looks exactly like not having switched at all. */}
                      <div className="border-b px-3 pb-2 pt-1.5">
                        <p className="truncate text-sm font-medium">{displayUser?.name || 'Account'}</p>
                        <p className="truncate text-xs text-muted-foreground">{user?.email || displayUser?.email || 'Not signed in'}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => { setUserMenu(false); navigate('/profile'); }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                      >
                        <User className="h-4 w-4" strokeWidth={1.75} /> Profile
                      </button>
                      {canBusiness && (
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
            <main className="min-w-0 flex-1 overflow-auto p-4 md:p-6">
              <JoinRequestBanner />
              <ApprovalReminderBanner />
              {children}
            </main>
          </div>
        </div>
      </div>

      {/* Phone nav drawer (<md). The desktop sidebar is hidden at this width, so
          this overlay is the navigation: primary tabs, the page's own sub-nav,
          the admin/bottom links, and sign out. */}
      {mobileNav && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-foreground/30" onClick={() => setMobileNav(false)} aria-hidden="true" />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col overflow-y-auto bg-background shadow-xl">
            <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
              <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
                <Receipt className="h-5 w-5" /> CYBills
              </span>
              <button type="button" onClick={() => setMobileNav(false)} className="text-muted-foreground hover:text-foreground" aria-label="Close menu">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-3">
              <button
                type="button"
                onClick={() => { setMobileNav(false); setAddOpen(true); }}
                className="mb-2 flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
              >
                <Plus className="h-4 w-4" strokeWidth={2} /> Add documents
              </button>
              <nav className="flex flex-col gap-1">
                {NAV.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={() => setMobileNav(false)}
                    className={({ isActive }) => cn('flex items-center gap-3 rounded-md px-3 py-2 text-sm', isActive ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted')}
                  >
                    <item.icon className="h-4 w-4" strokeWidth={1.75} /> {item.label}
                  </NavLink>
                ))}
              </nav>
              {subnav && <div className="mt-2 border-t pt-2" onClick={() => setMobileNav(false)}>{subnav}</div>}
              <div className="mt-2 flex flex-col gap-1 border-t pt-2">
                {/* The header's Support Desk tab is hidden at this width, so it
                    has to live here — hiding a link is only acceptable when it
                    is reachable somewhere else. */}
                {TOP_TABS.map(({ to, label }) => (
                  <NavLink
                    key={to}
                    to={to}
                    onClick={() => setMobileNav(false)}
                    className={({ isActive }) => cn('flex items-center gap-3 rounded-md px-3 py-2 text-sm', isActive ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
                  >
                    <HelpCircle className="h-4 w-4" strokeWidth={1.75} /> {label}
                  </NavLink>
                ))}
                {bottomNav.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => { setMobileNav(false); if (item.to) navigate(item.to); }}
                    className="flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <item.icon className="h-4 w-4" strokeWidth={1.75} /> {item.label}
                  </button>
                ))}
                {user && (
                  <button
                    type="button"
                    onClick={() => { setMobileNav(false); handleSignOut(); }}
                    className="flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <LogOut className="h-4 w-4" strokeWidth={1.75} /> Sign out
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <AddDocumentsDrawer open={addOpen} onClose={() => setAddOpen(false)} />
    </AppShellContext.Provider>
  );
}
