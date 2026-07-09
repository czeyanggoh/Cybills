import { useState } from 'react';
import AppShell from '@/components/AppShell';
import RequestBoard from '@/components/RequestBoard';
import { cn } from '@/lib/utils';

// The two views the merged Support Desk board can show. Each keeps its own
// localStorage-backed store (storageKey) so existing tickets and feature
// requests stay intact — the toggle only swaps which data/labels render.
const VIEWS = {
  support: {
    label: 'Support Desk',
    title: 'Support Desk',
    intro:
      'Log issues, feedback, or change requests below (attach a screenshot if needed). Each item can be ticked off when done.',
    emptyLabel: 'issues',
    composerPlaceholder:
      'Describe an issue or change request… Paste or drop a screenshot here. (⌘/Ctrl+Enter to send)',
    storageKey: 'cybills.support-tickets',
  },
  features: {
    label: 'Feature Requests',
    title: 'Feature Requests',
    intro:
      "List the features you'd like developed below (attach a mockup or screenshot if it helps). Support reviews each request and can reply with status or questions. Tick an item off once it's shipped.",
    emptyLabel: 'feature requests',
    composerPlaceholder:
      "Describe a feature you'd like developed… Paste or drop a mockup here. (⌘/Ctrl+Enter to send)",
    storageKey: 'cybills.feature-requests',
  },
};

const ORDER = ['support', 'features'];

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
      {/* Remount the board when the view changes so it reloads the correct
          store (each view has its own storageKey). */}
      <RequestBoard
        key={view}
        title={config.title}
        intro={config.intro}
        emptyLabel={config.emptyLabel}
        composerPlaceholder={config.composerPlaceholder}
        storageKey={config.storageKey}
        viewToggle={toggle}
      />
    </AppShell>
  );
}
