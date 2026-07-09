import { Router } from 'express';
import { env } from './env.js';
import { readSession } from './auth.js';

// Read-only org directory used by the Support Desk "Assignee" dropdown. Any
// signed-in user may read it (it is not admin-gated) so tickets and feature
// requests can be assigned to any colleague. There is no domain-data DB yet, so
// the roster is seeded from a small employee-profile directory (below) and can
// be overridden per-deploy via the ORG_MEMBERS env var. The signed-in user is
// always folded in so they can assign work to themselves even before HR adds
// them to the directory.

export type Assignee = {
  id: string; // stable id — the lowercased email
  email: string;
  name: string; // display name (from employee profiles) or the email as fallback
};

// Stand-in for an HR / employee-profile store: maps work email -> display name.
// Extend as staff are onboarded, or override the whole roster with ORG_MEMBERS.
const EMPLOYEE_PROFILES: Record<string, string> = {
  'czeyang.goh@cy-bm.sg': 'Che Zeyang Goh',
  'astrid.yang@cy-bm.sg': 'Astrid Yang',
  'support@cy-bm.sg': 'Support Team',
};

// Best-effort display name for an email: prefer the employee profile, else a
// title-cased guess from the local part (e.g. "ada.lim@x" -> "Ada Lim").
function displayNameFor(email: string, override?: string): string {
  if (override && override.trim()) return override.trim();
  const profile = EMPLOYEE_PROFILES[email.toLowerCase()];
  if (profile) return profile;
  const local = email.split('@')[0] ?? email;
  const guessed = local
    .split(/[.\-_]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join(' ');
  return guessed || email;
}

// Parse ORG_MEMBERS ("email" or "email:Display Name", comma-separated).
function rosterFromEnv(): Array<{ email: string; name?: string }> {
  return env.ORG_MEMBERS.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      if (idx === -1) return { email: entry };
      return { email: entry.slice(0, idx).trim(), name: entry.slice(idx + 1).trim() };
    })
    .filter((e) => e.email);
}

// Build the assignable-user list: env roster if configured, otherwise the seed
// employee directory. De-duplicated by lowercased email.
function buildRoster(): Assignee[] {
  const configured = rosterFromEnv();
  const source: Array<{ email: string; name?: string }> = configured.length
    ? configured
    : Object.keys(EMPLOYEE_PROFILES).map((email) => ({ email }));

  const byId = new Map<string, Assignee>();
  for (const { email, name } of source) {
    const id = email.toLowerCase();
    if (!byId.has(id)) byId.set(id, { id, email, name: displayNameFor(email, name) });
  }
  return [...byId.values()];
}

export const orgRouter = Router();

// GET /api/org/assignees — assignable users for the active org. Readable by any
// signed-in user. Always includes the caller so they can self-assign.
orgRouter.get('/assignees', (req, res) => {
  const byId = new Map<string, Assignee>();
  for (const a of buildRoster()) byId.set(a.id, a);

  const me = readSession(req);
  if (me?.email) {
    const id = me.email.toLowerCase();
    if (!byId.has(id)) {
      byId.set(id, { id, email: me.email, name: me.name?.trim() || displayNameFor(me.email) });
    }
  }

  const assignees = [...byId.values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
  );
  res.json({ assignees });
});
