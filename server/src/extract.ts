import { Router } from 'express';
import { z } from 'zod';
import { visionEnabled } from './env.js';
import { apportion, notFiller, derivedDescription, withPeriod } from './store.js';
import { recordUsage } from './usage.js';
import { readDocument, resolveProvider, type Provider } from './llm.js';

// Categories are provided per-request by the client (the org's Category list) so
// the model classifies into a value that actually exists in the UI. These are
// the fallback set if the client doesn't send any.
const DEFAULT_CATEGORIES = ['Uncategorised', 'Others'];

// Build the structured-output JSON schema. `category` is an enum of the allowed
// categories so the model must return one that maps to a real dropdown value.
// additionalProperties:false + required on every field is mandatory for strict
// structured outputs.
function buildSchema(categories: string[], taxRateNames: string[], projectNames: string[], customerNames: string[] = []) {
  // Tax-rate picking is only offered when the org has written "when to use"
  // rules (Lists → Tax rates). No rules → the fields are left out of the schema
  // entirely, so the model is never asked to guess a tax code.
  const taxRateFields = taxRateNames.length
    ? {
        taxRate: {
          type: 'string',
          enum: ['', ...taxRateNames],
          description:
            'The tax code whose "when to use" rule clearly applies to THIS document, from the rules listed in the prompt. Return an empty string unless a rule plainly matches — a near-miss, a guess, or "it could be" must be an empty string, because the empty string falls back to a safe calculation from the printed GST.',
        },
        taxRateReason: {
          type: 'string',
          description:
            'When taxRate is non-empty, one short sentence quoting the part of the rule the document satisfies, e.g. "Overseas supplier (US) billing services used in Singapore — matches the reverse charge rule." Empty string when taxRate is empty.',
        },
      }
    : {};
  const projectFields = projectNames.length
    ? {
        project: {
          type: 'string',
          enum: ['', ...projectNames],
          description:
            'The project / PIC this document belongs to, from the list in the prompt — by a written rule it satisfies, or by the document plainly naming that site, property, entity or person. Return an empty string unless one plainly applies: a near-miss or a guess must be an empty string, because the empty string falls back to the uploader\'s own assigned project.',
        },
        projectReason: {
          type: 'string',
          description:
            'When project is non-empty, one short sentence naming the evidence on the document — the rule it satisfies, or where the project is named on it, e.g. "Billed for the unit at that project\'s address." Empty string when project is empty.',
        },
      }
    : {};
  // Who this cost is to be billed BACK to — a cost incurred on a client's behalf
  // and recharged to them. Only offered when the org has customers to choose
  // from; without the list the field would be free text and a wrong name is
  // worse than a blank one, because it is the party who gets invoiced.
  const customerFields = customerNames.length
    ? {
        // Xero's billable expense, Dext's "rebillable". Asked alongside the
        // customer because it is the same judgement: a cost the organisation
        // paid on a client's behalf and will bill back. Meaningless without a
        // customer — there would be nobody to bill — so it is only offered when
        // the customer list is.
        rebillable: {
          type: 'boolean',
          description:
            'TRUE only when this cost was incurred on the named customer\'s behalf and will be BILLED BACK to them — a recharge, a reimbursable disbursement, a cost the covering message says to recharge or rebill. FALSE for the organisation\'s own costs, which is most of them. Never true without a customer: it means "bill this to that client", and with no client named there is nobody to bill.',
        },
        customer: {
          type: 'string',
          enum: ['', ...customerNames],
          description:
            'The CUSTOMER this cost is to be recharged / billed back to, from the list in the prompt. This is NOT who the document was issued to (that is this organisation) and NOT the supplier — it is the client who will be charged for this cost. Two things can put it there: the document itself naming the client the cost was incurred for, or a covering message saying so ("recharge this to X", "this is for X\'s job", "bill this back to X"). Return an EMPTY STRING unless one of those plainly names a customer on the list: an empty string leaves it for a person, and a wrong name here invoices the wrong client.',
        },
      }
    : {};
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...taxRateFields,
      ...projectFields,
      ...customerFields,
      supplier: {
        type: 'string',
        description:
          'The merchant / supplier name AS PRINTED on the document — the party that was PAID, never the bill-to / customer. Copy it from the text: the logo wordmark, letterhead, footer, "powered by" line, the payment descriptor, or the support address\'s domain. NEVER infer a brand from what the document LOOKS like: ride-hailing, food-delivery and e-wallet receipts share a layout, and a trip, a card line and a total are not evidence of WHICH company issued it. When a document names BOTH a legal entity and an outlet or trading name — "Marina Bay Sands Pte Ltd" above "MARQUEE", a mall tenant under its group\'s name — use the entity the GST or company registration number belongs to: that is who issued the tax invoice, who the ledger owes, and who the GST is claimed from. If no name is printed anywhere, return an empty string — a blank supplier is corrected in seconds, where a confidently wrong one is published to the ledger as the wrong contact.',
      },
      date: {
        type: 'string',
        description:
          'The document/transaction date as ISO YYYY-MM-DD. Printed dates are Singapore format DD/MM/YYYY (day first), e.g. "25/1/2026" and "25/01/26" both mean 2026-01-25. Expand a 2-digit year YY to 20YY (26 → 2026 — NEVER 2019 or 1926). Never invent a month; read it exactly. Empty string if no date is printed.',
      },
      documentType: { type: 'string', enum: ['Receipt', 'Invoice', 'Other'] },
      invoiceNumber: {
        type: 'string',
        description: 'Invoice / receipt number as printed; empty string if none shown',
      },
      currency: {
        type: 'string',
        description:
          'The 3-letter ISO code the amounts are in, as the document gives it: AUD, USD, MYR, GBP. Do NOT default to SGD — a Singapore business is billed in every currency, and a foreign amount recorded as local money is wrong in the ledger by the whole exchange rate. Where only a SYMBOL is printed, the supplier decides it: "$" beside an ABN or 10% GST is AUD, beside a UEN or 9%/8%/7% GST is SGD, "RM" is MYR, "£" GBP, "€" EUR, and a US address with "$" is USD. Answer SGD only when nothing on the document — code, symbol, tax rate, registration number or address — says otherwise.',
      },
      total: { type: 'number', description: 'Grand total amount' },
      tax: { type: 'number', description: 'Tax / GST amount; 0 if none shown' },
      category: {
        type: 'string',
        enum: categories,
        description:
          'The single best-matching expense category from the allowed list. Use "Uncategorised" only if none fit.',
      },
      categoryReason: {
        type: 'string',
        description:
          'One short sentence explaining WHY this category fits — cite the account name/description it matched or the merchant/purchase type, e.g. "Software subscription invoice — matched the 485 Subscriptions account." or "Restaurant dining — matched Business meetings / staff meals." If uncategorised, say why nothing fit. If you genuinely cannot say, return an EMPTY STRING rather than filler such as "placeholder" or "N/A".',
      },
      // Only meaningful when a covering message was supplied (an emailed
      // document). It is what lets the note BEAT a standing supplier rule: a
      // rule is a policy about every document from that supplier, a note is a
      // person's instruction about this one, and the specific instruction has
      // to win — but only when there actually was one, which is what this says.
      noteFollowed: {
        type: 'string',
        description:
          'ONLY when a covering message was supplied above AND you took something from it: one short sentence naming what you took and which field it decided, e.g. "The sender asked to recharge this to CY-Biz — coded to the recharge account." EMPTY STRING when no message was supplied, or when it said nothing that bears on how this document is coded (a bare "here you go", a signature, a forwarded thread with no instruction). Never invent one to seem useful: an empty string here means the organisation\'s own standing rules decide, which is the safe answer.',
      },
      description: {
        type: 'string',
        description:
          'A concise plain-language summary of what was purchased. Always attempt one: the merchant and document type alone are enough for a useful answer, so itemisation is a bonus, not a requirement. Examples: "Grab ride Jurong to Pasir Panjang", "Office stationery — pens, paper", "Monthly mobile and broadband charges" (a telco bill), "Annual company secretarial fee", "Card payment at Marina Bay Sands (Marquee)" (a bare payment slip). Return an EMPTY STRING ONLY if the document is illegible or you cannot tell what it is at all — and NEVER filler such as "placeholder", "N/A", "unknown" or "description". This text is published to the accounting ledger, where a made-up word is worse than a blank.',
      },
      dueDate: {
        type: 'string',
        description:
          'The payment due date PRINTED on the document, as ISO YYYY-MM-DD — a stated "Due Date"/"Payment Due", or the date explicit payment terms resolve to ("Net 15" / "15 days from invoice date" counted from the invoice date, "Due on receipt" = the invoice date). Singapore format DD/MM/YYYY, day first. Empty string when the document states neither a due date nor terms — never guess one, and never just repeat the invoice date, because an empty string lets the organisation\'s own payment terms apply instead.',
      },
      period: {
        type: 'string',
        description:
          'The service / billing period the document covers, if it shows one — copy the dates as printed, e.g. "Bill Period 25 May - 24 Jun 2026" → "25 May – 24 Jun 2026"; "Billing period: August 2026" → "August 2026"; "Subscription 01/09/2026 to 31/08/2027" → "1 Sep 2026 – 31 Aug 2027". Empty string when the document shows no period. NEVER infer one from the invoice or due date — a bill dated 28 Jun with no stated period has no period.',
      },
      cardLast4: {
        type: 'string',
        description:
          'The LAST 4 DIGITS of the payment card if shown anywhere (e.g. "Mastercard ...7849", "XXXX XXXX XXXX 7849", "card ending 7849"). Digits only, exactly 4. Empty string if no card number is shown (cash, unknown).',
      },
      supplierGstRegNo: {
        type: 'string',
        description:
          "The SUPPLIER's GST / tax registration number exactly as printed, e.g. \"GST Reg No: 201614382R\" → \"201614382R\", \"GST Registration No. M90370287L\" → \"M90370287L\", \"ABN 51 824 753 556\" → \"51 824 753 556\". Empty string when the document shows none. NEVER the BUYER's number — the bill-to party's registration, printed near its address, belongs to the customer, not the supplier. A company/UEN number not labelled as a tax or GST registration is not one either.",
      },
      taxLabel: {
        type: 'string',
        description:
          'What the document CALLS the tax it charges, copied as printed — "GST", "GST 9%", "GST charged at 9%", "VAT", "Sales Tax", "SST", "Consumption Tax", "TVA". Empty string when it charges no tax. Copy the words; do not translate "VAT" into "GST".',
      },
      lineItems: {
        type: 'array',
        description:
          'The itemised CHARGE rows if the document has any; empty array if none. Never a subtotal, total, balance brought/carried forward, payment received or rounding row — those summarise the charges rather than being one. (The Costs page reads line items properly through its own pass; these are a summary aid.)',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: { type: 'string', description: 'What this line is for' },
            category: {
              type: 'string',
              enum: categories,
              description: 'Best-matching category for THIS line from the allowed list; "Uncategorised" if unclear',
            },
            net: { type: 'number', description: 'Line amount excluding tax; 0 if not separable' },
            tax: { type: 'number', description: 'Tax on this line; 0 if none' },
            amount: { type: 'number', description: 'Line total including tax' },
          },
          required: ['description', 'amount'],
        },
      },
    },
    required: [
      'supplier',
      'date',
      'documentType',
      'invoiceNumber',
      'currency',
      'total',
      'tax',
      'category',
      'categoryReason',
      'description',
      'dueDate',
      'period',
      'supplierGstRegNo',
      'taxLabel',
      'cardLast4',
      'lineItems',
      ...(taxRateNames.length ? ['taxRate', 'taxRateReason'] : []),
      ...(projectNames.length ? ['project', 'projectReason'] : []),
    ],
  };
}

