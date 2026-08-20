import { X } from 'lucide-react';

// Derive a plausible activity timeline for a submitted item (UI only), newest
// first. The final "uploaded" event is the origin (highlighted dot).
function buildEvents(item) {
  if (!item) return [];
  const who = item.submittedBy || 'a user';
  const owner = item.ownedBy || who;
  const via = item.method === 'Via mobile' ? 'via mobile' : 'via web';
  const events = [
    { text: `This item was uploaded ${via}`, by: who, at: `${item.submittedAt} · 09:46`, origin: true },
    { text: 'Processing was completed by CYBills AI', by: 'CYBills AI', at: `${item.submittedAt} · 09:47` },
    { text: 'This item was viewed for the first time', by: owner, at: `${item.submittedAt} · 09:48` },
  ];
  if (item.status === 'ready' || item.status === 'expenseclaim') {
    events.push({ text: 'This item was moved to Ready tab.', by: owner, at: `${item.submittedAt} · 09:48` });
  }
  if (item.status === 'expenseclaim') {
    events.push({ text: 'This item was added to an expense claim', by: owner, at: `${item.submittedAt} · 09:49` });
  }
  return events.reverse();
}

// "History for item …" dialog — a vertical activity timeline. Pass a submission
// `item`; events are derived from its status/method.
export default function HistoryModal({ open, onClose, item }) {
  if (!open || !item) return null;
  const events = buildEvents(item);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">History for item {item.id}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-5">
          <ol className="relative space-y-6">
            {events.map((e, i) => (
              <li key={i} className="relative flex gap-4">
                {/* Connecting line + dot */}
                <div className="flex flex-col items-center">
                  <span
                    className={
                      e.origin
                        ? 'mt-1 h-3 w-3 rounded-full bg-foreground ring-4 ring-muted'
                        : 'mt-1 h-3 w-3 rounded-full border-2 border-foreground bg-background'
                    }
                  />
                  {i < events.length - 1 && <span className="mt-1 w-px flex-1 bg-border" />}
                </div>
                <div className="pb-1">
                  <p className="text-sm">
                    <span className="font-medium">{e.text}</span>{' '}
                    <span className="text-muted-foreground">by {e.by}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{e.at}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div className="flex items-center justify-end border-t px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
