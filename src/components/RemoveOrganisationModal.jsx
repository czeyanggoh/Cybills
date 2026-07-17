import { useEffect, useState } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { deleteOrganisation, useInvalidateOrganisations } from '@/lib/organisations';

// "Remove organisation" confirmation dialog — unlinks a CYBills organisation
// from its Xero tenant. This only removes CYBills' pointer to the tenant; the
// Xero connection itself lives in cyworkspace and is left untouched, so the
// organisation can be re-added at any time.
export default function RemoveOrganisationModal({ open, organisation, onClose, onRemoved }) {
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState('');
  const invalidate = useInvalidateOrganisations();

  useEffect(() => {
    if (!open) return;
    setRemoving(false);
    setError('');
  }, [open]);

  if (!open || !organisation) return null;

  const submit = async () => {
    setRemoving(true);
    setError('');
    try {
      await deleteOrganisation(organisation.id);
      invalidate();
      onRemoved?.(organisation);
      onClose();
    } catch {
      setError('Could not remove the organisation. Please try again.');
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-md overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">Remove organisation</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" strokeWidth={1.75} />
            <div className="space-y-2 text-sm">
              <p>
                Remove <span className="font-medium text-foreground">{organisation.name}</span> from
                this workspace?
              </p>
              <p className="text-muted-foreground">
                This only unlinks it in CYBills — the Xero connection in cyworkspace is left
                untouched, so you can re-add it at any time. Bills already published to Xero are not
                affected.
              </p>
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={removing}
            onClick={submit}
            className="inline-flex h-9 items-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {removing ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  );
}
