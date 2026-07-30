import type { Request } from 'express';
import { readSession } from './auth.js';

// CYBills serves a single company, so everyone who signs in shares ONE
// workspace regardless of their email domain. (Data used to be scoped by email
// domain via orgIdFor, which siloed gmail / cy-bm.sg / yahoo logins from each
// other — the opposite of a shared team system.) New server-backed collections
// (claims, and later users/lists) scope by this workspace id.
export const WORKSPACE_ID = process.env.CYBILLS_WORKSPACE_ID || 'cybm';

export function workspaceId(_req: Request): string {
  return WORKSPACE_ID;
}

// The signed-in user acting on a record — used to stamp attribution/history and
// to enforce the assigned approver. Falls back gracefully when there's no
// session (mock/dev mode).
export function actor(req: Request): { email: string; name: string } {
  const s = readSession(req);
  const email = s?.email || '';
  const name = s?.name || (email ? email.split('@')[0] : 'You');
  return { email, name };
}
