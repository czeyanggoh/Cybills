// The tick CYBills puts on the message a bill arrived in.
//
// A person who photographs a receipt into a WhatsApp group gets no receipt of
// their own, so the reaction IS the acknowledgement — and because WhatsApp
// keeps only one reaction per account per message, the second one replaces the
// first rather than sitting beside it. That is what makes the progression
// legible (grey: we have read it; green: Xero says it is paid) and also what
// makes the ORDER load-bearing: a re-read that put grey back over green would
// tell the sender their paid bill had come undone.
//
// So what is pinned down here is the decision — which tick a document has
// earned, from the document alone — and that it is said EXACTLY ONCE per
// change. Both matter because the far end is a client's chat.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-wa-react-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'relay-key';
process.env.CYWORKSPACE_RELAY_URL = 'https://cyworkspace.cy-bm.sg';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'Acme Pte Ltd', tenantId: 't-1', tenantName: 'Acme', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

// --- CYWS, stubbed -----------------------------------------------------------
type ReactCall = { submission_id: string; wa_message_id: string; emoji: string };
const reactCalls: ReactCall[] = [];
let reactStatus = 200;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/api/webhooks/cybills/react')) {
    reactCalls.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify(reactStatus === 200 ? { data: {} } : { error: 'react_failed' }), {
      status: reactStatus,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

const { insertBill, updateBill, markBillXeroPayment, getBillById } = await import('../src/store.ts');
const { syncWhatsappReaction, reactionFor, REACT_READ, REACT_PAID } = await import('../src/waReactions.ts');

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const ORG = 'org_one0001';
const whatsapp = {
  submissionId: 'CYB-org_one0001-a1b2c3d4',
  chatId: '120363000@g.us',
  chatSubject: 'CYBills - Acme Pte Ltd',
  messageId: 'MSG-1',
  waMessageId: 'false_120363000@g.us_ABCDEF',
  from: '60123456789@c.us',
  senderName: 'Kaylee',
  text: '',
  sentAt: new Date(0).toISOString(),
  fileName: 'receipt.jpg',
};
const newBill = (over: Record<string, unknown> = {}) =>
  insertBill({
    orgId: ORG,
    fileHash: Math.random().toString(36),
    fileName: 'receipt.jpg',
    supplier: '',
    invoiceNumber: '',
    documentType: '',
    currency: '',
    total: 0,
    tax: 0,
    date: '',
    category: '',
    createdBy: 'kaylee@example.com',
    owner: 'kaylee@example.com',
    whatsapp,
    storageKey: 'shared:whatsapp/x.jpg',
    contentType: 'image/jpeg',
    status: 'new',
    kind: 'cost',
    ...over,
  } as any);

// --- Which tick a document has earned ----------------------------------------
// Decided from the document itself, never from which caller reached it. That is
// what makes the three separate routes Xero's "paid" arrives by — the webhook,
// the payments sweep, the reply to an update — add up to one reaction.
check('an uploaded document has no message to react to', reactionFor({ supplier: 'Zuya', total: 24.8 }), '');
check('nothing read yet: nothing to say', reactionFor({ whatsapp, supplier: '', total: 0 }), '');
check('a supplier was read: the grey tick', reactionFor({ whatsapp, supplier: 'Zuya', total: 0 }), REACT_READ);
check('a total alone is enough — some receipts name no supplier', reactionFor({ whatsapp, supplier: '', total: 24.8 }), REACT_READ);
check('Xero says paid: the green one', reactionFor({ whatsapp, supplier: 'Zuya', total: 24.8, xeroStatus: 'PAID' }), REACT_PAID);
// Not "not paid": a bill awaiting payment and a bill that was voided are
// different answers, and neither is the sender's business.
check('awaiting payment is still the grey tick', reactionFor({ whatsapp, supplier: 'Zuya', total: 24.8, xeroStatus: 'AUTHORISED' }), REACT_READ);
check('a voided bill keeps what it had', reactionFor({ whatsapp, supplier: 'Zuya', total: 24.8, xeroStatus: 'VOIDED' }), REACT_READ);
// The message is still in somebody's chat. A deletion here is not news the
// group needs, and clearing a tick would read as the document going missing.
check('a deleted document says nothing new', reactionFor({ whatsapp, supplier: 'Zuya', total: 24.8, status: 'deleted' }), '');

// --- Saying it, once ---------------------------------------------------------
const bill = newBill();

await syncWhatsappReaction(ORG, bill.id);
check('a read that got nothing is left bare — send a clearer photo', reactCalls.length, 0);

// The read comes back.
updateBill(ORG, bill.id, { supplier: 'Zuya Vegetarian', total: 24.8 });
await syncWhatsappReaction(ORG, bill.id);
check('once it is read, the grey tick goes on', reactCalls.length, 1);
check('on that message, in that group', [reactCalls[0].submission_id, reactCalls[0].wa_message_id], [whatsapp.submissionId, whatsapp.waMessageId]);
check('and it is the grey one', reactCalls[0].emoji, REACT_READ);

// A field edit, a re-read, a duplicate webhook — anything that runs again.
updateBill(ORG, bill.id, { category: '429' });
await syncWhatsappReaction(ORG, bill.id);
check('nothing changed, so nothing is said again', reactCalls.length, 1);

// Xero says it was paid. Same message, and the tick the sender is looking at
// turns green rather than a second one appearing beside it.
markBillXeroPayment(ORG, bill.id, { xeroStatus: 'PAID', xeroPaidDate: '2026-08-29', xeroPaymentRef: 'DBS-1' });
await syncWhatsappReaction(ORG, bill.id);
check('paid turns it green', [reactCalls.length, reactCalls[1].emoji], [2, REACT_PAID]);
check('on the same message', reactCalls[1].wa_message_id, whatsapp.waMessageId);

// The re-read a reviewer presses AFTER the bill was paid. This is the one that
// would be wrong: grey back over green tells the sender their paid bill came
// undone. The decision reads the document, so it cannot happen.
updateBill(ORG, bill.id, { supplier: 'Zuya Vegetarian Pte Ltd' });
await syncWhatsappReaction(ORG, bill.id);
check('a later re-read cannot knock it back to grey', reactCalls.length, 2);
check('and the document still says green', getBillById(ORG, bill.id)?.whatsappReaction, REACT_PAID);

// --- When CYWS will not take it ----------------------------------------------
// Recording a tick that never reached WhatsApp would make the next attempt a
// no-op, and the message would stay bare for good.
reactStatus = 502;
const refused = newBill({ supplier: 'Xtreme Laundry', total: 315 });
await syncWhatsappReaction(ORG, refused.id);
check('a refusal is not recorded as sent', getBillById(ORG, refused.id)?.whatsappReaction ?? '', '');
check('and filing the document was not held up by it', getBillById(ORG, refused.id)?.supplier, 'Xtreme Laundry');

reactStatus = 200;
await syncWhatsappReaction(ORG, refused.id);
check('so the next thing to happen to it tries again', reactCalls.at(-1)?.emoji, REACT_READ);
check('and this time it sticks', getBillById(ORG, refused.id)?.whatsappReaction, REACT_READ);

globalThis.fetch = realFetch;
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
