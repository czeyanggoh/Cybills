// Two-step sign-in, from the browser's side.
//
// The secret is only ever seen once, while enrolling, and never afterwards:
// the server keeps it sealed and publicUser strips it, so there is no call
// here that reads it back. Same for the recovery codes — the enable response
// is the one moment they exist in readable form.

async function post(path, body) {
  const res = await fetch(`/api/users/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || 'failed');
    err.code = data?.error || '';
    throw err;
  }
  return data;
}

// Begin enrolling: a secret to put into an authenticator. Nothing about signing
// in changes until a code from it verifies.
export const startTotp = () => post('totp/start');

// Prove the app has it. Returns the recovery codes, once.
export const enableTotp = (code) => post('totp/enable', { code });

// Needs a current code (or a recovery code): a signed-in browser somebody
// walked away from must not be able to take the second factor off by itself.
export const disableTotp = (code) => post('totp/disable', { code });

// An admin putting somebody back where they started, for the phone that is
// genuinely gone. It clears; it never reveals.
export const resetTotpFor = (id) => post(`${id}/totp/reset`);
