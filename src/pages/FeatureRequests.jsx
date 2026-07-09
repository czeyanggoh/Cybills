import AppShell from '@/components/AppShell';
import RequestBoard from '@/components/RequestBoard';

export default function FeatureRequests() {
  return (
    <AppShell>
      <RequestBoard
        title="Feature Requests"
        intro="List the features you'd like developed below (attach a mockup or screenshot if it helps). Support reviews each request and can reply with status or questions. Tick an item off once it's shipped."
        emptyLabel="feature requests"
        composerPlaceholder="Describe a feature you'd like developed… Paste or drop a mockup here. (⌘/Ctrl+Enter to send)"
        storageKey="cybills.feature-requests"
      />
    </AppShell>
  );
}
