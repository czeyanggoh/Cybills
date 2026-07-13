import { useState, useEffect, useCallback } from 'react';
import { DOCS } from '@/data/docs';
import { CLAIMS } from '@/data/claims';
import { fetchBills, billToDoc, BILLS_CHANGED_EVENT } from '@/lib/bills';
import { getDocOverrides, applyOverride, DOC_OVERRIDES_EVENT } from '@/lib/docOverrides';

// Which documents belong in each Costs tab, by status. Uploaded bills carry
// status new/ready/expenseclaim/archived; sample docs may also be 'viewed' or
// 'review'. Used for both the visible rows and the tab/subnav count badges so
// the numbers always tie to the actual line items.
export function rowsFor(docs, key) {
  if (key === 'inbox') return docs.filter((d) => d.status === 'new' || d.status === 'viewed');
  if (key === 'review') return docs.filter((d) => d.status === 'review');
  if (key === 'ready') return docs.filter((d) => d.status === 'ready');
  if (key === 'archive') return docs.filter((d) => d.status === 'expenseclaim' || d.status === 'archived');
  return [];
}

// Loads the combined Costs document set (persisted bills + sample docs with any
// local edits applied) and keeps it in sync with upload / edit events.
export function useCostsDocs() {
  const [uploaded, setUploaded] = useState([]);
  const [overrides, setOverrides] = useState(() => getDocOverrides());

  const reload = useCallback(async () => {
    setUploaded((await fetchBills()).map(billToDoc));
  }, []);

  useEffect(() => {
    reload();
    window.addEventListener(BILLS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(BILLS_CHANGED_EVENT, reload);
  }, [reload]);

  useEffect(() => {
    const sync = () => setOverrides(getDocOverrides());
    window.addEventListener(DOC_OVERRIDES_EVENT, sync);
    return () => window.removeEventListener(DOC_OVERRIDES_EVENT, sync);
  }, []);

  const sampleDocs = DOCS.map((d) => applyOverride(d, overrides));
  const allDocs = [...uploaded, ...sampleDocs];
  return { allDocs, sampleDocs, uploaded, reload };
}

// Live counts for every Costs tab + the subnav badges, derived from real rows.
export function useCostsCounts() {
  const { allDocs } = useCostsDocs();
  return {
    inbox: rowsFor(allDocs, 'inbox').length,
    review: rowsFor(allDocs, 'review').length,
    ready: rowsFor(allDocs, 'ready').length,
    archive: rowsFor(allDocs, 'archive').length,
    expenseClaims: CLAIMS.length,
  };
}
