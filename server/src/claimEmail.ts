import { env } from './env.js';
import { escapeHtml, type EmailAttachment } from './email.js';
import type { Claim, Txn } from './claims.js';

// ---------------------------------------------------------------------------
// Server-side rendering of the expense-claim emails.
//
// These builders take STRUCTURED data (a stored claim + a few typed options)
// and emit the HTML themselves, escaping every interpolated value. The client
// never supplies an HTML body — VA01@cy-bm.sg is a trusted internal sender and
// an "email arbitrary HTML as VA01" endpoint would be a phishing relay.
//
// Styling is inline because email clients strip <style> blocks and ignore
// external stylesheets. Outlook-safe defaults, matching CYWorkspace:
// font-family:Aptos,Calibri,Arial,sans-serif; font-size:11pt; color:#111111;
// tables with border-collapse:collapse and explicit per-cell borders.
// ---------------------------------------------------------------------------

const FONT = 'font-family:Aptos,Calibri,Arial,sans-serif;font-size:11pt;color:#111111;';
const MUTED = '#5a5a5a';
const BORDER = '1px solid #d0d0d0';

/** A table cell. Escapes its value — always route content through here. */
const td = (v: unknown, extra = '') =>
  `<td style="border:${BORDER};padding:5px 9px;vertical-align:top;${extra}">${escapeHtml(v ?? '')}</td>`;

/** A header cell. */
const th = (v: unknown, extra = '') =>
  `<th style="border:${BORDER};padding:5px 9px;text-align:left;background:#f3f3f3;font-weight:600;${extra}">${escapeHtml(
    v ?? ''
  )}</th>`;

const RIGHT = 'text-align:right;white-space:nowrap;';

const num = (v: unknown) => (Number(v) || 0).toFixed(2);
const money = (v: unknown, currency = 'SGD') => `${currency} ${num(v)}`;

/** Sum one numeric column across the claim's rows. */
function sum(txns: Txn[], key: 'net' | 'tax' | 'total'): number {
  return txns.reduce((n, t) => n + (Number(t[key]) || 0), 0);
}

/** Roll the rows up by category, preserving first-seen order. */
function byCategory(txns: Txn[]): Array<{ category: string; net: number; tax: number; total: number }> {
  const map = new Map<string, { category: string; net: number; tax: number; total: number }>();
  for (const t of txns) {
    const key = t.category || 'Uncategorised';
    const row = map.get(key) || { category: key, net: 0, tax: 0, total: 0 };
    row.net += Number(t.net) || 0;
    row.tax += Number(t.tax) || 0;
    row.total += Number(t.total) || 0;
    map.set(key, row);
  }
  return [...map.values()];
}

/** Absolute link back into CYBills — mail clients can't resolve relative URLs. */
export function claimUrl(claimId: string): string {
  return `${env.APP_PUBLIC_URL.replace(/\/+$/, '')}/expense-claims/${encodeURIComponent(claimId)}`;
}

export type ClaimDetailLevel = 'summary' | 'items';

/** Totals we quote in both the subject line and the body. */
export function claimTotals(claim: Claim) {
  const txns = claim.transactions || [];
  return {
    count: txns.length,
    net: sum(txns, 'net'),
    tax: sum(txns, 'tax'),
    total: sum(txns, 'total'),
    currency: claim.currency || 'SGD',
  };
}

// --- Shared chrome ---------------------------------------------------------

function shell(inner: string): string {
  return `<div style="${FONT}line-height:1.45;">${inner}
  <p style="${FONT}color:${MUTED};font-size:9pt;margin:22px 0 0;">
    Sent by CYBills on behalf of CY Business Management. Replies go to the sender named above.
  </p>
</div>`;
}

