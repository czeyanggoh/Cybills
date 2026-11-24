import { env } from './env.js';

// Posting into one of an entity's own WhatsApp groups, through CYWorkspace.
//
// CYBills holds no WhatsApp session; CYWS runs the CYBot number. A collection
// group is named by submission id, but an APPROVAL goes to a group the client
// already talks in ("Accts - Nucleo"), which CYBills never opened — so it is
// named by chat id AND the entity's Xero tenant, and CYWS sends only where the
// chat is linked to that tenant in its inbox and CYBot is in it. A leaf, like
// waReactions.ts: claims.ts reads it and it reads nothing of ours.
//
// Contract: CYWS `GET /api/webhooks/cybills/groups`,
// `POST /api/webhooks/cybills/send-to-group` (deploy/WHATSAPP.md).

export type WaGroup = { chatId: string; name: string };
export type GroupFile = { filename: string; base64: string; mimetype?: string };

export class GroupSendError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const base = () => env.CYWORKSPACE_RELAY_URL.replace(/\/+$/, '');
const headers = () => ({
  'X-API-Key': env.CYWORKSPACE_API_KEY,
  'Content-Type': 'application/json',
  Accept: 'application/json',
});

function configured(): void {
  if (!env.CYWORKSPACE_RELAY_URL || !env.CYWORKSPACE_API_KEY) {
    throw new GroupSendError('whatsapp_not_configured', 'WhatsApp is not set up on this server (no CYWorkspace key).');
  }
}

// CYWS's own words where it gave any; a bare 404 is an older CYWS without the
// route, which is a different thing from a group it could not find.
async function refusal(res: Response): Promise<GroupSendError> {
  const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (res.status === 404 && !body?.error) {
    return new GroupSendError('cyws_needs_update', 'CYWorkspace needs updating before it can post to a WhatsApp group.');
  }
  return new GroupSendError(body?.error || 'cyws_refused', body?.message || `CYWorkspace answered ${res.status}.`);
}

async function call(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  configured();
  try {
    return await fetch(`${base()}${path}`, { ...init, headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const e = err as { name?: string; message?: string };
    throw new GroupSendError(
      'cyws_unreachable',
      e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'CYWorkspace did not answer in time.' : `CYWorkspace could not be reached: ${e?.message ?? err}`,
    );
  }
}

// The groups linked to this Xero organisation in CYWS's WhatsApp inbox that
// CYBot can post to.
export async function groupsForTenant(tenantId: string): Promise<WaGroup[]> {
  const res = await call(`/api/webhooks/cybills/groups?tenant_id=${encodeURIComponent(tenantId)}`, { method: 'GET' }, 15_000);
  if (!res.ok) throw await refusal(res);
  const body = (await res.json().catch(() => ({}))) as { groups?: Array<{ chat_id?: string; name?: string }> };
  return (body.groups ?? [])
    .filter((g) => g && typeof g.chat_id === 'string' && g.chat_id)
    .map((g) => ({ chatId: String(g.chat_id), name: String(g.name || g.chat_id) }));
}

// Files first, then the text, so the message with the link is last in the chat.
export async function sendToGroup(args: { tenantId: string; chatId: string; text?: string; files?: GroupFile[] }): Promise<{ name: string; files: string[] }> {
  const res = await call(
    '/api/webhooks/cybills/send-to-group',
    { method: 'POST', body: JSON.stringify({ tenant_id: args.tenantId, chat_id: args.chatId, text: args.text ?? '', files: args.files ?? [] }) },
    90_000,
  );
  if (!res.ok) throw await refusal(res);
  const body = (await res.json().catch(() => ({}))) as { data?: { name?: string; files?: string[] } };
  return { name: String(body.data?.name ?? ''), files: body.data?.files ?? [] };
}
