// Reads that outlive the page they were started from.
//
// Reading a document takes ten to thirty seconds, and a reviewer working an
// inbox presses "re-read" and moves to the next document rather than watching
// it. The request itself never was cancelled — but everything that knew about
// it lived in the detail page's state, so the moment that page unmounted the
// read became invisible: come back and the fields are the old ones, with no
// sign anything is happening, and the next keystroke saves those stale fields
// back over the answer when it lands.
//
// So a read is a JOB, held here at module scope. It carries on when the page
// goes away, the page picks it back up when it returns, and whatever it saved
// is re-read from the server rather than assumed.

import { useEffect, useState } from 'react';

const jobs = new Map(); // document id -> job
export const EXTRACTION_JOB_EVENT = 'cybills:extraction-job-changed';
const emit = () => window.dispatchEvent(new Event(EXTRACTION_JOB_EVENT));

// Start a read for a document, unless one is already running for it — two reads
// of the same document would race each other's writes, and the second answer
// isn't better than the first. Returns the job either way, so a caller that
// arrives late can await the one already in flight.
//
// `run` does the whole thing, including persisting: it must not depend on any
// component still being mounted. Its resolved value reaches whoever is waiting.
export function startExtraction(docId, kind, run) {
  const key = String(docId);
  const existing = jobs.get(key);
  if (existing) return existing;

  const job = { docId: key, kind, startedAt: Date.now() };
  job.promise = (async () => {
    try {
      return { ok: true, value: await run() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      jobs.delete(key);
      emit();
    }
  })();
  jobs.set(key, job);
  emit();
  return job;
}

// The read running for a document, or null. 'read' = the whole document,
// 'lines' = its itemised table.
export function extractionJob(docId) {
  return jobs.get(String(docId)) || null;
}

export function isExtracting(docId, kind = null) {
  const job = extractionJob(docId);
  return Boolean(job && (!kind || job.kind === kind));
}

// Subscribe a component to the read running for one document. Re-renders when
// it starts or finishes — including a read started before this component
// mounted, which is the whole point.
export function useExtractionJob(docId) {
  const [job, setJob] = useState(() => extractionJob(docId));
  useEffect(() => {
    const sync = () => setJob(extractionJob(docId));
    sync();
    window.addEventListener(EXTRACTION_JOB_EVENT, sync);
    return () => window.removeEventListener(EXTRACTION_JOB_EVENT, sync);
  }, [docId]);
  return job;
}