// Validates the model's JSON before we trust it.
const ReceiptSchema = z.object({
  supplier: z.string(),
  date: z.string(),
  documentType: z.enum(['Receipt', 'Invoice', 'Other']),
  invoiceNumber: z.string(),
  currency: z.string(),
  total: z.number(),
  tax: z.number(),
  category: z.string(),
  categoryReason: z.string().optional().default(''),
  noteFollowed: z.string().optional().default(''),
  customer: z.string().optional().default(''),
  rebillable: z.boolean().optional().default(false),
  description: z.string().optional().default(''),
  dueDate: z.string().optional().default(''),
  period: z.string().optional().default(''),
  cardLast4: z.string().optional().default(''),
  supplierGstRegNo: z.string().optional().default(''),
  taxLabel: z.string().optional().default(''),
  taxRate: z.string().optional().default(''),
  taxRateReason: z.string().optional().default(''),
  project: z.string().optional().default(''),
  projectReason: z.string().optional().default(''),
  lineItems: z.array(
    z.object({
      description: z.string(),
      amount: z.number(),
      net: z.number().optional(),
      tax: z.number().optional(),
      category: z.string().optional(),
    })
  ),
});

const IMAGE_MEDIA = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
const PDF_MEDIA = 'application/pdf';
const ALLOWED_MEDIA = [...IMAGE_MEDIA, PDF_MEDIA];

export const extractRouter = Router();

type AccountRef = { code: string; name: string; description: string };

