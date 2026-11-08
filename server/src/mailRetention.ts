// How long the Email tab keeps a mail.
//
// The org-level Email tab is where a delivery is looked at to find out what
// became of it, and after a couple of months that question is answered. So
// nothing older than the retention window (60 days by default, set per entity
// by the practice, 0 = keep for ever) stays in it:
//
//   - a mail that BECAME A DOCUMENT is handed to the document: the row is kept
//     (the document's Email tab, "Show as sent", its replies and the Files tab
//     all read it, and it is also what stops a retried delivery being filed
//     twice) but is marked `onDocuments` and no longer listed in the entity's
//     Email tab. The attachment is the document's own file and is never touched.
//   - a mail that filed NOTHING is deleted, with its stored HTML part.
//   - a mail still waiting on somebody is left alone: a link to be fetched, a
//     sender to be trusted, a reply not yet marked answered.
import { loadMail, saveMail, mailUnfiled, type MailMessage } from './mailThread.js';
import { deleteBillFile } from './storage.js';
import { listBills } from './store.js';
import { organisationForScope } from './organisations.js';
import { loadCollection, saveCollection } from './jsonStore.js';
import { practiceDayKey } from './usage.js';

const DAY = 24 * 3600 * 1000;
export const DEFAULT_RETENTION_DAYS = 60;
const MARKER = 'mail-retention-clock';

/** Days to keep a mail for an entity; 0 = for ever. */
export function retentionDaysFor(ws: string, scope: string): number {
  const org = organisationForScope(ws, scope);
  const set = org?.mailRetentionDays;
  if (typeof set === 'number' && Number.isFinite(set) && set >= 0) return Math.floor(set);
  const env = Number(process.env.MAIL_RETENTION_DAYS);
  return Number.isFinite(env) && env >= 0 && process.env.MAIL_RETENTION_DAYS ? Math.floor(env) : DEFAULT_RETENTION_DAYS;
}

export type RetentionPlan = {
  /** Became documents: kept on the document, no longer listed in the Email tab. */
  handToDocuments: MailMessage[];
  /** Filed nothing: deleted. */
  remove: MailMessage[];
  /** Old enough, but still waiting on somebody. */
  kept: number;
};

function stillOpen(m: MailMessage, pendingByScope: Map<string, Set<string>>): boolean {
  if (m.pendingBillId || m.outcome === 'awaiting_trust') return true;
  const waiting = pendingByScope.get(m.scope);
  return Boolean(waiting && m.documents.some((d) => waiting.has(d.billId)));
}

/** What a run would do to one entity's mail (or every entity's, with no scope). */
export function planRetention(now = Date.now(), only?: { ws: string; scope: string }): RetentionPlan {
  const out: RetentionPlan = { handToDocuments: [], remove: [], kept: 0 };
  const pendingByScope = new Map<string, Set<string>>();
  const pendingFor = (scope: string) => {
    let set = pendingByScope.get(scope);
    if (!set) {
      set = new Set(listBills(scope).filter((b) => b.pendingReply).map((b) => b.id));
      pendingByScope.set(scope, set);
    }
    return set;
  };
  const days = new Map<string, number>();
  for (const m of loadMail()) {
    if (only && (m.workspaceId !== only.ws || m.scope !== only.scope)) continue;
    if (m.onDocuments) continue;
    const key = `${m.workspaceId}|${m.scope}`;
    if (!days.has(key)) days.set(key, retentionDaysFor(m.workspaceId, m.scope));
    const keepFor = days.get(key)!;
    if (!keepFor) continue;
    const at = Date.parse(m.receivedAt || m.sentAt);
    if (!Number.isFinite(at) || now - at < keepFor * DAY) continue;
    pendingFor(m.scope);
    if (stillOpen(m, pendingByScope)) {
      out.kept += 1;
      continue;
    }
    if (m.documents.length || m.outcome === 'forwarded') out.handToDocuments.push(m);
    else if (mailUnfiled(m) || m.outcome === 'forwarding_confirmation') out.remove.push(m);
  }
  return out;
}

/** Do it. Returns what was done. */
export async function runRetention(now = Date.now(), only?: { ws: string; scope: string }) {
  const plan = planRetention(now, only);
  if (!plan.handToDocuments.length && !plan.remove.length) return { handed: 0, removed: 0, kept: plan.kept };
  const handIds = new Set(plan.handToDocuments.map((m) => m.id));
  const removeIds = new Set(plan.remove.map((m) => m.id));
  const rows = loadMail();
  const stamp = new Date(now).toISOString();
  const keep: MailMessage[] = [];
  const bodies: string[] = [];
  for (const m of rows) {
    if (removeIds.has(m.id)) {
      if (m.bodyKey) bodies.push(m.bodyKey);
      continue;
    }
    if (handIds.has(m.id)) m.onDocuments = stamp;
    keep.push(m);
  }
  saveMail(keep);
  // The stored HTML is content-addressed, so two messages with identical markup
  // share one object: only delete one nobody still points at.
  const stillUsed = new Set(keep.map((m) => m.bodyKey).filter(Boolean));
  for (const key of new Set(bodies)) {
    if (!stillUsed.has(key)) await deleteBillFile(key).catch(() => undefined);
  }
  return { handed: handIds.size, removed: removeIds.size, kept: plan.kept };
}

/** Once a practice day, off the half-hourly rhythm the storage clock uses. */
export function startMailRetentionClock(): void {
  if (process.env.MAIL_RETENTION_AUTO === 'off') return;
  const tick = async () => {
    try {
      const day = practiceDayKey(new Date());
      if (loadCollection<{ day: string }>(MARKER)[0]?.day === day) return;
      const done = await runRetention();
      saveCollection(MARKER, [{ day }]);
      if (done.handed || done.removed) console.log('[mail] retention', done);
    } catch (err) {
      console.error('[mail] retention tick failed', err);
    }
  };
  setTimeout(() => void tick(), 90_000).unref();
  setInterval(() => void tick(), 30 * 60_000).unref();
}