function detailTable(claim: Claim, detailLevel: ClaimDetailLevel): string {
  const txns = claim.transactions || [];
  const t = claimTotals(claim);
  const open = `<table role="presentation" cellpadding="0" cellspacing="0" style="${FONT}border-collapse:collapse;margin:14px 0;">`;

  if (txns.length === 0) {
    return `<p style="${FONT}color:${MUTED};margin:14px 0;">This claim has no line items yet.</p>`;
  }

  if (detailLevel === 'items') {
    const head = `<tr>${th('Date')}${th('Supplier')}${th('Category')}${th('Project')}${th(
      'Net',
      RIGHT
    )}${th('Tax', RIGHT)}${th('Total', RIGHT)}</tr>`;
    const body = txns
      .map(
        (x) =>
          `<tr>${td(x.date)}${td(x.supplier)}${td(x.category)}${td(x.project || '—')}${td(
            num(x.net),
            RIGHT
          )}${td(num(x.tax), RIGHT)}${td(num(x.total), RIGHT)}</tr>`
      )
      .join('');
    const foot = `<tr>${td('', 'border:none;')}${td('', 'border:none;')}${td('', 'border:none;')}${td(
      'Total',
      'font-weight:600;'
    )}${td(num(t.net), RIGHT + 'font-weight:600;')}${td(num(t.tax), RIGHT + 'font-weight:600;')}${td(
      num(t.total),
      RIGHT + 'font-weight:600;'
    )}</tr>`;
    return `${open}${head}${body}${foot}</table>`;
  }

  const head = `<tr>${th('Category')}${th('Net', RIGHT)}${th('Tax', RIGHT)}${th('Total', RIGHT)}</tr>`;
  const body = byCategory(txns)
    .map(
      (c) =>
        `<tr>${td(c.category)}${td(num(c.net), RIGHT)}${td(num(c.tax), RIGHT)}${td(
          num(c.total),
          RIGHT
        )}</tr>`
    )
    .join('');
  const foot = `<tr>${td('Total', 'font-weight:600;')}${td(num(t.net), RIGHT + 'font-weight:600;')}${td(
    num(t.tax),
    RIGHT + 'font-weight:600;'
  )}${td(num(t.total), RIGHT + 'font-weight:600;')}</tr>`;
  return `${open}${head}${body}${foot}</table>`;
}

function metaTable(rows: Array<[string, unknown]>): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="${FONT}border-collapse:collapse;margin:14px 0;">${rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:2px 16px 2px 0;color:${MUTED};vertical-align:top;">${escapeHtml(
          label
        )}</td><td style="padding:2px 0;vertical-align:top;">${escapeHtml(value ?? '—')}</td></tr>`
    )
    .join('')}</table>`;
}

function button(href: string, label: string): string {
  const safe = escapeHtml(href);
  return `<p style="margin:18px 0;"><a href="${safe}" style="${FONT}display:inline-block;padding:8px 16px;background:#111111;color:#ffffff;text-decoration:none;border-radius:4px;">${escapeHtml(
    label
  )}</a></p>`;
}

// --- A. Claim summary, sent to an external recipient -----------------------

export interface ClaimSummaryEmailInput {
  claim: Claim;
  /** Recipient's display name, used only in the greeting. */
  toName: string;
  /** Free-text note from the sender. Rendered as escaped text, never as HTML. */
  message?: string;
  detailLevel: ClaimDetailLevel;
  /** Display name of the CYBills user sending it (the mailbox is still VA01). */
  senderName: string;
}

export function claimSummarySubject(claim: Claim): string {
  const t = claimTotals(claim);
  return `Expense claim: ${claim.name || 'Untitled claim'} (${money(t.total, t.currency)})`;
}

export function buildClaimSummaryHtml(input: ClaimSummaryEmailInput): string {
  const { claim, toName, message, detailLevel, senderName } = input;
  const t = claimTotals(claim);

  // Preserve the sender's line breaks without trusting their markup: escape
  // first, then turn the newlines in the ESCAPED string into <br>.
  const note = message?.trim()
    ? `<div style="${FONT}margin:14px 0;padding:10px 14px;border-left:3px solid #d0d0d0;background:#fafafa;">${escapeHtml(
        message.trim()
      ).replace(/\r?\n/g, '<br>')}</div>`
    : '';

  return shell(`
  <p style="${FONT}margin:0 0 12px;">Hi ${escapeHtml(toName || 'there')},</p>
  <p style="${FONT}margin:0 0 12px;">
    ${escapeHtml(senderName || 'A CYBills user')} has shared an expense claim with you.
  </p>
  ${note}
  ${metaTable([
    ['Claim', claim.name || 'Untitled claim'],
    ['Claim for', claim.claimFor],
    ['Claim date', claim.claimDate || claim.endDate],
    ['Line items', String(t.count)],
    ['Total', money(t.total, t.currency)],
  ])}
  ${detailTable(claim, detailLevel)}
  ${button(claimUrl(claim.id), 'Open in CYBills')}`);
}