// Parse the optional Xero chart-of-accounts from the request body. Each account
// contributes a "<code> - <name>" category label; its description guides the
// model's classification.
function parseAccounts(raw: unknown): AccountRef[] {
  if (!Array.isArray(raw)) return [];
  const out: AccountRef[] = [];
  for (const a of raw) {
    const code = typeof a?.code === 'string' ? a.code.trim() : '';
    const name = typeof a?.name === 'string' ? a.name.trim() : '';
    if (!code || !name) continue;
    out.push({ code, name, description: typeof a?.description === 'string' ? a.description.trim() : '' });
  }
  return out;
}

type TaxRateRef = { name: string; code: string; rate: number; rules: string };

// Parse the optional tax-rate list from the request body. ONLY rates the org has
// written a "when to use" rule for are kept — a rate with no rule is the
// client's arithmetic job, not the model's.
function parseTaxRates(raw: unknown): TaxRateRef[] {
  if (!Array.isArray(raw)) return [];
  const out: TaxRateRef[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    const name = typeof t?.name === 'string' ? t.name.trim() : '';
    const rules = typeof t?.rules === 'string' ? t.rules.trim() : '';
    if (!name || !rules || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      code: typeof t?.code === 'string' ? t.code.trim() : '',
      rate: Number(t?.rate) || 0,
      rules: rules.slice(0, 600), // guard the prompt size
    });
    if (out.length >= 40) break;
  }
  return out;
}

type NamedRule = { name: string; rules: string };

// The project (Xero tracking) options a document may be allocated to. Unlike the
// tax rates — where a code without a written rule is arithmetic's job, not the
// model's — EVERY option is passed through here, rule or not. A bill that names
// its site or entity on its face can be allocated from the name alone; a written
// rule makes that judgement sharper, it isn't the price of entry.
function parseNamedRules(raw: unknown): NamedRule[] {
  if (!Array.isArray(raw)) return [];
  const out: NamedRule[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    const name = typeof t?.name === 'string' ? t.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const rules = typeof t?.rules === 'string' ? t.rules.trim() : '';
    out.push({ name, rules: rules.slice(0, 600) }); // guard the prompt size
    if (out.length >= 60) break;
  }
  return out;
}

// The extracted-and-cleaned fields for one document — what the POST handler
// returns as `data`, and what the inbound-email reader writes onto the bill.
export type ExtractedFields = z.infer<typeof ReceiptSchema>;

// Everything the read needs, already gathered — the browser sends these on the
// request; the inbound path assembles the same set server-side (see
// server/src/inbound.ts). Provider is already resolved to a real engine.
export type ExtractionInputs = {
  provider: Provider;
  imageBase64: string;
  mediaType: string;
  accounts: AccountRef[];
  categories: string[]; // plain fallback categories, used only when accounts is empty
  // The org's customer contacts, for a cost being recharged to one of them.
  // Empty = the field isn't offered at all.
  customers?: string[];
  taxRates: TaxRateRef[];
  projects: NamedRule[];
  instructions: string;
};

// What the sender wrote when they forwarded the document, as guidance for the
// read. "recharge this to CY-Biz" is the whole point of somebody emailing a
// receipt in rather than uploading it: the covering line says what to DO with
// it, and reading the attachment while ignoring the message throws that away.
//
// Given as the sender's note, plainly labelled, and after the organisation's own
// rules — so it can say which customer, project or category a document is for
// without being able to override how the practice codes things. Capped, because
// a forwarded thread runs to hundreds of lines and only the top of it is the
// instruction.
export function emailInstruction(
  envelope: { from?: string; subject?: string; text?: string; via?: string } | null
): string {
  const note = String(envelope?.text || '').trim().slice(0, 1500);
  const subject = String(envelope?.subject || '').trim().slice(0, 200);
  if (!note && !subject) return '';
  const who = String(envelope?.from || '').trim();
  // How it arrived, in the sentence that introduces the note. A WhatsApp
  // caption and a covering email are the same KIND of thing — one person's
  // instruction about this one document — and everything below applies to
  // both; saying "emailed in" about a chat message would just be a lie the
  // reader has to reconcile.
  const arrived = envelope?.via === 'whatsapp' ? 'SENT IN OVER WHATSAPP' : 'EMAILED IN';
  return (
    `\n\nThis document was ${arrived}${who ? ` by ${who}` : ''}, and the covering message is below. ` +
    'Treat it as a note from that person about this document: it may say which customer, project, category or ' +
    'person the cost is for, and you should follow it where it plainly does.\n' +
    // The accounts above carry the practice's own descriptions, and those
    // descriptions are written in the same words people use when they forward a
    // receipt — "costs incurred on behalf of client, which we will RECHARGE
    // back to them" is account 261. Matching the note against them is the whole
    // point of having written them, and has to be asked for: the guide above
    // asks what was PURCHASED, which a covering instruction is not.
    'Read it against the account descriptions above as well as against the document. A word in the message that ' +
    "matches how an account describes itself — a recharge, a reimbursement, a client's own cost — is the sender " +
    'telling you which account this is, and it beats a guess made from the supplier alone.\n' +
    'It is not an instruction to ignore what the document itself says: the printed supplier, dates and amounts ' +
    'always win.\n' +
    (subject ? `Subject: ${subject}\n` : '') +
    (note ? `Message: ${note}\n` : '')
  );
}

type ReadOutcome = Awaited<ReturnType<typeof readDocument>>;
export type ExtractionResult =
  | { ok: true; data: ExtractedFields; outcome: ReadOutcome }
  | { ok: false; error: 'refused' | 'no_data' | 'extraction_failed'; status: number; outcome?: ReadOutcome };

