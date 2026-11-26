import { useActiveOrganisation } from '@/lib/organisations';
import { useExtractionSettings } from '@/lib/extractionSettings';

// Cash mode: an entity whose Xero subscription has no bills or invoices, so what
// it publishes goes up as Spend Money and Receive Money (server/src/cashMode.ts,
// which is what enforces it).

// Whether the open entity is in it. A bridge entity posts into its parent's
// Xero, so it follows the parent's setting, resolved server-side.
export function useCashMode() {
  const organisation = useActiveOrganisation();
  const own = useExtractionSettings().cashMode === true;
  return organisation?.kind === 'standalone' ? Boolean(organisation.cashMode) : own;
}

// Whether a document says on its own which account its money moved through — the
// bank line it is matched to, or Paid with a Payment method. What a bulk publish
// asks, since there is no dialog to ask it in.
export function hasCashPayment(doc) {
  return Boolean(doc?.bankMatch) || (doc?.paid === true && Boolean(String(doc?.paymentMethod ?? '').trim()));
}
