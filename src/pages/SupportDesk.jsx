import { useState } from 'react';
import AppShell from '@/components/AppShell';
import RequestBoard from '@/components/RequestBoard';
import { cn } from '@/lib/utils';

// The three Support Desk views. Each maps to a server-backed board (shared
// across the workspace); the toggle just swaps which board/labels render. The
// Testing checklist is seeded server-side (see server/src/board.ts).
//
// legacyKey is the localStorage key this board used before it moved
// server-side. RequestBoard drains it into the shared board once, so entries
// filed back when each browser kept its own copy stop being invisible to
// everyone else. Safe to drop once every user has loaded the app at least once.

const VIEWS = {
  support: {
    label: 'Support Desk',
    title: 'Support Desk',
    intro:
      'Log issues, feedback, or change requests below (attach a screenshot if needed). Each item can be ticked off when done.',
    emptyLabel: 'issues',
    composerPlaceholder:
      'Describe an issue or change request… Paste or drop a screenshot here. (⌘/Ctrl+Enter to send)',
    board: 'support',
    legacyKey: 'cybills.support-tickets',
  },
  features: {
    label: 'Feature Requests',
    title: 'Feature Requests',
    intro:
      "List the features you'd like developed below (attach a mockup or screenshot if it helps). Support reviews each request and can reply with status or questions. Tick an item off once it's shipped.",
    emptyLabel: 'feature requests',
    composerPlaceholder:
      "Describe a feature you'd like developed… Paste or drop a mockup here. (⌘/Ctrl+Enter to send)",
    board: 'features',
    legacyKey: 'cybills.feature-requests',
  },
  testing: {
    label: 'Testing',
    title: 'Testing checklist',
    intro:
      'Every function to verify, one action per line. Test it on the live site, tick it off, and attach a screenshot as proof. Add extra checks at the bottom if needed.',
    emptyLabel: 'test items',
    composerPlaceholder:
      'Add another thing to test… Paste or drop a screenshot here. (⌘/Ctrl+Enter to send)',
    board: 'testing',
    legacyKey: 'cybills.testing-checklist',
  },
};

const ORDER = ['support', 'features', 'testing'];

export default function SupportDesk() {
  const [view, setView] = useState('support');
  const config = VIEWS[view];

  // Segmented toggle handed to the board so it renders under the header.
  const toggle = (
    <div className="inline-flex rounded-lg border bg-muted p-0.5">
      {ORDER.map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => setView(key)}
          aria-pressed={view === key}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm transition-colors',
            view === key
              ? 'bg-background font-medium text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {VIEWS[key].label}
        </button>
      ))}
    </div>
  );

  return (
    <AppShell>
      {/* Remount the board when the view changes so it loads the right board. */}
      <RequestBoard
        key={view}
        title={config.title}
        intro={config.intro}
        emptyLabel={config.emptyLabel}
        composerPlaceholder={config.composerPlaceholder}
        board={config.board}
        legacyKey={config.legacyKey}
        viewToggle={toggle}
      />
    </AppShell>
  );
}