// The one document read, free of Express — a receipt image or PDF invoice
// through the org's chosen reader, classified into the Xero chart of accounts
// (when `accounts` is given) or a plain category list, with the same tax-code /
// project / review-instruction guidance an upload gets. The POST route below is
// a thin wrapper; the inbound-email path calls this directly so an emailed
// document is read EXACTLY the way an uploaded one is. Never throws — a failure
// comes back as { ok:false }. The caller records usage from `outcome`.
export async function runExtraction(inp: ExtractionInputs): Promise<ExtractionResult> {
  const { accounts, provider, imageBase64, mediaType } = inp;

  // Prefer a Xero chart of accounts (with descriptions); otherwise fall back to
  // a plain category list. Either way, always include an "Uncategorised" escape.
  const accountLabels = accounts.map((a) => `${a.code} - ${a.name}`);
  const source = accountLabels.length ? accountLabels : inp.categories;
  const categories = source.length
    ? Array.from(new Set([...source, 'Uncategorised']))
    : DEFAULT_CATEGORIES;
  const categorySet = new Set(categories);

  // Organisation-level Review instructions (business overview + GST/coding
  // overrides). Prepended as context; may override the printed GST/tax and guide
  // the account choice + supplier identification.
  const instructions = (inp.instructions || '').slice(0, 6000); // guard the prompt size
  const contextBlock = instructions
    ? `Business context and coding rules for this organisation — apply these when extracting and classifying. They can override the printed GST/tax amount (e.g. substitute 0), guide which account code to choose, and say how to identify the supplier:\n${instructions}\n\n`
    : '';

  // A description-annotated guide so the model classifies by what each Xero
  // account is for, not just its name.
  const accountsGuide = accounts.length
    ? '\n\nClassify `category` into exactly one of these Xero accounts, choosing by the description that best matches what was purchased:\n' +
      accounts
        .map((a) => `- "${a.code} - ${a.name}"${a.description ? `: ${a.description}` : ''}`)
        .join('\n')
    : '';

  // A bridge entity has no chart of accounts — its people pick the plain names
  // off their own claim policy. The enum alone would leave the model matching on
  // wording; what it needs is what the names MEAN, which is different guidance
  // from an account's description.
  const categoriesGuide = !accounts.length && inp.categories.length
    ? '\n\nClassify `category` into exactly one of the categories below. These are this organisation\'s own expense categories — plain names from its claim policy, not accounting codes — so choose by WHAT WAS BOUGHT:\n' +
      '- Transport is the MODE the document names: a taxi or private-hire receipt is the taxi category, a rail fare the train one, an airline the flights one. Never a general one when the specific one exists.\n' +
      '- Where the categories distinguish WHEN (a weekday late-night meal against a weekend one, an overnight allowance against a per-trip one), the document\'s own date and time decide it.\n' +
      '- When none of them plainly fits, use "Others". Never the closest-sounding one — a wrong category here is a wrong line on somebody\'s claim.\n' +
      inp.categories.map((c) => `- "${c}"`).join('\n')
    : '';

  // The customers a cost can be recharged to. A short guide, because the field is
  // about a relationship the DOCUMENT usually doesn't state: a taxi receipt says
  // nothing about who it is billed back to — the covering note does.
  const customers = (inp.customers || []).filter(Boolean);
  const customerSet = new Set(customers);
  const customersGuide = customers.length
    ? '\n\nRECHARGING. Some costs are incurred on a client\'s behalf and billed back to them. Set `customer` to the ONE client below that this cost is to be recharged to, when the document names them as who it was incurred for, or when the covering message says so. Otherwise return an empty string — most costs are the organisation\'s own and have no customer.\n' +
      customers.map((c) => `- "${c}"`).join('\n') +
      '\nSet `rebillable` TRUE only alongside such a customer, and only when the cost is genuinely being billed back to them — that is what puts it on their next invoice. FALSE for the organisation\'s own costs.'
    : '';

  // Tax rates the org has written rules for, and the guide that teaches them.
  const taxRates = inp.taxRates;
  const taxRateNames = taxRates.map((t) => t.name);
  const taxRateSet = new Set(taxRateNames);
  const taxRatesGuide = taxRates.length
    ? '\n\nTAX CODE RULES. This organisation has written the following rules for when a tax code applies. Set `taxRate` to the ONE code whose rule this document plainly satisfies, and `taxRateReason` to why. If no rule plainly applies — including when the document just shows ordinary GST at the standard rate — return an empty string for both; the correct code is then worked out from the printed GST amount, which is safer than a guess.\n' +
      taxRates
        .map((t) => `- "${t.name}" (${[t.code, `${t.rate}%`].filter(Boolean).join(', ')}): ${t.rules}`)
        .join('\n')
    : '';

  // Projects the org has written rules for, and the guide that teaches them.
  const projects = inp.projects;
  const projectNames = projects.map((p) => p.name);
  const projectSet = new Set(projectNames);
  const projectsGuide = projects.length
    ? '\n\nPROJECT (PIC) ALLOCATION. This organisation allocates documents to the projects below. Set `project` to the ONE this document belongs to, and `projectReason` to the evidence on the document that says so. Decide in this order:\n' +
      '1. A project whose written rule the document plainly satisfies.\n' +
      '2. Otherwise, a project the document plainly identifies by name — the site, property, unit or job the charge is FOR, matching the project name or an obvious abbreviation of it.\n' +
      'IGNORE who the document is billed TO. The "Bill to" party, the "Attn:" contact and the recipient address are this organisation and its staff, not the project — a person named there must never decide the allocation, even when their name or initials resemble a project. Match only what the charge is about.\n' +
      'A shared word, a near-miss, or "it could be" is NOT a match. When nothing on the document points to one project, return an empty string for both fields — the document is then allocated to the uploader\'s own project, which is safer than a guess.\n' +
      projects.map((p) => `- "${p.name}"${p.rules ? `: ${p.rules}` : ' (no rule written — match by name only)'}`).join('\n')
    : '';

  // Everything identical for every document in this organisation, in one block:
  // the fixed reading instructions, the org's own review instructions, and the
  // account / tax-code / project guides. Sent as a CACHED system prefix so it is
  // billed once per cache window instead of once per document — the guides run
  // to thousands of tokens and were previously re-bought on every upload. Both
  // readers cache it; llm.ts knows how each one is asked.
  //
  // Nothing per-document may appear here. Today's date and whether the file is a
  // PDF both go in the message below: the date would invalidate the cache daily,
  // and the PDF/image wording would split one cache entry into two.
  const stablePrompt =
    contextBlock +
    'You extract purchase and expense details from receipts and invoices. ' +
    'Use the values printed on the document. Capture the invoice/receipt number exactly as printed when present. ' +
    'Never identify a company that is not named on the document. A screenshot of an app receipt is often cropped above its brand, and the layout alone does not say which company it is — returning the wrong merchant is worse than returning none, so leave `supplier` empty rather than pick the best-known brand of that kind. ' +
    'Dates are Singapore format DD/MM/YYYY (day first); a 2-digit year YY means 20YY (so "25/01/26" = 2026-01-25). Read the day and month exactly and output the date as ISO YYYY-MM-DD. ' +
    'Classify the expense into the single best-matching category from the allowed list provided in the schema; ' +
    'pick "Uncategorised" only when none reasonably fit. ' +
    'Read `supplierGstRegNo` and `taxLabel` from the document exactly as printed. They decide whether the tax charged is Singapore GST a business may claim, ' +
    'or a foreign tax it may not — a Thai invoice at 7% VAT and a Singapore one at 7% GST look identical in the numbers alone, and only the registration number and the wording tell them apart. ' +
    'The registration number must be the SUPPLIER\'s, never the buyer\'s. ' +
    'If a field is not present, use an empty string or 0. ' +
    'EXCEPTION: always write a non-empty `description` and `categoryReason` for every document — infer them from the merchant, visible items and document type even for a sparse card slip (never leave these two blank).' +
    accountsGuide +
    categoriesGuide +
    taxRatesGuide +
    projectsGuide +
    customersGuide;

  const isPdf = mediaType === PDF_MEDIA;

  try {
    const outcome = await readDocument({
      provider,
      fileBase64: imageBase64,
      mediaType,
      maxTokens: 1024,
      schemaName: 'expense_document',
      schema: buildSchema(categories, taxRateNames, projectNames, customers),
      // Cached per organisation (see stablePrompt above) — the guides run to
      // thousands of tokens and must not be re-bought on every upload.
      systemPrompt: stablePrompt,
      prompt:
        `Extract the purchase/expense details from this ${isPdf ? 'invoice/receipt PDF' : 'receipt or invoice image'}. ` +
        `Today is ${new Date().toISOString().slice(0, 10)}.`,
    });

    if (!outcome.ok) {
      return { ok: false, error: outcome.reason === 'refused' ? 'refused' : 'no_data', status: outcome.reason === 'refused' ? 422 : 502, outcome };
    }

    const parsed = ReceiptSchema.safeParse(outcome.json);
    if (!parsed.success) {
      return { ok: false, error: 'no_data', status: 502, outcome };
    }
    // Belt-and-suspenders: snap to a known category if the model somehow strays.
    const taxRate = taxRateSet.has(parsed.data.taxRate) ? parsed.data.taxRate : '';
    const project = projectSet.has(parsed.data.project) ? parsed.data.project : '';
    // Same for the customer: the party who gets invoiced for this cost is not a
    // field to accept a name the org has never heard of.
    const customer = customerSet.has(parsed.data.customer) ? parsed.data.customer : '';
    // Never rebillable without somebody to bill. The flag says "charge this to
    // that client", so with no client it is an instruction with no object — and
    // it would publish as a billable expense against nobody.
    const rebillable = Boolean(customer) && parsed.data.rebillable === true;
    // A due date that isn't a real ISO date is no due date. Same for one that
    // merely echoes the invoice date, which is what the model produces when it
    // feels obliged to fill the field — and which posts to Xero as "due the day
    // it was issued" rather than "terms unknown".
    const dueDate =
      /^\d{4}-\d{2}-\d{2}$/.test(parsed.data.dueDate) && parsed.data.dueDate !== parsed.data.date
        ? parsed.data.dueDate
        : '';
    const category = categorySet.has(parsed.data.category) ? parsed.data.category : 'Uncategorised';
    const data: ExtractedFields = {
      ...parsed.data,
      category,
      // Nothing usable from the reader (it declined, or wrote filler) — compose
      // one from the fields we did read rather than leave the field blank. It's
      // derived from the document, not invented: supplier and the category it
      // was coded to. Blank only when even that is unknown.
      description: withPeriod(
        notFiller(parsed.data.description) || derivedDescription(parsed.data.supplier, category, parsed.data.documentType),
        notFiller(parsed.data.period)
      ),
      categoryReason: notFiller(parsed.data.categoryReason),
      noteFollowed: notFiller(parsed.data.noteFollowed),
      customer,
      rebillable,
      taxRate,
      taxRateReason: taxRate ? notFiller(parsed.data.taxRateReason) : '',
      project,
      projectReason: project ? notFiller(parsed.data.projectReason) : '',
      dueDate,
      supplierGstRegNo: notFiller(parsed.data.supplierGstRegNo),
      taxLabel: notFiller(parsed.data.taxLabel),
      lineItems: parsed.data.lineItems.map((li) => ({ ...li, description: notFiller(li.description) })),
    };
    return { ok: true, data, outcome };
  } catch (err) {
    console.error('[extract] failed', err);
    return { ok: false, error: 'extraction_failed', status: 500 };
  }
}

