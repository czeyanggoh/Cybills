import AppShell from '@/components/AppShell';
import RequestBoard from '@/components/RequestBoard';

export default function SupportDesk() {
  return (
    <AppShell>
      <RequestBoard
        title="Support Desk"
        intro="Log issues, feedback, or change requests below (attach a screenshot if needed). Each item can be ticked off when done."
        emptyLabel="issues"
        composerPlaceholder="Describe an issue or change request… Paste or drop a screenshot here. (⌘/Ctrl+Enter to send)"
        storageKey="cybills.support-tickets"
      />
    </AppShell>
  );
}
