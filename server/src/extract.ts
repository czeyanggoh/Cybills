import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env, visionEnabled } from './env.js';

// Categories are provided per-request by the client (the org's Category list) so
// the model classifies into a value that actually exists in the UI. These are
// the fallback set if the client doesn't send any.
const DEFAULT_CATEGORIES = ['Uncategorised', 'Others'];

// Build the structured-output JSON schema. `category` is an enum of the allowed
// categories so the model must return one that maps to a real dropdown value.
// additionalProperties:false + required on every field is mandatory for strict
// structured outputs.
function buildSchema(categories: string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      supplier: { type: 'string', description: 'Merchant / supplier name, e.g. "Grab"' },
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
      currency: { type: 'string', description: '3-letter ISO currency code, e.g. SGD' },
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
          'ALWAYS give one short sentence (never empty) explaining WHY this category fits — cite the account name/description it matched or the merchant/purchase type, e.g. "Software subscription invoice — matched the 485 Subscriptions account." or "Restaurant dining — matched Business meetings / staff meals." If uncategorised, say why nothing fit.',
      },
      description: {
        type: 'string',
        description:
          'ALWAYS provide a concise plain-language summary of what was purchased (never empty) — base it on the merchant, any visible items/services, and the document type. Examples: "Grab ride Jurong to Pasir Panjang", "Office stationery — pens, paper". For a bare card/payment slip with no itemisation, describe it from the merchant, e.g. "Card payment at Marina Bay Sands (Marquee)".',
      },
      cardLast4: {
        type: 'string',
        description:
          'The LAST 4 DIGITS of the payment card if shown anywhere (e.g. "Mastercard ...7849", "XXXX XXXX XXXX 7849", "card ending 7849"). Digits only, exactly 4. Empty string if no card number is shown (cash, unknown).',
      },
      lineItems: {
        type: 'array',
        description: 'Individual line items if present; empty array if none',
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
      'cardLast4',
      'lineItems',
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
  description: z.string().optional().default(''),
  cardLast4: z.string().optional().default(''),
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
type ImageMedia = (typeof IMAGE_MEDIA)[number];

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

// POST /api/costs/extract — body: { imageBase64, mediaType, accounts?, categories? }.
// Runs the receipt image OR PDF invoice through Claude and returns the extracted
// fields, classified into the Xero chart of accounts (when `accounts` is given,
// using each account's description) or a plain category list. 503 until an
// ANTHROPIC_API_KEY is configured.
extractRouter.post('/extract', async (req, res) => {
  if (!visionEnabled) return res.status(503).json({ error: 'vision_not_configured' });

  const imageBase64 = typeof req.body?.imageBase64 === 'string' ? req.body.imageBase64 : '';
  const mediaType = typeof req.body?.mediaType === 'string' ? req.body.mediaType : '';
  if (!imageBase64 || !ALLOWED_MEDIA.includes(mediaType)) {
    return res.status(400).json({ error: 'invalid_image' });
  }

  // Prefer a Xero chart of accounts (with descriptions); otherwise fall back to
  // a plain category list. Either way, always include an "Uncategorised" escape.
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

  // Organisation-level Review instructions (business overview + GST/coding
  // overrides). Prepended as context; may override the printed GST/tax and guide
  // the account choice + supplier identification.
  const rawInstructions = typeof req.body?.instructions === 'string' ? req.body.instructions.trim() : '';
  const instructions = rawInstructions.slice(0, 6000); // guard the prompt size
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

  const isPdf = mediaType === PDF_MEDIA;
  const fileBlock: Anthropic.ContentBlockParam = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: imageBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType as ImageMedia, data: imageBase64 } };

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: env.ANTHROPIC_EXTRACT_MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            fileBlock,
            {
              type: 'text',
              text:
                contextBlock +
                `Extract the purchase/expense details from this ${isPdf ? 'invoice/receipt PDF' : 'receipt or invoice image'}. ` +
                'Use the values printed on the document. Capture the invoice/receipt number exactly as printed when present. ' +
                `Today is ${new Date().toISOString().slice(0, 10)}. Dates are Singapore format DD/MM/YYYY (day first); a 2-digit year YY means 20YY (so "25/01/26" = 2026-01-25). Read the day and month exactly and output the date as ISO YYYY-MM-DD. ` +
                'Classify the expense into the single best-matching category from the allowed list provided in the schema; ' +
                'pick "Uncategorised" only when none reasonably fit. ' +
                'If a field is not present, use an empty string or 0. ' +
                'EXCEPTION: always write a non-empty `description` and `categoryReason` for every document — infer them from the merchant, visible items and document type even for a sparse card slip (never leave these two blank).' +
                accountsGuide,
            },
          ],
        },
      ],
      output_config: { format: { type: 'json_schema', schema: buildSchema(categories) } },
    });

    if (message.stop_reason === 'refusal') {
      return res.status(422).json({ error: 'refused' });
    }

    const textBlock = message.content.find((b) => b.type === 'text');
    const raw = textBlock && textBlock.type === 'text' ? textBlock.text : '';
    const parsed = ReceiptSchema.safeParse(raw ? JSON.parse(raw) : null);
    if (!parsed.success) {
      return res.status(502).json({ error: 'no_data' });
    }
    // Belt-and-suspenders: snap to a known category if the model somehow strays.
    const data = { ...parsed.data, category: categorySet.has(parsed.data.category) ? parsed.data.category : 'Uncategorised' };
    return res.json({ ok: true, data });
  } catch (err) {
    console.error('[extract] failed', err);
    return res.status(500).json({ error: 'extraction_failed' });
  }
});