// POST /api/costs/extract — body: { imageBase64, mediaType, accounts?, categories?,
// taxRates?, projects?, instructions?, provider? }. Thin wrapper over
// runExtraction: validates the request, resolves the reader, records usage, and
// maps the result to the HTTP response. 503 until at least one of
// ANTHROPIC_API_KEY / OPENAI_API_KEY is configured.
extractRouter.post('/extract', async (req, res) => {
  if (!visionEnabled) return res.status(503).json({ error: 'vision_not_configured' });

  const imageBase64 = typeof req.body?.imageBase64 === 'string' ? req.body.imageBase64 : '';
  const mediaType = typeof req.body?.mediaType === 'string' ? req.body.mediaType : '';
  if (!imageBase64 || !ALLOWED_MEDIA.includes(mediaType)) {
    return res.status(400).json({ error: 'invalid_image' });
  }

  const rawCats: unknown = req.body?.categories;
  const bodyCats = Array.isArray(rawCats)
    ? rawCats.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : [];
  const rawInstructions = typeof req.body?.instructions === 'string' ? req.body.instructions.trim() : '';
  // A document that arrived by email carries the note it came with. Re-reading
  // it has to see that note too — read once WITH "recharge this to CY-Biz" and
  // again without it, and the second read quietly undoes the first.
  const note = (req.body?.emailNote ?? null) as { from?: string; subject?: string; text?: string } | null;

  const result = await runExtraction({
    // The org picks the reader in Business settings → Extraction and the client
    // sends the choice along; resolveProvider falls back to the deploy's default
    // when the named one has no API key configured.
    provider: resolveProvider(req.body?.provider),
    imageBase64,
    mediaType,
    accounts: parseAccounts(req.body?.accounts),
    categories: bodyCats,
    customers: Array.isArray(req.body?.customers)
      ? req.body.customers.filter((c: unknown): c is string => typeof c === 'string' && c.trim().length > 0)
      : [],
    taxRates: parseTaxRates(req.body?.taxRates),
    projects: parseNamedRules(req.body?.projects),
    instructions: `${rawInstructions}${emailInstruction(note)}`,
  });

  // What this document cost to read. Recorded per call and attributed to the
  // client entity it was uploaded for — the practice's Clients page has no other
  // source for API spend. A refused or unparseable read still burned tokens, so
  // it is recorded whenever the read actually ran.
  if (result.outcome) {
    recordUsage(req, {
      feature: 'extract',
      provider: result.outcome.provider,
      model: result.outcome.model,
      usage: result.outcome.usage,
    });
  }

  if (!result.ok) return res.status(result.status).json({ error: result.error });
  return res.json({ ok: true, data: result.data });
});