// --- B. Approval request, sent to the assigned approver --------------------

export function approvalRequestSubject(claim: Claim): string {
  const t = claimTotals(claim);
  return `Approval needed: ${claim.name || 'Untitled claim'} (${money(t.total, t.currency)})`;
}

export function buildApprovalRequestHtml(claim: Claim, submittedBy: string): string {
  const t = claimTotals(claim);
  return shell(`
  <p style="${FONT}margin:0 0 12px;">Hi ${escapeHtml(claim.approver || 'there')},</p>
  <p style="${FONT}margin:0 0 12px;">
    ${escapeHtml(submittedBy || 'A CYBills user')} submitted an expense claim for your approval.
  </p>
  ${metaTable([
    ['Claim', claim.name || 'Untitled claim'],
    ['Claim for', claim.claimFor],
    ['Submitted by', submittedBy],
    ['Line items', String(t.count)],
    ['Total', money(t.total, t.currency)],
  ])}
  ${detailTable(claim, 'summary')}
  ${button(claimUrl(claim.id), 'Review and approve')}
  <p style="${FONT}color:${MUTED};margin:12px 0 0;">
    You're receiving this because you were named as the approver on this claim.
  </p>`);
}

// --- CSV attachment (built server-side from the same structured rows) ------

function csvCell(v: unknown): string {
  let s = String(v ?? '');
  // Formula-injection guard. Supplier/category text comes from receipt
  // extraction (i.e. third-party document content) and this CSV is emailed out
  // to be opened in Excel, where a leading = + - @ makes the cell a formula.
  // Prefix those with an apostrophe — but leave plain negative numbers alone so
  // credit amounts still parse as numbers.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV of the claim, mirroring the client-side export in src/lib/claimCsv.js so
 * the emailed file matches what the Export button produces.
 */
export function buildClaimCsv(claim: Claim, detailLevel: ClaimDetailLevel): string {
  const txns = claim.transactions || [];
  const t = claimTotals(claim);
  const cur = t.currency;
  const rows: unknown[][] = [];

  if (detailLevel === 'items') {
    rows.push(['Date', 'Item ID', 'Supplier', 'Category', 'Project', `Net (${cur})`, `Tax (${cur})`, `Total (${cur})`]);
    for (const x of txns) {
      rows.push([x.date, x.itemId, x.supplier, x.category, x.project || '', num(x.net), num(x.tax), num(x.total)]);
    }
    rows.push(['', '', '', '', 'Total', num(t.net), num(t.tax), num(t.total)]);
  } else {
    rows.push(['Claim name', 'Claim ID', 'Claim date', 'Category', `Net (${cur})`, `Tax (${cur})`, `Total (${cur})`]);
    for (const c of byCategory(txns)) {
      rows.push([claim.name, claim.id, claim.claimDate, c.category, num(c.net), num(c.tax), num(c.total)]);
    }
    rows.push(['', '', '', 'Total', num(t.net), num(t.tax), num(t.total)]);
  }

  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** Filename-safe slug for the attachment name. */
function slug(s: string): string {
  return (s || 'claim').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'claim';
}

export function claimCsvAttachment(claim: Claim, detailLevel: ClaimDetailLevel): EmailAttachment {
  return {
    filename: `${slug(claim.name)}-${detailLevel}.csv`,
    contentBase64: Buffer.from(buildClaimCsv(claim, detailLevel), 'utf8').toString('base64'),
    contentType: 'text/csv',
  };
}
