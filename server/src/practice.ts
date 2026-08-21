import { Router, type Request, type Response } from 'express';
import { env } from './env.js';
import { readSession } from './auth.js';
import { workspaceId } from './workspace.js';
import { listOrganisations, getOrganisation, primaryOrgId } from './organisations.js';
import {
  ensure,
  save,
  full,
  publicUser,
  sendInvites,
  memberForSession,
  canManagePractice,
  canAccessOrg,
  PRACTICE_ROLES,
  type User,
} from './users.js';
import { usageSummary, priceTable } from './usage.js';

// The practice (CYBM) — the firm that runs CYBills for its clients.
//
// Two rosters, two different things. /api/users is a CLIENT's own staff: it is
// scoped to one linked entity and never leaves it. This router is the PRACTICE's
// own team — "colleagues" — who belong to no single entity and instead hold
// client access to the ones they work on, acting as a Business Admin inside
// each. The predicates that decide all of that live in users.ts, next to the
// roster they read; this file is the practice-facing surface over them.

const norm = (s: string) => String(s ?? '').trim().toLowerCase();

export const practiceRouter = Router();

// Any member of the practice team may look at the practice surfaces; only an
// Owner / Practice Admin may change who is on the team. Mock/dev (no session)
// stays open, like the rest of the app.
function practiceMember(req: Request, res: Response): { me: User | null; ok: boolean } {
  if (!readSession(req)) return { me: null, ok: true };
  const me = memberForSession(req);
  if (!me || !me.practice || me.deactivated) {
    res.status(403).json({ error: 'not_practice_team' });
    return { me, ok: false };
  }
  return { me, ok: true };
}

function practiceAdmin(req: Request, res: Response): { me: User | null; ok: boolean } {
  if (!readSession(req)) return { me: null, ok: true };
  const me = memberForSession(req);
  if (!canManagePractice(me)) {
    res.status(403).json({ error: 'forbidden' });
    return { me, ok: false };
  }
  return { me, ok: true };
}

const colleagues = (ws: string) =>
  ensure(ws).filter((u) => u.workspaceId === ws && !u.removed && u.practice);

// GET /api/practice — who the practice is, and what the caller may do in it.
practiceRouter.get('/', (req, res) => {
  const { me, ok } = practiceMember(req, res);
  if (!ok) return;
  res.json({
    practice: { name: env.PRACTICE_NAME, timezone: env.PRACTICE_TIMEZONE },
    roles: PRACTICE_ROLES,
    canManage: me ? canManagePractice(me) : true,
  });
});

// GET /api/practice/colleagues — the practice team, A→Z, with the client
// entities each one can open resolved to names for the roster table.
practiceRouter.get('/colleagues', (req, res) => {
  const { ok } = practiceMember(req, res);
  if (!ok) return;
  const ws = workspaceId(req);
  const organisations = listOrganisations(ws);
  const nameFor = new Map(organisations.map((o) => [o.id, o.name]));
  const list = colleagues(ws)
    .map((u) => ({
      ...publicUser(u),
      // What they can actually open right now: "all clients" is a standing
      // grant, so it resolves to every entity linked today.
      clients: (u.allClients ? organisations.map((o) => o.id) : u.clientAccess || [])
        .filter((id) => nameFor.has(id))
        .map((id) => ({ id, name: nameFor.get(id) as string })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  res.json({ practice: { name: env.PRACTICE_NAME }, colleagues: list, roles: PRACTICE_ROLES });
});

// POST /api/practice/colleagues — add one or many colleagues. Body: a colleague
// object, or { colleagues: [...] }, plus an optional `notify` (default true) to
// email each of them an invitation. Mirrors POST /api/users, with the practice
// fields instead of a client entity: an email already on the roster is reported
// back in `duplicates` rather than merged, because sign-in is by email and one
// address must resolve to exactly one person.
practiceRouter.post('/colleagues', async (req, res) => {
  const { ok } = practiceAdmin(req, res);
  if (!ok) return;
  const ws = workspaceId(req);
  const items = ensure(ws);
  const incoming: Partial<User>[] = Array.isArray(req.body?.colleagues) ? req.body.colleagues : [req.body ?? {}];
  const notify = req.body?.notify !== false;
  const message = String(req.body?.message || '').trim();
  const home = primaryOrgId(); // the practice's own entity — where a colleague's row files

  const created: User[] = [];
  const duplicates: Array<{ email: string; name: string; organisationName: string }> = [];
  for (const c of incoming) {
    const email = norm(String(c.email || ''));
    if (email) {
      const dup = items.find((x) => x.workspaceId === ws && !x.removed && norm(x.email) === email);
      if (dup) {
        duplicates.push({
          email: dup.email,
          name: dup.name,
          organisationName: dup.practice
            ? env.PRACTICE_NAME
            : getOrganisation(ws, dup.organisationId)?.name || dup.companyName || '',
        });
        continue;
      }
    }
    const clientAccess = Array.isArray(c.clientAccess)
      ? [...new Set(c.clientAccess.map(String))].filter((id) => getOrganisation(ws, id))
      : [];
    const colleague = full(
      {
        ...c,
        id: undefined,
        practice: true,
        practiceRole: String(c.practiceRole || 'Standard'),
        clientAccess,
        allClients: Boolean(c.allClients),
        // A colleague is not a client's employee, but their row still has to
        // live somewhere: the practice's own entity.
        organisationId: home,
        companyId: home,
        companyName: env.PRACTICE_NAME,
      },
      ws
    );
    items.unshift(colleague);
    created.push(colleague);
  }

  const invites = notify ? await sendInvites(req, created, { orgName: env.PRACTICE_NAME, message }) : [];
  save(items);
  res.json({ colleagues: created.map(publicUser), duplicates, invites });
});

// GET /api/practice/clients — every client entity the practice has connected,
// with the colleagues on it and what it has cost in Claude API usage today and
// month-to-date. A Standard colleague sees the clients they can open; whoever
// runs the practice sees all of them.
practiceRouter.get('/clients', (req, res) => {
  const { me, ok } = practiceMember(req, res);
  if (!ok) return;
  const ws = workspaceId(req);
  const usage = usageSummary(ws);
  const primary = primaryOrgId();
  const team = colleagues(ws).filter((u) => !u.deactivated);
  const everything = !me || canManagePractice(me);

  const clients = listOrganisations(ws)
    .filter((o) => everything || canAccessOrg(me, o.id))
    .map((o) => {
      const window = usage.byOrganisation[o.id];
      return {
        id: o.id,
        name: o.name,
        tenantId: o.tenantId,
        tenantName: o.tenantName,
        isPrimary: o.id === primary,
        createdAt: o.createdAt,
        // Who on the practice team works on this client — the account managers,
        // read straight off client access rather than kept as a second list.
        colleagues: team
          .filter((u) => canAccessOrg(u, o.id))
          .map((u) => ({ id: u.id, name: u.name, allClients: Boolean(u.allClients) })),
        usage: {
          today: window?.today ?? { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
          monthToDate: window?.monthToDate ?? { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
        },
      };
    });

  res.json({
    practice: { name: env.PRACTICE_NAME },
    clients,
    // Practice-wide spend, including calls made before an entity was selected
    // (which belong to no client and would otherwise vanish from the total).
    usage: {
      ...usage.totals,
      unattributed: usage.unattributed,
      timezone: usage.timezone,
      // What the estimate is built from, so the number can be checked rather
      // than taken on faith. USD per million tokens.
      rates: priceTable(),
    },
  });
});
