// End-to-end test of POST /api/costs/extract-lines against a stubbed OpenAI
// Responses endpoint, so the reconciliation + retry path is exercised for real.
import http from 'node:http';

process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_EXTRACT_MODEL = 'gpt-4o-stub'; // non-reasoning: no 4x budget, no `reasoning` block
process.env.LLM_PROVIDER = 'openai';
process.env.ANTHROPIC_API_KEY = '';

// --- stub reader -------------------------------------------------------------
let answers: unknown[] = [];
let calls: Array<{ instructions: string; prompt: string; maxOutputTokens: number; schemaName: string }> = [];

const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const text = parsed.input?.[0]?.content?.find((c: any) => c.type === 'input_text')?.text ?? '';
    calls.push({
      instructions: parsed.instructions ?? '',
      prompt: text,
      maxOutputTokens: parsed.max_output_tokens,
      schemaName: parsed.text?.format?.name ?? '',
    });
    const answer = answers[calls.length - 1] ?? answers[answers.length - 1];
    const out = JSON.stringify(answer);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        model: 'gpt-4o-stub',
        output_text: out,
        output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: out, annotations: [] }] }],
        usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 0 } },
      })
    );
  });
});
await new Promise<void>((r) => stub.listen(4599, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4599';

// Imported AFTER the env is set — env.ts snapshots process.env at import.
const express = (await import('express')).default;
const { extractRouter } = await import('../src/extract.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/costs', extractRouter);
const server = app.listen(4600, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const call = async () => {
  const res = await fetch('http://127.0.0.1:4600/api/costs/extract-lines', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageBase64: PNG,
      mediaType: 'image/png',
      accounts: [
        { code: '315', name: 'Outlet Laundry', description: 'Laundry services for outlets' },
        { code: '313A', name: 'Outlet Rental', description: 'Outlet rent' },
      ],
      projects: [
        { name: 'Tangs', rules: 'Tangs Plaza outlet' },
        { name: 'Vivo City', rules: '' },
        { name: 'Four Seasons', rules: '' },
      ],
    }),
  });
  return { status: res.status, body: await res.json() };
};

const line = (description: string, amount: number, category = '315 - Outlet Laundry') => ({
  description, category, quantity: 1, unitAmount: amount, net: amount, tax: 0, amount,
});
const answer = (o: Record<string, unknown>) => ({ grandTotal: 0, subTotal: 0, taxTotal: 0, currency: 'SGD', note: '', lines: [], ...o });

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// 1) The lines add up first time — no retry, trusted.
calls = [];
answers = [{ grandTotal: 705, currency: 'SGD', note: '', lines: [line('Towel service', 315), line('Linen bags', 240), line('Daily towels', 150)] }];
let r = await call();
check('clean read: reconciled', r.body.data.reconciled, true);
check('clean read: one reader call', calls.length, 1);
check('clean read: attempts', r.body.data.attempts, 1);
check('clean read: lines total', r.body.data.linesTotal, 705);
check('clean read: dedicated schema', calls[0].schemaName, 'document_line_items');
check('clean read: budget raised past /extract 1024', calls[0].maxOutputTokens, 4096);
check('clean read: summary rows named in the cached prefix', calls[0].instructions.includes('Balance brought forward'), true);
check('clean read: nothing per-document in the cached prefix', /\d+\.\d\d/.test(calls[0].instructions), false);

// 2) A phantom summary row the first time — the retry fixes it and is kept.
calls = [];
answers = [
  { grandTotal: 705, currency: 'SGD', note: '', lines: [line('Towel service', 315), line('Linen bags', 240), line('Daily towels', 150), line('', 3045)] },
  { grandTotal: 705, currency: 'SGD', note: '', lines: [line('Towel service', 315), line('Linen bags', 240), line('Daily towels', 150)] },
];
r = await call();
check('bad read: retried once', calls.length, 2);
check('bad read: attempts reported', r.body.data.attempts, 2);
check('bad read: corrected set kept', r.body.data.lines.length, 3);
check('bad read: reconciled after retry', r.body.data.reconciled, true);
check('bad read: retry was told the arithmetic', calls[1].prompt.includes('3750.00') && calls[1].prompt.includes('705.00'), true);
check('bad read: retry did not disturb the cached prefix', calls[1].instructions, calls[0].instructions);

// 3) The retry comes back worse — keep the first answer, and say it is unreconciled.
calls = [];
answers = [
  { grandTotal: 705, currency: 'SGD', note: '', lines: [line('Towel service', 315), line('Linen bags', 240), line('Daily towels', 150), line('Rounding', 10)] },
  { grandTotal: 705, currency: 'SGD', note: '', lines: [line('Towel service', 315), line('Linen bags', 9999)] },
];
r = await call();
check('worse retry: first answer kept', r.body.data.linesTotal, 715);
check('worse retry: flagged unreconciled', r.body.data.reconciled, false);

// 4) Filler descriptions blanked; unknown categories snapped to Uncategorised.
calls = [];
answers = [{ grandTotal: 100, currency: 'SGD', note: 'n/a', lines: [{ ...line('N/A', 100), category: '999 - Not in this chart' }] }];
r = await call();
check('filler description blanked', r.body.data.lines[0].description, '');
check('unknown category snapped', r.body.data.lines[0].category, 'Uncategorised');
check('filler note blanked', r.body.data.note, '');

