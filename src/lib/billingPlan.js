// A BILLING PLAN is what a quotation or agreement says the supplier's future
// invoices will be made of.
//
// "Subscription: $1,200 per outlet a month, being $450 development instalment and
// $750 subscription" arrives months later as one printed line of 2,400.00. A
// supplier rule can give that bill ONE account; it cannot split it. So the plan
// records, once, from the agreement, what each invoice is expected to come to and
// how it divides — account, tax code and projects per line — and an invoice that
// agrees with it to the cent is written as those lines.
//
// A plan: { id, supplier, reference, currency, sourceBillId, stages }, and a
// stage: { id, name, from, to, quantity, billedBefore, lines: [{ description,
// amount, category, project, project2, taxRate }] }. A stage's amounts are those
// of ONE invoice, and `from` / `to` bound the invoice dates it covers (blank =
// open). `quantity` is how many invoices the stage runs to (0 = not said) and
// `billedBefore` how many of them were billed outside this book, so what is
// still to be billed can be counted (stageProgress).
//
// Three rules hold it:
//   - it never changes a document's money: the rows add up to its total and its
//     tax, to the cent, or there are no rows;
//   - an invoice that disagrees is SAID, never fitted ("expected 2,400.00");
//   - two stages that could both be meant are a choice, and a choice is a
//     person's.
//
// Pure, loaded server-side by path (server/src/billingPlan.ts) so an emailed
// invoice is split exactly as an uploaded one is. Tested by
// test/billing-plan.test.mjs.
import { sameSupplier, isAdvanceDocument } from './prepayment.js';
import { zeroTaxRate, linesAgreeWithTotal } from './taxRateRules.js';

const text = (v) => String(v ?? '').trim();
const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const cents = (v) => Math.round(num(v) * 100);

