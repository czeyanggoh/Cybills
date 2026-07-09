import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env, visionEnabled } from './env.js';

// JSON schema handed to Claude via output_config.format so the model returns
// strictly-shaped JSON (structured outputs). additionalProperties:false +
// required on every object is mandatory for strict structured outputs.
const receiptJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    supplier: { type: 'string', description: 'Merchant / supplier name, e.g. "Grab"' },
    date: { type: 'string', description: 'Document date, ISO YYYY-MM-DD when determinable' },
    documentType: { type: 'string', enum: ['Receipt', 'Invoice', 'Other'] },
    currency: { type: 'string', description: '3-letter ISO currency code, e.g. SGD' },
    total: { type: 'number', description: 'Grand total amount' },
    tax: { type: 'number', description: 'Tax / GST amount; 0 if none shown' },
    category: { type: 'string', description: 'Best-guess expense category, e.g. "Transport - Taxi"' },
    lineItems: {
      type: 'array',
      description: 'Individual line items if present; empty array if none',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string' },
          amount: { type: 'number' },
        },
        required: ['description', 'amount'],
      },
    },
  },
  required: ['supplier', 'date', 'documentType', 'currency', 'total', 'tax', 'category', 'lineItems'],
} as const;

// Validates the model's JSON before we trust it.
const ReceiptSchema = z.object({
  supplier: z.string(),
  date: z.string(),
  documentType: z.enum(['Receipt', 'Invoice', 'Other']),
  currency: z.string(),
  total: z.number(),
  tax: z.number(),
  category: z.string(),
  lineItems: z.array(z.object({ description: z.string(), amount: z.number() })),
});

const ALLOWED_MEDIA = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
type MediaType = (typeof ALLOWED_MEDIA)[number];

export const extractRouter = Router();

// POST /api/costs/extract — body: { imageBase64, mediaType }. Runs the image
// through Claude vision and returns the extracted fields. 503 until an
// ANTHROPIC_API_KEY is configured.
extractRouter.post('/extract', async (req, res) => {
  if (!visionEnabled) return res.status(503).json({ error: 'vision_not_configured' });

  const imageBase64 = typeof req.body?.imageBase64 === 'string' ? req.body.imageBase64 : '';
  const mediaType = typeof req.body?.mediaType === 'string' ? req.body.mediaType : '';
  if (!imageBase64 || !ALLOWED_MEDIA.includes(mediaType as MediaType)) {
    return res.status(400).json({ error: 'invalid_image' });
  }

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType as MediaType, data: imageBase64 },
            },
            {
              type: 'text',
              text:
                'Extract the purchase/expense details from this receipt or invoice image. ' +
                'Use the values printed on the document; infer a sensible expense category. ' +
                'If a field is not present, use an empty string or 0.',
            },
          ],
        },
      ],
      output_config: { format: { type: 'json_schema', schema: receiptJsonSchema } },
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
    return res.json({ ok: true, data: parsed.data });
  } catch (err) {
    console.error('[extract] failed', err);
    return res.status(500).json({ error: 'extraction_failed' });
  }
});