// --- Line items -------------------------------------------------------------
// POST /api/costs/extract-lines — body: { imageBase64, mediaType, accounts?,
// categories?, instructions?, provider?, documentTotal? }. Reads the itemised
// table off a document and nothing else.
//
// Deliberately its own pass rather than a field on /extract. The general read
// spends its attention (and its output budget) on supplier / date / category /
// the three reason fields, and gave line items three words of schema
// description — which is how a "Balance brought forward" row ends up in the
// grid as a charge, and why the rows didn't add up to the invoice.
//
// Two things make this one trustworthy: the prompt says out loud which rows are
// NOT charges, and the answer is checked against the document's own grand total
// before it is returned. A set that doesn't add up is re-read once, told what it
// got wrong; if it still doesn't, the lines come back flagged rather than
// silently pasted into the grid.
const LinesSchema = z.object({
  grandTotal: z.number(),
  subTotal: z.number().optional().default(0),
  taxTotal: z.number().optional().default(0),
  currency: z.string().optional().default(''),
  note: z.string().optional().default(''),
  lines: z.array(
    z.object({
      description: z.string(),
      category: z.string().optional().default(''),
      project: z.string().optional().default(''),
      quantity: z.number().optional().default(1),
      unitAmount: z.number().optional().default(0),
      net: z.number().optional().default(0),
      tax: z.number().optional().default(0),
      amount: z.number(),
    })
  ),
});

// The rows every itemised document has that are NOT charges. Naming them is the
// single highest-value instruction here: a summary row read as a charge both
// invents an expense and breaks the reconciliation that would have caught it.
const NOT_A_CHARGE =
  'Subtotal, Total, Grand total, Amount due, Balance due, Balance brought forward, ' +
  'Balance carried forward, Previous balance, Opening balance, Closing balance, ' +
  'Payment received, Credit applied, Deposit, Rounding, a GST/tax summary row, ' +
  'and any per-page or section total on a multi-page document';

function buildLinesSchema(categories: string[], projectNames: string[]) {
  // Only offered when the org actually has tracking options to choose from —
  // an enum of one empty string would just be a field to get wrong.
  const projectField = projectNames.length
    ? {
        project: {
          type: 'string',
          enum: ['', ...projectNames],
          description:
            'The project / site / outlet THIS line is for, from the list in the prompt — taken from what the row itself names, or from the section heading it sits under. Empty string when nothing on the row or above it points to one; the line then follows the document\'s own project.',
        },
      }
    : {};
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      grandTotal: {
        type: 'number',
        description:
          "The document's own printed grand total, including tax — the final amount payable. Not a subtotal, and not a running balance.",
      },
      subTotal: {
        type: 'number',
        description:
          'The printed subtotal BEFORE tax, when the document shows one (e.g. "SUB TOTAL 1,045.00" above a "GST 9% 94.05" line). 0 when it shows no separate subtotal.',
      },
      taxTotal: {
        type: 'number',
        description:
          'The single GST/tax figure printed for the whole document (e.g. "GST 9%  94.05"), when it states tax once at the foot rather than per row. 0 when the document shows no tax, or breaks tax down on every row instead.',
      },
      currency: {
        type: 'string',
        description:
          'The 3-letter ISO code these amounts are in, as the document gives it (AUD, USD, MYR…). Never default to SGD; where only a symbol is printed, read it from the supplier — an ABN or 10% GST means AUD, a UEN or 9% GST means SGD.',
      },
      lines: {
        type: 'array',
        description:
          'One entry per CHARGE row in the itemised table, in the order printed. Empty array when the document has no itemised table — never invent a single line for the total.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: {
              type: 'string',
              description:
                'What this line is for, as printed. Never filler such as "N/A", "-" or "item" — if a row has no description worth copying it is probably not a charge row.',
            },
            category: {
              type: 'string',
              enum: categories,
              description:
                'Best-matching category for THIS line from the allowed list; "Uncategorised" if unclear.',
            },
            ...projectField,
            quantity: {
              type: 'number',
              description: 'The quantity PRINTED on the row; 1 when the row shows no quantity.',
            },
            unitAmount: {
              type: 'number',
              description:
                'The unit price / rate PRINTED on the row, excluding tax; 0 when the row shows no unit price. Never the extended amount.',
            },
            net: {
              type: 'number',
              description:
                "This row's amount excluding tax, when the row itself prints both. Otherwise 0 — the server works it out from the document's tax figure.",
            },
            tax: {
              type: 'number',
              description:
                'Tax charged on THIS row, ONLY when the document prints a tax figure against this row. 0 when tax is stated once for the whole document — never split the document-level GST across rows yourself, and never put all of it on one row.',
            },
            amount: {
              type: 'number',
              description:
                "The figure printed in this row's amount column, EXACTLY as printed. Copy it — never multiply quantity by unit price yourself, because a printed row already accounts for discounts, minimum charges and rounding. Whether it includes tax is not your problem: the document's own subtotal and tax figures settle that.",
            },
          },
          required: ['description', 'category', ...Object.keys(projectField), 'quantity', 'unitAmount', 'net', 'tax', 'amount'],
        },
      },
      note: {
        type: 'string',
        description:
          "Empty string when the charge rows add up to the subtotal (or, on a document with no separate tax figure, to grandTotal). Otherwise one short sentence saying what the document does that explains the gap (e.g. \"Invoice settles a prior balance of 250.00 shown above the itemised table\"). Never use this to excuse a row you were unsure about — leave that row out instead.",
      },
    },
    required: ['grandTotal', 'subTotal', 'taxTotal', 'currency', 'lines', 'note'],
  };
}