// --- Vault document summariser ----------------------------------------------
// POST /api/vault/summarize — body: { imageBase64, mediaType }. Returns a short
// Subject line + a few-sentence Summary for a stored Vault document (Dext's
// document auto-fill). 503 until an ANTHROPIC_API_KEY is configured.
const SummarySchema = z.object({ subject: z.string(), summary: z.string() });

export const vaultRouter = Router();

vaultRouter.post('/summarize', async (req, res) => {
  if (!visionEnabled) return res.status(503).json({ error: 'vision_not_configured' });

  const imageBase64 = typeof req.body?.imageBase64 === 'string' ? req.body.imageBase64 : '';
  const mediaType = typeof req.body?.mediaType === 'string' ? req.body.mediaType : '';
  if (!imageBase64 || !ALLOWED_MEDIA.includes(mediaType)) {
    return res.status(400).json({ error: 'invalid_image' });
  }

  const isPdf = mediaType === PDF_MEDIA;
  const fileBlock: Anthropic.ContentBlockParam = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: imageBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType as ImageMedia, data: imageBase64 } };

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: env.ANTHROPIC_EXTRACT_MODEL,
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: [
            fileBlock,
            {
              type: 'text',
              text:
                'Summarise this document. Return a concise "subject" line (like an email subject, ' +
                'under 12 words) and a "summary" of 2–4 sentences describing what the document is, ' +
                'who it is from, and the key figures or purpose.',
            },
          ],
        },
      ],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              subject: { type: 'string', description: 'Short subject line' },
              summary: { type: 'string', description: '2–4 sentence summary' },
            },
            required: ['subject', 'summary'],
          },
        },
      },
    });

    if (message.stop_reason === 'refusal') return res.status(422).json({ error: 'refused' });
    const textBlock = message.content.find((b) => b.type === 'text');
    const raw = textBlock && textBlock.type === 'text' ? textBlock.text : '';
    const parsed = SummarySchema.safeParse(raw ? JSON.parse(raw) : null);
    if (!parsed.success) return res.status(502).json({ error: 'no_data' });
    return res.json({ ok: true, data: parsed.data });
  } catch (err) {
    console.error('[vault summarize] failed', err);
    return res.status(500).json({ error: 'summarize_failed' });
  }
});