// 5) No itemised table at all.
calls = [];
answers = [{ grandTotal: 1139.05, currency: 'SGD', note: '', lines: [] }];
r = await call();
check('no table: no lines', r.body.data.lines.length, 0);
check('no table: not claimed as reconciled', r.body.data.reconciled, false);
check('no table: no pointless retry', calls.length, 1);

// 6) Cents, not floats: 0.1 + 0.2 must reconcile against 0.30.
calls = [];
answers = [{ grandTotal: 0.3, currency: 'SGD', note: '', lines: [line('A', 0.1), line('B', 0.2)] }];
r = await call();
check('float-safe reconciliation', r.body.data.reconciled, true);
check('float-safe: no retry', calls.length, 1);

// 7) The Xtreme Laundry invoice: rows printed NET, one "GST 9% 94.05" at the
//    foot. The rows add up to the SUBTOTAL, which is correct — the stated GST is
//    shared across them here rather than dumped on the last row.
calls = [];
answers = [answer({
  grandTotal: 1139.05,
  subTotal: 1045,
  taxTotal: 94.05,
  lines: [
    line('Alternate Service - Every Mon & Thurs (Tangs)', 270),
    line('Chemical wash (Oxi Bleach & Rinse)', 45),
    ...Array.from({ length: 8 }, (_, i) => line(`0${i + 1}/06/26: 1 bag extra`, 30)),
    line('Alternate Service - Every Thu (Vivo City)', 150),
    line('Chemical wash (Oxi Bleach & Rinse)', 25),
    line('Alternate Service - Every Tues & Thurs (Four Seasons)', 270),
    line('Chemical wash (Oxi Bleach & Rinse)', 45),
  ],
})];
r = await call();
check('net rows + GST at the foot: reconciled', r.body.data.reconciled, true);
check('net rows + GST at the foot: no retry needed', calls.length, 1);
check('GST shared out, not dumped on one row', r.body.data.lines.map((l: any) => l.tax).slice(0, 3), [24.3, 4.05, 2.7]);
check('every row taxed', r.body.data.lines.every((l: any) => l.tax > 0), true);
check('the shares sum to the stated GST', Math.round(r.body.data.lines.reduce((t: number, l: any) => t + l.tax * 100, 0)) / 100, 94.05);
check('the rows now sum to the grand total', r.body.data.linesTotal, 1139.05);
check('nets are untouched', r.body.data.lines.map((l: any) => l.net).slice(0, 3), [270, 45, 30]);

// 8) Rows printed GROSS with the tax stated once: the GST comes out of them.
calls = [];
answers = [answer({ grandTotal: 109, subTotal: 100, taxTotal: 9, lines: [line('A', 65.4), line('B', 43.6)] })];
r = await call();
check('gross rows: reconciled', r.body.data.reconciled, true);
check('gross rows: tax pulled out', r.body.data.lines.map((l: any) => l.tax), [5.4, 3.6]);
check('gross rows: nets net off', r.body.data.lines.map((l: any) => l.net), [60, 40]);

// 9) A document that breaks tax down per row is left exactly as printed.
calls = [];
answers = [answer({
  grandTotal: 218, subTotal: 200, taxTotal: 18,
  lines: [{ ...line('A', 109), net: 100, tax: 9 }, { ...line('B', 109), net: 100, tax: 9 }],
})];
r = await call();
check('per-row tax kept as printed', r.body.data.lines.map((l: any) => [l.net, l.tax]), [[100, 9], [100, 9]]);
check('per-row tax: reconciled', r.body.data.reconciled, true);

// 10) An odd GST that doesn't divide cleanly still sums to the printed figure.
calls = [];
answers = [answer({ grandTotal: 109.01, subTotal: 100.01, taxTotal: 9, lines: [line('A', 33.34), line('B', 33.34), line('C', 33.33)] })];
r = await call();
check('indivisible GST sums to the printed figure', Math.round(r.body.data.lines.reduce((t: number, l: any) => t + l.tax * 100, 0)) / 100, 9);
check('indivisible GST: rows reach the grand total', r.body.data.linesTotal, 109.01);

// 11) Per-line projects: the reader is given the org's tracking options and its
//     answer is kept per row, so one invoice can bill three outlets.
calls = [];
answers = [answer({
  grandTotal: 545, subTotal: 500, taxTotal: 45,
  lines: [
    { ...line('Alternate Service (Tangs Plaza #04-04)', 270), project: 'Tangs' },
    { ...line('Additional bag 01/06/26', 30), project: 'Tangs' },
    { ...line('Alternate Service (Vivo City #01-06/07)', 150), project: 'Vivo City' },
    { ...line('Chemical wash', 25), project: 'Vivo City' },
    { ...line('Sundry', 25), project: '' },
  ],
})];
r = await call();
check('per-line projects kept', r.body.data.lines.map((l: any) => l.project), ['Tangs', 'Tangs', 'Vivo City', 'Vivo City', '']);
check('the options are offered to the reader', calls[0].instructions.includes('PER-LINE PROJECT'), true);
check('a section heading governs the rows under it', calls[0].instructions.includes('until the next heading'), true);

// 12) A project the org doesn't have is no project — the line follows the
//     document rather than carrying something Xero would reject.
calls = [];
answers = [answer({ grandTotal: 100, lines: [{ ...line('A', 100), project: 'Somewhere else' }] })];
r = await call();
check('unknown project dropped', r.body.data.lines[0].project, '');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
server.close();
stub.close();
process.exit(failures ? 1 : 0);
