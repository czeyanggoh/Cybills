import { useEffect, useState } from 'react';
import { X, ChevronDown } from 'lucide-react';
import {
  fetchXeroTenants,
  createOrganisation,
  useInvalidateOrganisations,
  setActiveOrganisationId,
} from '@/lib/organisations';

// "Add organisation" dialog — links a new CYBills organisation to one of the
// Xero organisations connected in cyworkspace. The tenant list comes from the
// relay (GET /api/xero/tenants); picking one auto-fills the display name.
export default function AddOrganisationModal({ open, onClose, onAdded }) {
  const [tenants, setTenants] = useState(null); // null = loading
  const [loadError, setLoadError] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const invalidate = useInvalidateOrganisations();

  useEffect(() => {
    if (!open) return;
    setTenants(null);
    setLoadError('');
    setTenantId('');
    setName('');
    setNameTouched(false);
    setSaveError('');
    fetchXeroTenants()
      .then(setTenants)
      .catch((err) => {
        setTenants([]);
        setLoadError(
          err.code === 'xero_not_configured'
            ? 'The cyworkspace relay is not configured on this server yet (CYWORKSPACE_API_KEY).'
            : `Could not load Xero organisations from cyworkspace: ${err.message}`
        );
      });
  }, [open]);

  if (!open) return null;

  const selected = (tenants ?? []).find((t) => t.tenant_id === tenantId) ?? null;

  const pickTenant = (id) => {
    setTenantId(id);
    const t = (tenants ?? []).find((x) => x.tenant_id === id);
    if (t && !nameTouched) setName(t.tenant_name);
  };

  const submit = async () => {
    if (!selected) return;
    setSaving(true);
    setSaveError('');
    try {
      const organisation = await createOrganisation({
        name: name.trim() || selected.tenant_name,
        tenantId: selected.tenant_id,
        tenantName: selected.tenant_name,
      });
      invalidate();
      setActiveOrganisationId(organisation.id);
      onAdded?.(organisation);
      onClose();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-md overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">Add organisation</h2>
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
          <p className="text-sm text-muted-foreground">
            Pick the Xero organisation this workspace posts to. The connection itself lives in
            cyworkspace — CYBills only stores the link.
          </p>

          <label className="flex items-center gap-3 text-sm">
            <span className="w-32 shrink-0 text-muted-foreground">Xero organisation</span>
            <div className="relative flex-1">
              <select
                value={tenantId}
                onChange={(e) => pickTenant(e.target.value)}
                disabled={tenants === null || Boolean(loadError)}
                className="h-9 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                <option value="">
                  {tenants === null ? 'Loading from cyworkspace…' : 'Select a Xero organisation'}
                </option>
                {(tenants ?? []).map((t) => (
                  <option key={t.tenant_id} value={t.tenant_id}>
                    {t.tenant_name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            </div>
          </label>

          <label className="flex items-center gap-3 text-sm">
            <span className="w-32 shrink-0 text-muted-foreground">Display name</span>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              placeholder="Defaults to the Xero name"
              className="h-9 flex-1 rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>

          {loadError && <p className="text-sm text-destructive">{loadError}</p>}
          {saveError && <p className="text-sm text-destructive">{saveError}</p>}
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
            disabled={!selected || saving}
            onClick={submit}
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Adding…' : 'Add organisation'}
          </button>
        </div>
      </div>
    </div>
  );
}