extractRouter.post('/extract-lines', async (req, res) => {
  if (!visionEnabled) return res.status(503).json({ error: 'vision_not_configured' });

  const imageBase64 = typeof req.body?.imageBase64 === 'string' ? req.body.imageBase64 : '';
  const mediaType = typeof req.body?.mediaType === 'string' ? req.body.mediaType : '';
  if (!imageBase64 || !ALLOWED_MEDIA.includes(mediaType)) {
    return res.status(400).json({ error: 'invalid_image' });
  }

  const accounts = parseAccounts(req.body?.accounts);
  const rawCats: unknown = req.body?.categories;
  const bodyCats = Array.isArray(rawCats)
    ? rawCats.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : [];
  const accountLabels = accounts.map((a) => `${a.code} - ${a.name}`);
  const source = accountLabels.length ? accountLabels : bodyCats;
  const categories = source.length
    ? Array.from(new Set([...source, 'Uncategorised']))
    : DEFAULT_CATEGORIES;
  const categorySet = new Set(categories);

  const rawInstructions = typeof req.body?.instructions === 'string' ? req.body.instructions.trim() : '';
  const instructions = rawInstructions.slice(0, 6000);
  const contextBlock = instructions
    ? `Business context and coding rules for this organisation — apply these when classifying each line:\n${instructions}\n\n`
    : '';

  // The org's projects (its first Xero tracking category — outlets, sites,
  // properties), so each LINE can be allocated to the one it is for. An invoice
  // that bills three outlets on one page is the whole reason line items exist
  // here; leaving every row on the document's single project throws that away.
  const projects = parseNamedRules(req.body?.projects);
  const projectNames = projects.map((p) => p.name);
  const projectSet = new Set(projectNames);
  const projectsGuide = projects.length
    ? '\n\nPER-LINE PROJECT. This organisation allocates work to the projects below (its sites / outlets / jobs). Set each line\'s `project` to the ONE that line is for:\n' +
      '1. What the row itself names — the site, property, unit or outlet the charge is FOR, matching a project name or an obvious abbreviation of it (e.g. a row reading "Alternate Service - Every Mon & Thurs (Tangs Plaza #04-04)" is the Tangs project).\n' +
      '2. Otherwise the SECTION it sits under. Itemised invoices group rows beneath a heading that names the site, and every row below that heading belongs to it until the next heading — the unlabelled "Additional bag" rows under a Tangs Plaza heading are Tangs, not the document\'s default.\n' +
      '3. A project whose written rule the row plainly satisfies.\n' +
      'IGNORE who the document is billed TO: the "Bill to" address is this organisation, not the project, even when it names a place that resembles one.\n' +
      'A shared word, a near-miss or "it could be" is NOT a match — return an empty string for that line and it follows the document\'s own project, which is safer than a guess.\n' +
      projects.map((p) => `- "${p.name}"${p.rules ? `: ${p.rules}` : ''}`).join('\n')
    : '';
  const accountsGuide = accounts.length
    ? '\n\nClassify each line\'s `category` into exactly one of these Xero accounts, choosing by the description that best matches what THAT LINE is for:\n' +
      accounts.map((a) => `- "${a.code} - ${a.name}"${a.description ? `: ${a.description}` : ''}`).join('\n')
    : '';

  // A bridge entity has no chart of accounts — its people pick the plain names
  // off their own claim policy. The enum alone would leave the model matching on
  // wording; what it needs is what the names MEAN, which is different guidance
  // from an account's description.
  const categoriesGuide = !accounts.length && bodyCats.length
    ? '\n\nClassify `category` into exactly one of the categories below. These are this organisation\'s own expense categories — plain names from its claim policy, not accounting codes — so choose by WHAT WAS BOUGHT:\n' +
      '- Transport is the MODE the document names: a taxi or private-hire receipt is the taxi category, a rail fare the train one, an airline the flights one. Never a general one when the specific one exists.\n' +
      '- Where the categories distinguish WHEN (a weekday late-night meal against a weekend one, an overnight allowance against a per-trip one), the document\'s own date and time decide it.\n' +
      '- When none of them plainly fits, use "Others". Never the closest-sounding one — a wrong category here is a wrong line on somebody\'s claim.\n' +
      bodyCats.map((c) => `- "${c}"`).join('\n')
    : '';

  // Cached per organisation, exactly like /extract: nothing per-document here,
  // including the reconciliation feedback on a retry (that rides in `prompt`).
  const stablePrompt =
    contextBlock +
    'You read the itemised table off a purchase invoice or receipt. You return the CHARGE rows and nothing else.\n' +
    `NOT charges, and never returned as lines: ${NOT_A_CHARGE}. ` +
    'These summarise other rows; returning one both invents an expense and hides the real ones.\n' +
    'Copy every figure exactly as printed. Do not compute an amount the document does not show — a printed row already accounts for discounts, minimum charges and rounding, so quantity times unit price is NOT a substitute for the printed line amount.\n' +
    'A charge split across pages is still one table: continue reading it, and ignore the carried-forward figures that join the pages.\n' +
    "Read the document's summary block as it is printed: `grandTotal` is the final amount payable, `subTotal` the figure before tax, and `taxTotal` the one GST/tax figure stated for the whole document. " +
    'Most invoices state GST once at the foot. On those, every row\'s `tax` is 0 and the rows add up to the SUBTOTAL — that is correct and expected, and the GST is shared out across the rows afterwards. ' +
    'Put a figure in a row\'s `tax` ONLY when the document prints tax against that row. NEVER split the document-level GST across the rows yourself, and NEVER load all of it onto one row to make a column add up.\n' +
    'THE CHECK, before you answer: add up the `amount` of every line you are about to return. The sum must equal `subTotal` when the document prints one, otherwise `grandTotal`. ' +
    'If it is larger, you have included a summary row — find it and drop it. If it is smaller, you have missed charge rows — find them. ' +
    'Only when neither is true (the document itself settles an earlier balance, say) may they differ, and then `note` must say why.\n' +
    'A document with no itemised table has no lines: return an empty array rather than one line for the total.' +
    accountsGuide +
    categoriesGuide +
    projectsGuide;

  const isPdf = mediaType === PDF_MEDIA;
  const provider = resolveProvider(req.body?.provider);
  // Cents, so the comparison isn't at the mercy of binary floating point.
  const cents = (n: number) => Math.round(Number(n) * 100);
  const sumOf = (lines: Array<{ amount: number }>) => lines.reduce((t, l) => t + cents(l.amount), 0);

  // Turn what the model read into rows that carry their own net, tax and total,
  // and say whether they are the same money as the document.
  //
  // The shape nearly every Singapore invoice uses is: rows printed EXCLUDING
  // GST, then "SUB TOTAL / GST 9% / TOTAL" at the foot. Read literally that
  // means the rows add up to the subtotal, not the total — so the one GST
  // figure is shared out across them here (by net, largest remainder, so the
  // parts sum to the whole exactly). Without this the reader has to force the
  // column to add up on its own, and what it does is dump the entire GST onto
  // the last row: a 45.00 line carrying 94.05 of tax.
  //
  // Rows are gross instead when they add up to the grand total; rows that carry
  // their own printed tax are left exactly as they are.
  const settle = (data: z.infer<typeof LinesSchema>) => {
    const rows = data.lines;
    const amounts = rows.map((l) => cents(l.amount));
    const rowsSum = amounts.reduce((a, b) => a + b, 0);
    const grand = cents(data.grandTotal);
    const stated = Math.max(0, cents(data.taxTotal));
    const printedTax = rows.reduce((t, l) => t + cents(l.tax), 0);

    // Tax the document itself put on the rows wins; anything else is settled
    // from the single stated figure.
    let taxes: number[];
    let netBasis: number[];
    if (printedTax > 0) {
      taxes = rows.map((l) => cents(l.tax));
      netBasis = amounts.map((a, i) => (rowsSum === grand ? a - taxes[i] : a));
    } else if (stated > 0 && rowsSum !== grand && rowsSum + stated === grand) {
      // Rows are net of GST (they add up to the subtotal) — share it out.
      netBasis = amounts;
      taxes = apportion(stated, amounts);
    } else if (stated > 0 && rowsSum === grand) {
      // Rows already include GST — share it out of them.
      taxes = apportion(stated, amounts);
      netBasis = amounts.map((a, i) => a - taxes[i]);
    } else {
      taxes = amounts.map(() => 0);
      netBasis = amounts;
    }

    const settled = rows.map((l, i) => ({
      ...l,
      net: netBasis[i] / 100,
      tax: taxes[i] / 100,
      amount: (netBasis[i] + taxes[i]) / 100,
    }));
    const total = settled.reduce((t, l) => t + cents(l.amount), 0);
    return { lines: settled, linesTotal: total / 100, reconciled: rows.length > 0 && total === grand };
  };

  const read = async (feedback: string) => {
    const outcome = await readDocument({
      provider,
      fileBase64: imageBase64,
      mediaType,
      // Line items are the whole answer here, not a field at the end of one, and
      // a long invoice is many rows — /extract's 1024 would truncate the JSON.
      maxTokens: 4096,
      schemaName: 'document_line_items',
      schema: buildLinesSchema(categories, projectNames),
      systemPrompt: stablePrompt,
      prompt:
        `Read the itemised charge rows from this ${isPdf ? 'invoice/receipt PDF' : 'receipt or invoice image'}.` +
        feedback,
    });
    recordUsage(req, {
      feature: 'extract-lines',
      provider: outcome.provider,
      model: outcome.model,
      usage: outcome.usage,
    });
    if (!outcome.ok) return null;
    const parsed = LinesSchema.safeParse(outcome.json);
    return parsed.success ? parsed.data : null;
  };

  try {
    let data = await read('');
    if (!data) return res.status(502).json({ error: 'no_data' });

    // The check the model was asked to do, done again here — because a model
    // that miscounts is exactly the one that won't notice it miscounted. One
    // re-read, told the arithmetic it got wrong; a second failure is reported,
    // not hidden. The comparison is against the SETTLED rows, so an invoice
    // whose rows are net of a GST stated at the foot is right, not "short".
    let attempts = 1;
    let out = settle(data);
    if (data.lines.length && !out.reconciled) {
      const target = cents(data.subTotal) && cents(data.subTotal) !== cents(data.grandTotal) ? data.subTotal : data.grandTotal;
      const retry = await read(
        ` Your previous answer returned ${data.lines.length} lines whose amounts add up to ${(sumOf(data.lines) / 100).toFixed(2)}, ` +
          `but this document's charge rows should add up to ${target.toFixed(2)}. ` +
          'One of those lines is a summary row, or a charge row is missing. Read the table again and return only the charge rows.'
      );
      attempts = 2;
      // Keep the retry only when it actually did better — a second answer that
      // is further out is not an improvement.
      if (retry) {
        const alt = settle(retry);
        const off = (r: { linesTotal: number }, d: { grandTotal: number }) => Math.abs(cents(r.linesTotal) - cents(d.grandTotal));
        if (off(alt, retry) < off(out, data)) {
          data = retry;
          out = alt;
        }
      }
    }

    const lines = out.lines.map((li) => ({
      ...li,
      description: notFiller(li.description),
      category: categorySet.has(li.category) ? li.category : 'Uncategorised',
      // Belt and braces: a project the org doesn't have is no project, and the
      // line falls back to the document's.
      project: projectSet.has(li.project) ? li.project : '',
    }));
    return res.json({
      ok: true,
      data: {
        lines,
        grandTotal: data.grandTotal,
        subTotal: data.subTotal,
        taxTotal: data.taxTotal,
        currency: data.currency,
        linesTotal: out.linesTotal,
        // Whether the grid can be trusted without a human adding it up.
        reconciled: out.reconciled,
        note: notFiller(data.note),
        attempts,
      },
    });
  } catch (err) {
    console.error('[extract-lines] failed', err);
    return res.status(500).json({ error: 'extraction_failed' });
  }
});

