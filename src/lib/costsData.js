import { useState, useEffect, useCallback } from 'react';
import { useClaims, unpublishedClaimsFor, isMyClaim } from '@/lib/claimStore';
import { useAuth } from '@/lib/auth';
import { fetchBills, billToDoc, BILLS_CHANGED_EVENT } from '@/lib/bills';
import { USERS_EVENT, canManageBusiness } from '@/lib/userStore';
import { applyPersonScope } from '@/lib/costFilters';
import { usePersonScope } from '@/lib/personScope';
import { isInInbox, isComplete, isReady, needsReview, inCostsTab, inCostsList, inCostsAll, isMergedAway, isUnpublished } from '@/lib/readiness';

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
  isProcessing,
  inCostsTab,
  inCostsList,
  inCostsAll,
  isPublished,
  isSetAside,
  isMergedAway,
  isUnpublished,
} from '@/lib/readiness';

// A merged-away upload is not a document any more, so no list here shows one —
// not the Costs tab, not Archived, not the counts beside either. The row is
// still in the book: it is what the combined document points at and what
// Unmerge restores, which is why this hides rather than deletes.
export function rowsFor(docs, key) {
  return listFor(docs, key).filter((d) => !isMergedAway(d));
}

function listFor(docs, key) {
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
  // The Costs tab: the work still in front of somebody, which is exactly the
  // three tabs beside it added together. An archived document is settled and
  // has its own tab, so it is not also a row here.
  if (key === 'costs') return docs.filter(inCostsTab);
  // The Costs tab's far scope: the whole book with the published, claimed and
  // merged documents left in, so a supplier can be filtered across the history
  // rather than only across the work outstanding. The set-aside pile (Archived)
  // stays out — see inCostsAll.
  if (key === 'costs-all') return docs.filter(inCostsAll);
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
  const { allDocs: everyDoc } = useCostsDocs();
  const claims = useClaims();
  // The rail's badge counts the list the tab actually opens on, so it follows
  // the Costs page's My items / All items toggle rather than always answering
  // for the whole entity — a badge saying 15 above a list of 3 is the fault
  // this app has already been bitten by once.
  const [person] = usePersonScope();
  // The Expense claims badge counts what that page OPENS on — its unpublished
  // half — rather than every claim ever made, and a non-admin only counts the
  // claims they're allowed to see. Same rule the Costs badge follows, so a
  // number beside a tab always describes the list behind it.
  const { user, googleEnabled, membership } = useAuth();
  const isAdmin = canManageBusiness(membership, googleEnabled);
  const allDocs = applyPersonScope(everyDoc, person, { email: user?.email, name: user?.name });
  return {
    inbox: rowsFor(allDocs, 'inbox').length,
    // What the Costs tab shows, so the subnav badge matches the list it opens.
    costs: rowsFor(allDocs, 'costs').length,
    costsAll: rowsFor(allDocs, 'costs-all').length,
    unpublished: rowsFor(allDocs, 'unpublished').length,
    all: rowsFor(allDocs, 'all').length,
    review: rowsFor(allDocs, 'review').length,
    ready: rowsFor(allDocs, 'ready').length,
    archive: rowsFor(allDocs, 'archive').length,
    // Claims follow the same toggle: under My items the badge counts the
    // claimant's own, which is the list the page then opens on.
    expenseClaims: unpublishedClaimsFor(claims, user, isAdmin).filter(
      (c) => person !== 'mine' || isMyClaim(c, user)
    ).length,
  };
}
