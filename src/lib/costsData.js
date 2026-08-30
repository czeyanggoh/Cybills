import { useState, useEffect, useCallback } from 'react';
import { useClaims, inboxClaimsFor } from '@/lib/claimStore';
import { useAuth } from '@/lib/auth';
import { fetchBills, billToDoc, BILLS_CHANGED_EVENT } from '@/lib/bills';
import { USERS_EVENT, canManageBusiness } from '@/lib/userStore';
import { isInInbox, isComplete, isReady, needsReview, inCostsList, isUnpublished } from '@/lib/readiness';

// Readiness and its opposite live in one pure module, so `npm test` can hold
// them to account and the pages can't drift from the server's own rule.
export {
  READY_FIELDS,
  isComplete,
  missingFields,
  INBOX_STATUSES,
  isInInbox,
  isReady,
  needsReview,
  ARCHIVE_STATUSES,
  isArchived,
  inCostsList,
  isUnpublished,
} from '@/lib/readiness';

export function rowsFor(docs, key) {
  if (key === 'processing') return docs.filter((d) => d.status === 'processing');
  // Dext-style: the Inbox is the master list of everything not archived, and
  // Ready and To review are FILTERS within it rather than separate buckets — a
  // Ready document shows here too, carrying its "Ready" tag. Between them they
  // now cover the whole inbox: a document is either finished or waiting on a
  // person.
  if (key === 'inbox') return docs.filter(isInInbox);
  if (key === 'review') return docs.filter(needsReview);
  if (key === 'ready') return docs.filter(isReady);
  if (key === 'archive') return docs.filter((d) => d.status === 'expenseclaim' || d.status === 'archived' || d.status === 'merged');
  // Inbox and Archive are one tab now, and these are the two ways of looking at
  // it: 'unpublished' is the work still to do, 'all' is the same list with the
  // finished documents left in. 'inbox' and 'archive' survive because the
  // things that genuinely mean one or the other still ask for them — merge
  // detection leaves settled documents alone, and the document page's
  // "next item" walks the inbox.
  if (key === 'all') return docs.filter(inCostsList);
  if (key === 'unpublished') return docs.filter(isUnpublished);
  return [];
}

// Loads the real Costs document set (persisted bills) and keeps it in sync with
// upload / edit events. (Seed/demo sample rows were removed — the list shows
// only real uploaded documents.)
export function useCostsDocs() {
  const [uploaded, setUploaded] = useState([]);

  const reload = useCallback(async () => {
    // Only cost-workspace bills belong in Costs; sales uploads have kind==='sales'
    // and supplier statements have kind==='supplier_statement'.
    setUploaded((await fetchBills()).map(billToDoc).filter((d) => d.kind === 'cost'));
  }, []);

  useEffect(() => {
    reload();
    window.addEventListener(BILLS_CHANGED_EVENT, reload);
    // Re-map when the users roster loads/changes, so createdBy emails resolve to
    // real names ("Astrid Yang" rather than "astridy2004").
    window.addEventListener(USERS_EVENT, reload);
    return () => {
      window.removeEventListener(BILLS_CHANGED_EVENT, reload);
      window.removeEventListener(USERS_EVENT, reload);
    };
  }, [reload]);

  // While anything is still being read, poll. Reading is driven by the
  // UPLOADER's browser, so a document another person (or another tab) is
  // uploading only reaches this one through a refetch — without this, a
  // finished document sits on screen as "processing" indefinitely, and the
  // server's stuck-document sweep never runs either, because that also only
  // happens on a fetch. Stops the moment nothing is processing.
  const processingCount = uploaded.filter((d) => d.status === 'processing').length;
  useEffect(() => {
    if (!processingCount) return undefined;
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [processingCount, reload]);

  // A document can arrive without this browser doing anything: emailed in
  // ("Extract by email"), or added by somebody else. Nothing local fires then —
  // BILLS_CHANGED_EVENT is dispatched by whoever did the uploading — so the
  // inbox sat there looking empty while the server had already filed it, and
  // the only way to find out was to reload the page by hand.
  //
  // Slow on purpose, and only while the tab is actually being looked at: this
  // is a background refresh of a list somebody is reading, not a live feed.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') reload();
    };
    const t = setInterval(tick, 30000);
    // …and immediately on coming back to the tab, which is when a person is
    // most likely to be waiting for something they sent a moment ago.
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [reload]);

  return { allDocs: uploaded, sampleDocs: [], uploaded, reload };
}

// Live counts for every Costs tab + the subnav badges, derived from real rows.
export function useCostsCounts() {
  const { allDocs } = useCostsDocs();
  const claims = useClaims();
  // The Expense claims badge counts the INBOX, not every claim ever made —
  // archived and Xero-published ones drop out, exactly as they do from the tab,
  // and a non-admin only counts the claims they're allowed to see.
  const { user, googleEnabled, membership } = useAuth();
  const isAdmin = canManageBusiness(membership, googleEnabled);
  return {
    inbox: rowsFor(allDocs, 'inbox').length,
    // What the Costs tab shows by default, so the subnav badge matches the list
    // it opens on rather than a tab that no longer exists.
    unpublished: rowsFor(allDocs, 'unpublished').length,
    all: rowsFor(allDocs, 'all').length,
    review: rowsFor(allDocs, 'review').length,
    ready: rowsFor(allDocs, 'ready').length,
    archive: rowsFor(allDocs, 'archive').length,
    expenseClaims: inboxClaimsFor(claims, user, isAdmin).length,
  };
}
