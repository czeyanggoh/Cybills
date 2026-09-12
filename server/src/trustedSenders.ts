// Whose links CYBills will follow.
//
// `<handle>@cybills.sg` is a public catch-all: anyone who learns an address can
// send to it. Handing every link on every delivery to n8n therefore points a
// robot that HOLDS PORTAL CREDENTIALS at whatever URL a stranger cared to send
// — which is the shape of a credential-phishing attack, and a robot does not
// hesitate the way a person does over a login page that looks nearly right.
//
// So following a link is a decision somebody makes, once, about a SENDER. The
// first mail from an address lands in the Costs inbox as a document that says
// what it is and asks; trusting the sender fetches it and every later mail from
// that address is fetched on arrival without asking again.
//
// Per ENTITY, deliberately. Trust is a judgement about whose paperwork this
// client accepts, and a supplier one client deals with is a stranger to
// another. Its own collection rather than a settings blob because it is
// appended to by a route — a read-modify-write of one shared blob would lose a
// concurrent trust — and because who trusted what, and when, is a record worth
// keeping.
import { loadCollection, saveCollection } from './jsonStore.js';

export type TrustedSender = {
  id: string;
  workspaceId: string;
  /** The organisation RECORD id this trust belongs to. */
  orgId: string;
  /** The bills SCOPE it filed into — matched too, for the same reason the mail
   *  listing matches it: a delivery that arrived before the entity was linked
   *  carries only this. */
  scope: string;
  /** The sender, normalised: lower-cased, angle brackets stripped. */
  address: string;
  at: string;
  /** Who decided, as an address. '' in dev/mock, where there is no session. */
  by: string;
};

const COLLECTION = 'trusted-senders';

/**
 * One address, as it will be compared.
 *
 * A `From` reaches this two ways — parsed out of the MIME by mailparser, which
 * gives a bare address, or passed through by a Worker that sends the header as
 * written ("Cze Yang Goh <czeyang.goh@cy-bm.sg>"). Compared raw, trusting one
 * would not trust the other, and the same person would be asked about twice.
 */
export function normaliseSender(raw: string): string {
  const s = String(raw ?? '').trim();
  const angled = /<([^>]+)>/.exec(s);
  return (angled ? angled[1] : s).trim().toLowerCase();
}

const load = () => loadCollection<TrustedSender>(COLLECTION);

const here = (row: TrustedSender, ws: string, orgId: string, scope: string) =>
  row.workspaceId === ws && (row.orgId === orgId || (Boolean(scope) && row.scope === scope));

/** Every sender this entity has decided to trust, newest first. */
export function trustedSendersFor(ws: string, orgId: string, scope = ''): TrustedSender[] {
  return load()
    .filter((r) => here(r, ws, orgId, scope))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export function isTrustedSender(ws: string, orgId: string, scope: string, address: string): boolean {
  const want = normaliseSender(address);
  if (!want) return false;
  return load().some((r) => here(r, ws, orgId, scope) && r.address === want);
}

/** Trust one sender here. Idempotent — trusting twice is not two decisions. */
export function trustSender(
  ws: string,
  orgId: string,
  scope: string,
  address: string,
  by: string
): TrustedSender | null {
  const want = normaliseSender(address);
  if (!want) return null;
  const items = load();
  const already = items.find((r) => here(r, ws, orgId, scope) && r.address === want);
  if (already) return already;
  const row: TrustedSender = {
    id: `ts_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: ws,
    orgId,
    scope,
    address: want,
    at: new Date().toISOString(),
    by: String(by || ''),
  };
  items.push(row);
  saveCollection(COLLECTION, items);
  return row;
}

/**
 * Take a sender's trust away.
 *
 * Removed rather than flagged: this is a permission, and the honest record of a
 * permission that no longer applies is its absence. What was already fetched
 * under it stays — those are documents now, and they happened.
 */
export function untrustSender(ws: string, orgId: string, scope: string, address: string): boolean {
  const want = normaliseSender(address);
  if (!want) return false;
  const items = load();
  const keep = items.filter((r) => !(here(r, ws, orgId, scope) && r.address === want));
  if (keep.length === items.length) return false;
  saveCollection(COLLECTION, keep);
  return true;
}
