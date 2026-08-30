import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
  env,
  claudeEnabled,
  openaiEnabled,
  defaultReaderProvider,
  readerProviders,
} from './env.js';

// One document reader, two engines. Both extraction endpoints hand a file, a
// prompt and a JSON schema to `readDocument` and get back parsed JSON plus the
// tokens it cost — so the callers never branch on provider, and a document read
// by Claude and the same document read by OpenAI come back in the same shape.
//
// The org picks its engine in Business settings -> Extraction; the request
// carries that choice and `resolveProvider` has the last word, because a
// provider whose key isn't configured must never be attempted.

export type Provider = 'claude' | 'openai';

// Token counts, normalised across providers. Anthropic bills cache writes at
// 1.25x input and cache reads at 0.1x; OpenAI charges nothing to write a cache
// entry and 0.1x to read one, so its cacheWriteTokens are always 0.
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

export type ReadOutcome =
  | { ok: true; provider: Provider; model: string; json: unknown; usage: TokenUsage }
  | { ok: false; provider: Provider; model: string; reason: 'refused' | 'no_data'; usage: TokenUsage };

export type ReadRequest = {
  fileBase64: string;
  mediaType: string;
  // Everything identical for every document in this organisation — the reading
  // instructions and the account / tax-code / project guides. Sent as a system
  // prefix so both providers can cache it: Anthropic needs an explicit
  // breakpoint, OpenAI caches a long prefix on its own. Nothing per-document
  // may go here or the cache is invalidated (see extract.ts).
  systemPrompt: string;
  // The per-document line: today's date, and whether this is a PDF or an image.
  prompt: string;
  schema: Record<string, unknown>;
  // Identifies the schema to OpenAI's structured outputs. Letters, digits,
  // underscores and dashes only.
  schemaName: string;
  maxTokens: number;
  provider: Provider;
};

const PDF_MEDIA = 'application/pdf';

// Anthropic caches a prefix only past a minimum length (~1024 tokens); asking
// below that just adds a no-op breakpoint. ~3.6 chars/token is a deliberate
// under-estimate, so a borderline prompt still gets the breakpoint. OpenAI needs
// no equivalent — it caches long prefixes automatically.
const cacheable = (text: string) => text.length >= 4000;

// Anthropic's `effort` is rejected outright by some models rather than ignored,
// and the extract model is an env var — so name the ones that take it.
const EFFORT_MODELS = [
  'claude-fable-5', 'claude-mythos-5',
  'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5',
  'claude-sonnet-5', 'claude-sonnet-4-6',
];
const supportsEffort = (model: string) => EFFORT_MODELS.includes(String(model || '').trim());
const noUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
});

// Which engine reads this document. An explicit ask wins when that engine has a
// key; anything else — an unknown name, a provider that was configured
// yesterday and isn't today — falls back to the deploy's default rather than
// failing, because a stale saved preference shouldn't stop a receipt being read.
export function resolveProvider(requested: unknown): Provider {
  const want = String(requested ?? '').trim().toLowerCase();
  const asked: Provider | '' =
    want === 'openai' ? 'openai' : want === 'claude' || want === 'anthropic' ? 'claude' : '';
  if (asked === 'openai' && openaiEnabled) return 'openai';
  if (asked === 'claude' && claudeEnabled) return 'claude';
  return defaultReaderProvider;
}

export function providerLabel(p: Provider): string {
  return p === 'openai' ? 'OpenAI' : 'Claude';
}

// The model each engine reads with, so callers can name it without knowing
// which env var holds it.
export function modelFor(provider: Provider): string {
  return provider === 'openai' ? env.OPENAI_EXTRACT_MODEL : env.ANTHROPIC_EXTRACT_MODEL;
}

// OpenAI's structured outputs are stricter than Anthropic's: in strict mode
// EVERY property of EVERY object must be listed in `required`, and every object
// must set additionalProperties:false. Our schemas mark a few line-item fields
// optional, which Anthropic accepts and OpenAI rejects, so this tightens a copy
// on the way out. Nothing is lost — the Zod parse still defaults them, so a
// model that fills `net: 0` lands exactly where an omitted `net` used to.
function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = strictify(v);
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as Record<string, unknown>);
  }
  return out;
}

// Reasoning models take a `reasoning` block and would reject it otherwise, so
// it's sent only to the families that have one. The GPT-5.6 ids (gpt-5.6-luna,
// -terra, -sol) match this too, which is what they want.
const isReasoningModel = (model: string) => /^(gpt-5|o\d)/i.test(model.trim());

// The union across the families we can be pointed at: GPT-5.6 takes
// none/low/medium/high/xhigh/max, GPT-5 and the o-series take
// minimal/low/medium/high. This gate only stops a typo reaching the API — the
// model itself rejects an effort its own family doesn't have, which is a
// clearer error than silently dropping the setting.
const REASONING_EFFORTS = new Set([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]);

