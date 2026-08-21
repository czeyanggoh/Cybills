import { useAuth } from '@/lib/auth';
import { getExtractionSettings, useExtractionSettings } from '@/lib/extractionSettings';

// Which engine reads this client entity's documents — Claude or OpenAI — and
// what to call it on screen.
//
// Two things decide it, and they answer different questions:
//   * the SERVER says which readers have an API key (`readerProviders` on the
//     auth status probe). A provider with no key is never offered.
//   * the ORG says which of those it wants (Business settings -> Extraction ->
//     Document reader, saved per client entity). Blank means "whatever the
//     server defaults to", which is how every existing workspace behaves until
//     someone touches the setting.
//
// The server re-checks the choice on every call (see resolveProvider in
// server/src/llm.ts), so a saved preference for a provider whose key was later
// removed degrades to the working one instead of failing the read.

export const READER_PROVIDERS = [
  { id: 'claude', label: 'Claude', hint: 'Anthropic' },
  { id: 'openai', label: 'OpenAI', hint: 'GPT' },
];

export const SERVER_DEFAULT = ''; // the "let the server decide" option value

export function readerLabel(id) {
  return READER_PROVIDERS.find((p) => p.id === id)?.label || 'Claude';
}

// The provider actually used, given the org's preference and what the server
// can offer. Falls back to the server default when the saved choice has no key.
export function effectiveProvider(preferred, available, serverDefault = 'claude') {
  const list = Array.isArray(available) ? available : [];
  const want = String(preferred || '').trim();
  if (want && list.includes(want)) return want;
  if (list.includes(serverDefault)) return serverDefault;
  return list[0] || serverDefault;
}

// The provider id to send on an extract/summarise request. Plain function (not
// a hook) because the upload paths call it from async code, not from render.
// '' when the org hasn't chosen — the server then applies its own default.
export function requestedProvider() {
  return getExtractionSettings().readerProvider || '';
}

// The name to put in front of the user — "Re-read with Claude", "auto-fill with
// OpenAI". Follows the toggle, so the button never promises the wrong engine.
export function useReaderName() {
  const { readerProviders, defaultReaderProvider } = useAuth();
  const { readerProvider } = useExtractionSettings();
  return readerLabel(effectiveProvider(readerProvider, readerProviders, defaultReaderProvider));
}