export const isoDay = (v) => {
  const s = text(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
};

const money = (currency, c) =>
  `${currency ? `${currency} ` : ''}${(c / 100).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const sayDay = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  return y ? `${d} ${MONTHS[m - 1]} ${y}` : '';
};

// A count of invoices: a whole number, never below zero.
const whole = (v) => Math.max(0, Math.floor(num(v)));

export const planLabel = (plan) => text(plan?.reference) || text(plan?.supplier) || 'billing plan';

export const stageTotalCents = (stage) => (stage?.lines || []).reduce((s, l) => s + cents(l?.amount), 0);

/** A plan as it is stored: trimmed, with empty lines and empty stages gone. */
export function cleanPlan(raw) {
  const stages = (Array.isArray(raw?.stages) ? raw.stages : [])
    .map((s, i) => ({
      id: text(s?.id) || `stage-${i + 1}`,
      name: text(s?.name) || `Stage ${i + 1}`,
      from: isoDay(s?.from),
      to: isoDay(s?.to),
      quantity: whole(s?.quantity),
      billedBefore: whole(s?.billedBefore),
      lines: (Array.isArray(s?.lines) ? s.lines : [])
        .filter((l) => cents(l?.amount) !== 0 || text(l?.category) || text(l?.description))
        .map((l) => ({
          description: text(l?.description),
          amount: cents(l?.amount) / 100,
          category: text(l?.category),
          project: text(l?.project),
          project2: text(l?.project2),
          taxRate: text(l?.taxRate),
        })),
    }))
    .filter((s) => s.lines.length);
  return {
    id: text(raw?.id),
    supplier: text(raw?.supplier),
    reference: text(raw?.reference),
    currency: text(raw?.currency).toUpperCase().slice(0, 3),
    sourceBillId: text(raw?.sourceBillId),
    stages,
  };
}

/** What stops a plan being saved, in words; [] when it is good. */
export function planProblems(raw) {
  const plan = cleanPlan(raw);
  const out = [];
  if (!plan.supplier) out.push('Name the supplier.');
  if (!plan.stages.length) out.push('Add at least one line with an amount.');
  for (const s of plan.stages) {
    if (s.lines.some((l) => !l.amount)) out.push(`${s.name}: every line needs an amount.`);
    if (s.lines.some((l) => !l.category || l.category === 'Uncategorised')) out.push(`${s.name}: every line needs a category.`);
    if (stageTotalCents(s) <= 0) out.push(`${s.name}: the invoice amount must be above zero.`);
    if (s.from && s.to && s.from > s.to) out.push(`${s.name}: the end date is before the start date.`);
    if (s.quantity && s.billedBefore > s.quantity) out.push(`${s.name}: more invoices already billed than the stage runs to.`);
  }
  return out;
}

// The kinds of document a plan speaks about: the supplier's bills. Never the
// quotation it was recorded from, a payment proof, a credit note, a statement or
// a mileage record — and never a sale.
const PLANNED_TYPES = new Set(['', 'invoice', 'receipt', 'other', 'document']);
export function takesBillingPlan(doc) {
  const kind = text(doc?.kind);
  if (kind && kind !== 'cost') return false;
  return PLANNED_TYPES.has(text(doc?.documentType ?? doc?.type).toLowerCase());
}

/**
 * Whether a document is what a plan is recorded FROM — a quotation, a pro-forma
 * or an agreement read as Other — rather than one of the bills it speaks about.
 * A plan may be typed while looking at an invoice, and that invoice is billed
 * like any other.
 */
export function isPlanSource(doc) {
  if (!doc) return false;
  const type = doc.documentType ?? doc.type;
  return isAdvanceDocument(type) || text(type).toLowerCase() === 'other';
}

/**
 * Whether a document has been SAVED to a billing plan: the paper a plan is
 * recorded from, archived under it and left out of every Costs list. Asked with
 * the type as well, so one retyped as a bill shows up again.
 */
export function isFiledOnPlan(doc) {
  return Boolean(text(doc?.billingPlanId)) && text(doc?.status) === 'archived' && isPlanSource(doc);
}

/**
 * Why a document cannot be saved to a billing plan, or '' when it can: only the
 * paper a plan is recorded from, never one whose money is somewhere else.
 */
export function planFilingBlock(doc) {
  if (!isPlanSource(doc)) return 'Only a quotation, pro-forma or agreement is saved to a billing plan.';
  if (doc.xeroInvoiceId || doc.paperworkMatch) return 'It is already in Xero.';
  const status = text(doc.status);
  if (status === 'processing') return 'It is still being read.';
  if (status === 'expenseclaim') return 'It is on an expense claim.';
  if (status === 'merged' || status === 'deleted') return 'It is no longer a document of its own.';
  return '';
}

/** The plans recorded for a supplier name (legal forms ignored). */
export function plansForSupplier(supplier, plans) {
  if (!text(supplier)) return [];
  return (Array.isArray(plans) ? plans : []).filter((p) => sameSupplier(supplier, p?.supplier));
}

// `total` cents shared over `weights`, largest remainder, so the parts sum to the
// whole exactly (the same sharing the publish path does with a stated GST figure).
function apportion(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => [e - Math.floor(e), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0 && k < order.length; k += 1, left -= 1) out[order[k][1]] += 1;
  return out;
}

// The document rows one stage gives, or null when the document charges GST and
// no line of the stage may carry it. `basis` says whether the plan's amounts are
// the invoice's total ('total') or its figure before GST ('net').
function stageRows(stage, doc, basis, printedTax, rates) {
  const lines = stage.lines;
  const amounts = lines.map((l) => cents(l.amount));
  const claimed = cents(doc.tax);
  const weights = lines.map((l, i) =>
    zeroTaxRate(text(l.taxRate) || text(doc.taxRate), rates) ? 0 : Math.max(0, amounts[i])
  );
  const taxable = weights.some((w) => w > 0);
  if (claimed && !taxable) return null;
  // GST the supplier added on top of the plan's figures, shared over the lines
  // that carry it (over every line when it is not claimed and none does).
  const added = basis === 'net' ? printedTax : 0;
  const addedShares = apportion(added, taxable ? weights : amounts.map((a) => Math.max(0, a)));
  const taxes = apportion(claimed, weights);
  return lines.map((l, i) => {
    const total = amounts[i] + addedShares[i];
    return {
      description: text(l.description) || text(doc.description),
      category: text(l.category),
      project: text(l.project),
      project2: text(l.project2),
      taxRate: text(l.taxRate),
      net: ((total - taxes[i]) / 100).toFixed(2),
      tax: (taxes[i] / 100).toFixed(2),
      total: (total / 100).toFixed(2),
    };
  });
}

/**
 * What the recorded plans say about a document:
 *   null — nothing: no plan for this supplier, or not a bill, or no total read
 *   { status: 'match', plan, stage, basis, rows }
 *   { status: 'mismatch' | 'outside' | 'ambiguous', plan, reason }
 *
 * `printedTax` is the GST printed on the paper where it differs from the tax the
 * document records (tax nobody may claim); it is what a plan stated before GST
 * is compared against.
 */
export function matchBillingPlan(doc, plans, { printedTax = null, rates = [] } = {}) {
  if (!doc || !takesBillingPlan(doc)) return null;
  const mine = plansForSupplier(doc.supplier, plans);
  const total = cents(doc.total);
  if (!mine.length || total <= 0) return null;
  const currency = text(doc.currency).toUpperCase().slice(0, 3);
  const date = isoDay(doc.date);
  const gst = Math.max(cents(doc.tax), printedTax == null ? 0 : cents(printedTax));

  const covering = [];
  for (const plan of mine) {
    for (const stage of cleanPlan(plan).stages) {
      if (date && ((stage.from && date < stage.from) || (stage.to && date > stage.to))) continue;
      covering.push({ plan, stage });
    }
  }
  if (!covering.length) {
    return {
      status: 'outside',
      plan: mine[0],
      reason: `No stage of billing plan ${planLabel(mine[0])} covers an invoice dated ${sayDay(date) || 'like this'}.`,
    };
  }

  const sameCurrency = covering.filter(({ plan }) => !text(plan.currency) || !currency || text(plan.currency).toUpperCase() === currency);
  if (!sameCurrency.length) {
    const { plan } = covering[0];
    return { status: 'mismatch', plan, reason: `Billing plan ${planLabel(plan)} is in ${plan.currency}; this document is in ${currency}.` };
  }

  // The invoice's own total first; the figure before GST only where no stage is
  // the total.
  let hits = sameCurrency.filter(({ stage }) => stageTotalCents(stage) === total).map((h) => ({ ...h, basis: 'total' }));
  if (!hits.length && gst > 0) {
    hits = sameCurrency.filter(({ stage }) => stageTotalCents(stage) === total - gst).map((h) => ({ ...h, basis: 'net' }));
  }
  if (!hits.length) {
    const { plan } = sameCurrency[0];
    const expected = sameCurrency
      .map(({ stage }) => `${money(currency || plan.currency, stageTotalCents(stage))} (${stage.name})`)
      .join(' or ');
    return {
      status: 'mismatch',
      plan,
      reason: `Billing plan ${planLabel(plan)} expects ${expected}; this document is ${money(currency || plan.currency, total)}.`,
    };
  }
  if (hits.length > 1) {
    const names = hits.map((h) => h.stage.name).join(' and ');
    return {
      status: 'ambiguous',
      plan: hits[0].plan,
      reason: `${names} both come to ${money(currency, total)} on this date, so neither is applied. Give the stages dates that do not overlap.`,
    };
  }
  const [{ plan, stage, basis }] = hits;
  const rows = stageRows(stage, doc, basis, gst, rates);
  if (!rows) {
    return {
      status: 'mismatch',
      plan,
      reason: `This document charges GST, but every line of billing plan ${planLabel(plan)} (${stage.name}) is coded without it.`,
    };
  }
  return { status: 'match', plan, stage, basis, rows };
}

/** The fields a match writes onto its document. */
export function billingPlanPatch(match) {
  if (!match || match.status !== 'match') return {};
  const { plan, stage, rows } = match;
  const largest = rows.reduce((a, b) => (Math.abs(num(b.total)) > Math.abs(num(a.total)) ? b : a), rows[0]);
  const why = `Billing plan ${planLabel(plan)}: ${stage.name}, ${rows.length === 1 ? 'one line' : `${rows.length} lines`} as agreed.`;
  const shared = (k) => (rows.every((r) => r[k] && r[k] === rows[0][k]) ? rows[0][k] : '');
  return {
    lineItems: rows,
    category: largest.category,
    categoryReason: why,
    ...(shared('project') ? { project: shared('project'), projectReason: why } : {}),
    ...(shared('project2') ? { project2: shared('project2') } : {}),
  };
}

// Whether the rows on a document are one stage's: the same accounts and projects
// line for line, adding up to it, each at the plan's amount before or after GST.
function followsStage(doc, stage) {
  const rows = Array.isArray(doc.lineItems) ? doc.lineItems : [];
  if (rows.length !== stage.lines.length || !linesAgreeWithTotal(rows, doc.total)) return false;
  return stage.lines.every((l, i) => {
    const r = rows[i];
    const amount = cents(l.amount);
    return (
      text(r.category) === l.category &&
      text(r.project) === l.project &&
      text(r.project2) === l.project2 &&
      (cents(r.total) === amount || cents(r.net) === amount)
    );
  });
}

/**
 * Where a document stands against its supplier's plans: 'applied' when its rows
 * already are a stage's, else whatever matchBillingPlan says. Null where no plan
 * has anything to say.
 */
export function billingPlanStatus(doc, plans, opts) {
  if (!doc || !takesBillingPlan(doc)) return null;
  const date = isoDay(doc.date);
  for (const plan of plansForSupplier(doc.supplier, plans)) {
    // Two stages can carry the same lines (a renewal): the one covering the
    // invoice's date is the one it is billed under.
    const same = cleanPlan(plan).stages.filter((s) => followsStage(doc, s));
    const stage = same.find((s) => !date || ((!s.from || date >= s.from) && (!s.to || date <= s.to))) || same[0];
    if (stage) return { status: 'applied', plan, stage };
  }
  return matchBillingPlan(doc, plans, opts);
}

// The documents of a book that can count against a plan, oldest first: never a
// deleted, merged-away or flagged duplicate one, nor the quotation or agreement
// the plan was recorded from, and one invoice number once.
function countable(plan, docs) {
  const seen = new Set();
  const dated = (d) => isoDay(d?.date) || '9999-99-99';
  return (Array.isArray(docs) ? docs : [])
    .filter(Boolean)
    .sort((a, b) => dated(a).localeCompare(dated(b)) || String(a.id).localeCompare(String(b.id)))
    .filter((d) => {
      if (['deleted', 'merged'].includes(text(d.status)) || (d.duplicateOfId && !d.duplicateDismissed)) return false;
      if (plan.sourceBillId && d.id === plan.sourceBillId && isPlanSource(d)) return false;
      if (isFiledOnPlan(d)) return false;
      if (!sameSupplier(d.supplier, plan.supplier)) return false;
      const number = text(d.invoiceNumber).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!number || !takesBillingPlan(asBill(d))) return true;
      if (seen.has(number)) return false;
      seen.add(number);
      return true;
    });
}

// The browser's list calls a document's type `type`; the rules read either.
const asBill = (d) => ({ ...d, documentType: d.documentType ?? d.type });

/**
 * How far one stage of a plan has been billed, counted off the book:
 *   { quantity, billedBefore, invoices, billed, left, over }
 * `invoices` are the supplier's bills coded from the stage, or agreeing with it
 * to the cent, oldest first. One invoice number counts once, and a deleted,
 * merged-away or flagged duplicate document not at all. `left` is null where the
 * stage states no quantity.
 */
export function stageProgress(plan, stage, docs) {
  // Judged against the whole plan, so an invoice two stages could both mean is
  // counted for neither rather than for both.
  const known = (plan?.stages || []).some((s) => s.id === stage?.id);
  const within = known ? plan : { ...plan, stages: [stage] };
  const wanted = known ? stage.id : cleanPlan(within).stages[0]?.id;
  const invoices = countable(plan, docs).filter((d) => {
    const status = billingPlanStatus(asBill(d), [within]);
    return (status?.status === 'applied' || status?.status === 'match') && status.stage.id === wanted;
  });
  const quantity = whole(stage?.quantity);
  const billedBefore = whole(stage?.billedBefore);
  const billed = billedBefore + invoices.length;
  return {
    quantity,
    billedBefore,
    invoices,
    billed,
    left: quantity ? Math.max(0, quantity - billed) : null,
    over: quantity ? Math.max(0, billed - quantity) : 0,
  };
}

/** "3 of 24 billed · 21 left (SGD 50,400.00)", or '' where no quantity is set. */
export function progressText(progress, stage, currency) {
  if (!progress?.quantity) return '';
  const { billed, quantity, left, over } = progress;
  if (over) return `${billed} billed, ${over} more than the ${quantity} agreed`;
  if (!left) return `All ${quantity} billed`;
  return `${billed} of ${quantity} billed · ${left} left (${money(currency, left * stageTotalCents(stage))})`;
}

/**
 * One plan as the progress page shows it:
 *   { stages: [{ stage, progress, eachCents, invoicedCents, leftCents,
 *       invoices: [{ doc, place, coded }] }],
 *     differing: [{ doc, reason }], leftCents }
 * `place` is the invoice's number in the stage's run and `coded` whether its
 * lines are already the stage's. `differing` are the supplier's bills this plan
 * does not explain. `leftCents` is what stages with a stated quantity have still
 * to bill, or null where none states one. `allPlans` lets a second agreement with
 * the same supplier claim its own invoices.
 */
export function planOverview(plan, docs, allPlans = [plan]) {
  const stages = cleanPlan(plan).stages.map((stage) => {
    const progress = stageProgress(plan, stage, docs);
    const eachCents = stageTotalCents(stage);
    return {
      stage,
      progress,
      eachCents,
      invoicedCents: progress.invoices.reduce((s, d) => s + cents(d.total), 0),
      leftCents: progress.left == null ? null : progress.left * eachCents,
      invoices: progress.invoices.map((doc, i) => ({
        doc,
        place: progress.billedBefore + i + 1,
        coded: billingPlanStatus(asBill(doc), [plan])?.status === 'applied',
      })),
    };
  });
  const differing = [];
  for (const doc of countable(plan, docs)) {
    const status = billingPlanStatus(asBill(doc), allPlans);
    if (!status || status.status === 'applied' || status.status === 'match') continue;
    if (status.plan.id === plan.id) differing.push({ doc, reason: status.reason });
  }
  const stated = stages.filter((s) => s.leftCents != null);
  return {
    stages,
    differing,
    leftCents: stated.length ? stated.reduce((s, x) => s + x.leftCents, 0) : null,
  };
}

/**
 * Whether a read may write a plan's rows over what the document holds: only where
 * it has none, or rows that do not add up to it (which could not be published
 * anyway). Rows that add up are somebody's breakdown.
 */
export function planMayWriteLines(rows, total) {
  return !Array.isArray(rows) || !rows.length || !linesAgreeWithTotal(rows, total);
}