async function readWithClaude(req: ReadRequest): Promise<ReadOutcome> {
  const model = env.ANTHROPIC_EXTRACT_MODEL;
  const isPdf = req.mediaType === PDF_MEDIA;
  const fileBlock: Anthropic.ContentBlockParam = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: req.fileBase64 } }
    : {
        type: 'image',
        source: {
          type: 'base64',
          media_type: req.mediaType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
          data: req.fileBase64,
        },
      };

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model,
    max_tokens: req.maxTokens,
    // A cache breakpoint only pays off past the API's minimum cacheable prefix
    // (~1024 tokens); below that it silently doesn't cache, so don't ask.
    system: [
      cacheable(req.systemPrompt)
        ? { type: 'text' as const, text: req.systemPrompt, cache_control: { type: 'ephemeral' as const } }
        : { type: 'text' as const, text: req.systemPrompt },
    ],
    messages: [{ role: 'user', content: [fileBlock, { type: 'text', text: req.prompt }] }],
    output_config: {
      format: { type: 'json_schema', schema: req.schema },
      // Reading a fixed set of fields off an invoice is not work that wants deep
      // reasoning, and thinking tokens bill as output. Omitted on models that
      // reject the parameter outright (Haiku 4.5, Sonnet 4.5).
      ...(supportsEffort(model) ? { effort: 'low' as const } : {}),
    },
  });

  const u = message.usage as unknown as Record<string, unknown>;
  const usage: TokenUsage = {
    inputTokens: num(u?.input_tokens),
    outputTokens: num(u?.output_tokens),
    cacheWriteTokens: num(u?.cache_creation_input_tokens),
    cacheReadTokens: num(u?.cache_read_input_tokens),
  };

  if (message.stop_reason === 'refusal') {
    return { ok: false, provider: 'claude', model, reason: 'refused', usage };
  }
  const textBlock = message.content.find((b) => b.type === 'text');
  const raw = textBlock && textBlock.type === 'text' ? textBlock.text : '';
  const json = parseJson(raw);
  if (json === undefined) return { ok: false, provider: 'claude', model, reason: 'no_data', usage };
  return { ok: true, provider: 'claude', model, json, usage };
}

async function readWithOpenAI(req: ReadRequest): Promise<ReadOutcome> {
  const model = env.OPENAI_EXTRACT_MODEL;
  const isPdf = req.mediaType === PDF_MEDIA;
  // The Responses API takes both images and PDFs as data URLs; a PDF also needs
  // a filename, which is how the API recognises it as a document to page
  // through rather than an opaque blob.
  const fileBlock: OpenAI.Responses.ResponseInputContent = isPdf
    ? {
        type: 'input_file',
        filename: 'document.pdf',
        file_data: `data:application/pdf;base64,${req.fileBase64}`,
      }
    : {
        type: 'input_image',
        image_url: `data:${req.mediaType};base64,${req.fileBase64}`,
        detail: 'auto',
      };

  const client = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
  });

  const effort = env.OPENAI_REASONING_EFFORT.trim().toLowerCase();
  const response = await client.responses.create({
    model,
    // A reasoning model spends part of this budget thinking before it writes a
    // token of the answer, so the cap has to clear the schema AND the thinking.
    // Doubling the caller's budget is what stops a long invoice coming back
    // `incomplete` with nothing parseable in it.
    max_output_tokens: isReasoningModel(model) ? req.maxTokens * 4 : req.maxTokens,
    ...(isReasoningModel(model) && REASONING_EFFORTS.has(effort)
      ? { reasoning: { effort: effort as 'minimal' | 'low' | 'medium' | 'high' | 'none' | 'xhigh' | 'max' } }
      : {}),
    // The stable per-org block goes in `instructions`, which sits ahead of the
    // input — so OpenAI's automatic prefix caching covers it, the same tokens
    // the Anthropic path caches with an explicit breakpoint. Cached input bills
    // at 0.1x and is reported back as input_tokens_details.cached_tokens.
    instructions: req.systemPrompt,
    input: [
      {
        role: 'user',
        content: [fileBlock, { type: 'input_text', text: req.prompt }],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: req.schemaName,
        strict: true,
        schema: strictify(req.schema) as Record<string, unknown>,
      },
    },
  });

  const u = response.usage as unknown as Record<string, unknown> | undefined;
  const details = (u?.input_tokens_details ?? {}) as Record<string, unknown>;
  const cacheReadTokens = num(details.cached_tokens);
  const usage: TokenUsage = {
    // OpenAI counts cached tokens inside input_tokens; the pricing here bills
    // the two buckets separately, so take the cached ones back out first or
    // they'd be charged at the full input rate as well as the 0.1x one.
    inputTokens: Math.max(0, num(u?.input_tokens) - cacheReadTokens),
    outputTokens: num(u?.output_tokens),
    cacheWriteTokens: 0, // OpenAI doesn't bill for writing a cache entry
    cacheReadTokens,
  };

  // A refusal arrives as its own content part rather than a stop reason.
  const refused = response.output?.some(
    (item) =>
      item.type === 'message' &&
      item.content?.some((part) => part.type === 'refusal')
  );
  if (refused) return { ok: false, provider: 'openai', model, reason: 'refused', usage };

  const json = parseJson(response.output_text ?? '');
  if (json === undefined) {
    if (response.status === 'incomplete') {
      console.error('[llm] openai response incomplete', response.incomplete_details);
    }
    return { ok: false, provider: 'openai', model, reason: 'no_data', usage };
  }
  return { ok: true, provider: 'openai', model, json, usage };
}

// Read one document with the chosen engine. Throws only on a transport/API
// failure; a model that declines or answers unparseably comes back as
// `ok:false` so the caller can still record what the attempt cost.
export function readDocument(req: ReadRequest): Promise<ReadOutcome> {
  return req.provider === 'openai' ? readWithOpenAI(req) : readWithClaude(req);
}

// The readers this deploy can offer, for the capability probe.
export const availableProviders = readerProviders;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

// `undefined` means "nothing usable", which is distinct from a model that
// legitimately answered `null`.
function parseJson(raw: string): unknown {
  const text = String(raw || '').trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
