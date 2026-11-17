import { env } from './env.js';

// Asking CYWorkspace's AP Mailbox to stop forwarding a kind of mail.
//
// The rule lives THERE, on the AP Mailbox config that forwards into this
// entity, because that is the only place it can stop a mail before it costs
// anything: a document here, a model read, somebody archiving it by hand.
// CYBills only supplies what the reviewer chose on the document page.
// Contract: CYWS `POST /api/webhooks/cybills/ap-mailbox/ignore`.
//
// A leaf, and every failure is said in words rather than thrown, since the
// button's whole answer is one sentence on the page.

export interface IgnoreRequest {
  tenantId: string;
  deliveredTo: string;
  address?: string;
  domain?: string;
  subject?: string;
  scope: 'person' | 'entity';
  addedBy: string;
}

export type IgnoreOutcome =
  | { ok: true; added: boolean; description: string; mailboxes: string[] }
  | { ok: false; status: number; error: string; message: string };

const TIMEOUT_MS = 15_000;

export async function askCywsToIgnore(r: IgnoreRequest): Promise<IgnoreOutcome> {
  if (!env.CYWORKSPACE_RELAY_URL || !env.CYWORKSPACE_API_KEY) {
    return { ok: false, status: 503, error: 'cyws_not_configured', message: 'CYWorkspace is not connected, so its AP Mailbox cannot be told.' };
  }
  const url = `${env.CYWORKSPACE_RELAY_URL.replace(/\/+$/, '')}/api/webhooks/cybills/ap-mailbox/ignore`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-Key': env.CYWORKSPACE_API_KEY },
      body: JSON.stringify({
        tenant_id: r.tenantId,
        delivered_to: r.deliveredTo,
        address: r.address || undefined,
        domain: r.domain || undefined,
        subject: r.subject || undefined,
        scope: r.scope,
        added_by: r.addedBy,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 404 && !body?.error) {
      return { ok: false, status: 502, error: 'cyws_outdated', message: 'CYWorkspace needs updating before it can take ignore rules.' };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status === 404 ? 404 : res.status >= 500 ? 502 : 422,
        error: String(body?.error || `cyws_${res.status}`),
        message: String(body?.message || `CYWorkspace refused the rule (${res.status}).`),
      };
    }
    return {
      ok: true,
      added: body?.added === true,
      description: String(body?.description || ''),
      mailboxes: Array.isArray(body?.mailboxes) ? (body!.mailboxes as unknown[]).map(String) : [],
    };
  } catch (e: any) {
    return { ok: false, status: 502, error: 'cyws_unreachable', message: `CYWorkspace did not answer (${e?.message || e}).` };
  }
}
