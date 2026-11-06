import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { setClientPlan } from '@/lib/practiceStore';
import { cn } from '@/lib/utils';

// A client's subscription on the Clients page: the level it is on and how many
// documents it has used this month against that level's limit. The practice's
// own control, so the server (PUT /api/plan/:id) is what refuses anybody else.
// No plan reads "None": a client from before subscriptions, unlimited.
export const LEVELS = [
  { level: '39.90', cap: 100 },
  { level: '69.90', cap: 300 },
  { level: '99.90', cap: 600 },
  { level: '199.90', cap: 1500 },
];

const STATE_STYLE = {
  ok: 'text-muted-foreground',
  near: 'text-amber-600 dark:text-amber-400',
  at: 'text-amber-600 dark:text-amber-400',
  over: 'text-red-600 dark:text-red-400',
};

export default function PlanCell({ client, onChanged }) {
  const plan = client.plan;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // A plan on a custom limit is not one of the four levels; keep it selectable as itself.
  const known = !plan || LEVELS.some((l) => l.level === plan.level && l.cap === plan.cap);

  const change = async (e) => {
    const level = e.target.value;
    const word = level ? `Put ${client.name} on the ${level} plan (${LEVELS.find((l) => l.level === level)?.cap} documents a month)?` : `Take ${client.name} off its plan? It will have no document limit.`;
    if (!window.confirm(word)) return;
    setSaving(true);
    setError('');
    try {
      await setClientPlan(client.id, level);
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5">
        <select
          value={plan ? plan.level : ''}
          onChange={change}
          disabled={saving}
          aria-label={`Plan for ${client.name}`}
          className="h-7 rounded-md border bg-background px-1.5 text-xs"
        >
          <option value="">None (unlimited)</option>
          {!known && <option value={plan.level}>{plan.level} · custom {plan.cap}</option>}
          {LEVELS.map((l) => (
            <option key={l.level} value={l.level}>{l.level} · {l.cap} docs</option>
          ))}
        </select>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      {plan && (
        <span className={cn('block text-xs tabular-nums', STATE_STYLE[plan.state])}>
          {plan.used} of {plan.cap}
          {plan.state === 'over' && ' · over: new documents are filed, not read'}
          {plan.state === 'at' && ' · at the limit'}
        </span>
      )}
      {error && <span className="block text-xs text-red-600">{error}</span>}
    </div>
  );
}
