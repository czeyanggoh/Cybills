import assert from 'node:assert/strict';
import { pageOf, pageForSize, pageSizeOf, currentPage } from '../src/lib/listPage.js';

// Fifty at a time, the last page short.
assert.deepEqual(pageOf(51, 50, 0), { page: 0, pages: 2, start: 0, end: 50 });
assert.deepEqual(pageOf(51, 50, 1), { page: 1, pages: 2, start: 50, end: 51 });
// A page past the end is the last page, never an empty one.
assert.deepEqual(pageOf(51, 50, 7), { page: 1, pages: 2, start: 50, end: 51 });
assert.deepEqual(pageOf(51, 50, -3), { page: 0, pages: 2, start: 0, end: 50 });
// 0 is every row.
assert.deepEqual(pageOf(312, 0, 3), { page: 0, pages: 1, start: 0, end: 312 });
// Nothing to show is one empty page.
assert.deepEqual(pageOf(0, 50, 2), { page: 0, pages: 1, start: 0, end: 0 });
// A size nobody offers falls back to 50.
assert.equal(pageSizeOf(37), 50);
assert.equal(pageSizeOf(200), 200);

// Changing the size keeps the first row shown on screen.
assert.equal(pageForSize(100, 200), 0); // rows 101-150 -> 1-200
assert.equal(pageForSize(250, 100), 2); // row 251 -> 201-300
assert.equal(pageForSize(250, 0), 0);

// A page stored against another narrowing is the first page.
assert.equal(currentPage({ at: 'a', n: 3 }, 'a'), 3);
assert.equal(currentPage({ at: 'a', n: 3 }, 'b'), 0);
assert.equal(currentPage(null, 'a'), 0);
assert.equal(currentPage({ at: 'a', n: 'x' }, 'a'), 0);

console.log('list-page: ok');