// --- Vault document summariser ----------------------------------------------
// POST /api/vault/summarize — body: { imageBase64, mediaType, provider? }. Returns
// a short Subject line + a few-sentence Summary for a stored Vault document
// (Dext's document auto-fill). 503 until a reader API key is configured.
const SummarySchema = z.object({ subject: z.string(), summary: z.string() });

export const vaultRouter = Router();

vaultRouter.post('/summarize', async (req, res) => {
  if (!visionEnabled) return res.status(503).json({ error: 'vision_not_configured' });

  const imageBase64 = typeof req.body?.imageBase64 === 'string' ? req.body.imageBase64 : '';
  const mediaType = typeof req.body?.mediaType === 'string' ? req.body.mediaType : '';
  if (!imageBase64 || !ALLOWED_MEDIA.includes(mediaType)) {
    return res.status(400).json({ error: 'invalid_image' });
  }

  const provider = resolveProvider(req.body?.provider);

  try {
    const outcome = await readDocument({
      provider,
      fileBase64: imageBase64,
      mediaType,
      maxTokens: 512,
      schemaName: 'document_summary',
      // Identical for every Vault document, so it rides in the system prefix —
      // too short to hit either provider's cache minimum, but it costs nothing
      // to put it in the right place.
      systemPrompt:
        'You summarise stored business documents. Return a concise "subject" line (like an ' +
        'email subject, under 12 words) and a "summary" of 2–4 sentences describing what the ' +
        'document is, who it is from, and the key figures or purpose.',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subject: { type: 'string', description: 'Short subject line' },
          summary: { type: 'string', description: '2–4 sentence summary' },
        },
        required: ['subject', 'summary'],
      },
      prompt: 'Summarise this document.',
    });

    recordUsage(req, {
      feature: 'summarize',
      provider: outcome.provider,
      model: outcome.model,
      usage: outcome.usage,
    });

    if (!outcome.ok) {
      return outcome.reason === 'refused'
        ? res.status(422).json({ error: 'refused' })
        : res.status(502).json({ error: 'no_data' });
    }
    const parsed = SummarySchema.safeParse(outcome.json);
    if (!parsed.success) return res.status(502).json({ error: 'no_data' });
    return res.json({ ok: true, data: parsed.data });
  } catch (err) {
    console.error('[vault summarize] failed', err);
    return res.status(500).json({ error: 'summarize_failed' });
  }
});
