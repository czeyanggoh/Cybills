import { env } from './env.js';

// Whether an address has an account in CYWorkspace.
//
// The rail's CYWorkspace link was offered to the practice's own team alone, on
// the reasoning that a client's employee has no account there and the link is a
// sign-in page they cannot pass. Mostly true, and wrong for the client whose
// people run their own payments: somebody with an account in BOTH apps was left
// without the link between them. Who has an account there is CYWorkspace's to
// know, so it is asked (`POST /api/webhooks/cybills/has-account`), by address —
// the one thing both apps know a person by.
//
// A leaf, and best-effort throughout: this decides whether a LINK is drawn, so
// an unreachable CYWorkspace, an older one that has never heard of the route, or
// a deploy with no key all answer "no" and nobody waits on it. Remembered per
// address, because it is asked on every page load: an hour for a yes, a few
// minutes for a no (an account made just now should not take an hour to show),
// and only a moment for a failure.

const YES_MS = 60 * 60 * 1000;
const NO_MS = 5 * 60 * 1000;
const FAILED_MS = 60 * 1000;
const TIMEOUT_MS = 2000;

const known = new Map<string, { account: boolean; until: number }>();

/** Forget what was learned — for tests. */
export function forgetCywsAccounts(): void {
  known.clear();
}

export async function hasCywsAccount(emailRaw: string): Promise<boolean> {
  const email = String(emailRaw || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return false;
  if (!env.CYWORKSPACE_RELAY_URL || !env.CYWORKSPACE_API_KEY) return false;
  const hit = known.get(email);
  if (hit && hit.until > Date.now()) return hit.account;

  const remember = (account: boolean, ms: number) => {
    known.set(email, { account, until: Date.now() + ms });
    return account;
  };
  const url = `${env.CYWORKSPACE_RELAY_URL.replace(/\/+$/, '')}/api/webhooks/cybills/has-account`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-Key': env.CYWORKSPACE_API_KEY },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return remember(false, FAILED_MS);
    const body = (await res.json().catch(() => null)) as { account?: unknown } | null;
    const account = body?.account === true;
    return remember(account, account ? YES_MS : NO_MS);
  } catch {
    return remember(false, FAILED_MS);
  }
}
