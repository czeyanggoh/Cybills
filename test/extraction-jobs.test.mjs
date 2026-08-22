// A read has to outlive the page that started it: the reviewer presses re-read
// and moves on. These are the guarantees the detail page leans on — that the
// job is findable while it runs, that pressing twice doesn't read twice, and
// that whoever asks later still gets the answer.
import { startExtraction, extractionJob, isExtracting } from '../src/lib/extractionJobs.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const defer = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

// 1) Findable while it runs, gone once it settles.
const a = defer();
let ran = 0;
const job = startExtraction('doc-1', 'read', () => { ran++; return a.promise; });
check('running job is findable', extractionJob('doc-1')?.kind, 'read');
check('isExtracting, by kind', [isExtracting('doc-1'), isExtracting('doc-1', 'read'), isExtracting('doc-1', 'lines')], [true, true, false]);
check('another document is unaffected', extractionJob('doc-2'), null);

// 2) Pressing again joins the read in flight rather than starting a second one.
const same = startExtraction('doc-1', 'read', () => { ran++; return Promise.resolve('second'); });
check('same job returned', same === job, true);
check('the reader was called once', ran, 1);

// 3) A second document reads at the same time.
const b = defer();
startExtraction('doc-2', 'lines', () => b.promise);
check('two documents at once', [extractionJob('doc-1')?.kind, extractionJob('doc-2')?.kind], ['read', 'lines']);

// 4) The answer reaches whoever waits — including a page that arrived late.
a.resolve({ supplier: 'READ' });
const outcome = await job.promise;
check('resolves with the value', outcome, { ok: true, value: { supplier: 'READ' } });
check('cleared once settled', extractionJob('doc-1'), null);
check('a late waiter still gets it', await same.promise, { ok: true, value: { supplier: 'READ' } });

// 5) A failed read reports, and still clears — a document must never be stuck
//    "reading" because its reader threw.
const c = defer();
const failing = startExtraction('doc-3', 'read', () => c.promise);
c.reject(new Error('reader exploded'));
check('failure is reported, not thrown', await failing.promise, { ok: false, error: 'reader exploded' });
check('cleared after a failure', extractionJob('doc-3'), null);

// 6) …and the document can be read again afterwards.
const again = startExtraction('doc-3', 'read', () => Promise.resolve('retry'));
check('a new read can start', again !== failing, true);
check('and resolves', await again.promise, { ok: true, value: 'retry' });

b.resolve(null); // let the second document's read finish before we report

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
