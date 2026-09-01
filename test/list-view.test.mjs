// A list page's remembered view. The part worth pinning is not the storing —
// it is what a stored value is worth once the page has moved on: what was saved
// is last release's, and a filter object from before a field existed, or a scope
// key that no longer does, shows an empty list nobody can explain.
import { restoreView } from '../src/lib/listView.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- nothing stored ----------------------------------------------------------
check('nothing stored is the fallback', restoreView(undefined, 'unpublished'), 'unpublished');
check('null is the fallback too', restoreView(null, 'unpublished'), 'unpublished');

// --- the ordinary case -------------------------------------------------------
check('a stored scope comes back', restoreView('all', 'unpublished'), 'all');

// --- shape, not content ------------------------------------------------------
// The guard is on the TYPE, not on the vocabulary: a scope this release dropped
// is still a string, and a list showing nothing is a better bug to have than a
// crash — but a filter object where a string is expected is not survivable.
check('a value of the wrong type falls back whole', restoreView({ status: '' }, 'unpublished'), 'unpublished');
check('…and so does a string where an object is expected', restoreView('all', { status: '' }), { status: '' });
check('an array is not an object here', restoreView(['a'], { status: '' }), { status: '' });

// --- an object gains the fields it did not have ------------------------------
// Saved before "paidStatus" existed. Merged OVER the fallback, so the new field
// is '' rather than undefined, which reads as "Any" instead of matching nothing.
check(
  'a stored object is merged over the fallback',
  restoreView({ status: 'approved' }, { status: '', paidStatus: '', type: '' }),
  { status: 'approved', paidStatus: '', type: '' }
);

// --- a factory fallback ------------------------------------------------------
// The Costs page's empty filters are a factory (a fresh object per call, since
// the reset button hands it straight to the setter). Storing the FUNCTION as the
// state is the one way this could break the page it exists to help.
const emptyFilters = () => ({ status: '', supplier: '' });
check('a factory fallback is called, not stored', restoreView(undefined, emptyFilters), { status: '', supplier: '' });
check('…and a stored object still merges over it', restoreView({ supplier: 'Grab' }, emptyFilters), { status: '', supplier: 'Grab' });

console.log(failures ? `\n${failures} failing` : '\nAll passing');
process.exit(failures ? 1 : 0);
