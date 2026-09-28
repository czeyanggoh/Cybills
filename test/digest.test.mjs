// The daily digest: which documents a colleague is emailed about, and when.
import {
  digestAddress, docAddresses, inDigest, digestRows, digestDue, digestDays, weekdayOf, daysLabel, daysPhrase,
} from '../src/lib/digest.js';

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures += 1;
};

const doc = (o = {}) => ({ id: 'x', kind: 'cost', status: 'new', documentType: 'Receipt', createdAt: '2026-09-20T01:00:00Z', ...o });

check('an address is read out of a display form', digestAddress('Finance <Finance@Dart.com.sg>') === 'finance@dart.com.sg');
check('owner, uploader and sender are all addresses of a document',
  docAddresses(doc({ owner: 'a@x.sg', createdBy: 'b@x.sg', email: { from: 'Finance <finance@dart.com.sg>' } })).join() ===
    'a@x.sg,b@x.sg,finance@dart.com.sg');

check('an unpaid inbox cost is in', inDigest(doc()));
check('a processing cost is in', inDigest(doc({ status: 'processing' })));
check('a paid receipt is out', !inDigest(doc({ paid: true })));
check('a paid receipt is in when paid ones are asked for', inDigest(doc({ paid: true }), { unpaidOnly: false }));
check('a published bill is out', !inDigest(doc({ xeroInvoiceId: 'inv' })));
check('an archived document is out', !inDigest(doc({ status: 'archived' })));
check('a claimed document is out', !inDigest(doc({ status: 'expenseclaim' })));
check('a sales invoice is out', !inDigest(doc({ kind: 'sales' })));
check('a credit note is out', !inDigest(doc({ documentType: 'Credit note/refund' })));
check('a payment proof is out', !inDigest(doc({ documentType: 'Payment proof' })));

const docs = [
  doc({ id: 'mine', owner: 'finance@dart.com.sg', date: '2026-09-10' }),
  doc({ id: 'mailed', owner: 'org_1.general@cybills.local', email: { from: 'Finance <finance@dart.com.sg>' }, date: '2026-09-01' }),
  doc({ id: 'other', owner: 'someone@dart.com.sg', date: '2026-09-05' }),
  doc({ id: 'fresh', owner: 'finance@dart.com.sg', date: '2026-09-15', createdAt: '2026-09-22T02:00:00Z' }),
];
const rows = digestRows(docs, { addresses: ['FINANCE@dart.com.sg'], since: '2026-09-21T00:00:00Z' });
check('only documents under the named address', rows.map((r) => r.doc.id).join() === 'mailed,mine,fresh');
check('what arrived since the last digest is new', rows.find((r) => r.doc.id === 'fresh').isNew && !rows.find((r) => r.doc.id === 'mine').isNew);
check('no address means everybody', digestRows(docs).length === 4);

check('due once the hour is reached', digestDue({ enabled: true, hour: 8 }, '2026-09-23', 8));
check('not before the hour', !digestDue({ enabled: true, hour: 8 }, '2026-09-23', 7));
check('not twice in a day', !digestDue({ enabled: true, hour: 8, lastSentDay: '2026-09-23' }, '2026-09-23', 12));
check('a late start still sends that day', digestDue({ enabled: true, hour: 8, lastSentDay: '2026-09-22' }, '2026-09-23', 15));
check('not when switched off', !digestDue({ enabled: false, hour: 8 }, '2026-09-23', 12));

// 2026-09-25 is a Friday, the 26th a Saturday, the 27th a Sunday, the 28th a Monday.
const weekdays = { enabled: true, hour: 8, days: [1, 2, 3, 4, 5] };
check('the weekday of a day key is the day named', [25, 26, 27, 28].map((d) => weekdayOf(`2026-09-${d}`)).join() === '5,6,0,1');
check('a weekday digest goes out on Friday', digestDue(weekdays, '2026-09-25', 9));
check('and not on Saturday', !digestDue(weekdays, '2026-09-26', 9));
check('and not on Sunday', !digestDue(weekdays, '2026-09-27', 9));
check('and again on Monday', digestDue({ ...weekdays, lastSentDay: '2026-09-25' }, '2026-09-28', 9));
check('a digest saved before days existed goes out every day', digestDue({ enabled: true, hour: 8 }, '2026-09-26', 9));
check('no day ticked reads as every day, never as none', digestDays([]).length === 7 && digestDue({ enabled: true, hour: 8, days: [] }, '2026-09-27', 9));
check('days are kept Monday first, once each, and only real ones', digestDays([0, 5, '1', 5, 9, 'x']).join() === '1,5,0');
check('the days are named the way people say them',
  [daysLabel(undefined), daysLabel([1, 2, 3, 4, 5]), daysLabel([0, 6]), daysLabel([5, 1, 3])].join('|') ===
    'Every day|Weekdays|Weekends|Mon, Wed, Fri');
check('and said in a sentence', [daysPhrase(undefined), daysPhrase([1, 2, 3, 4, 5]), daysPhrase([1, 3])].join('|') === 'daily|on weekdays|on Mon, Wed');

process.exit(failures ? 1 : 0);
