// Signing in with a second factor, end to end.
//
// This stands in front of the password form, which is how ST Engineering's
// staff reach CYBills. Two things have to be true at once and they pull against
// each other: nobody gets in without the code, and nobody who has it gets
// locked out. So the refusals are tested as carefully as the successes — a
// challenge that expires, a code from the wrong secret, a recovery code used
// twice, and the session cookie being presented as the challenge it is meant to
// stand in front of.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-totp-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';
process.env.GOOGLE_CLIENT_ID = 'x';
process.env.GOOGLE_CLIENT_SECRET = 'x';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'CYBM', tenantId: 't-1', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const jwt = (await import('jsonwebtoken')).default;
const { usersRouter, ensure, save } = await import('../src/users.ts');
const { totpCode, openSecret, sealSecret, hashRecovery } = await import('../src/totp.ts');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/users', usersRouter);
const server = app.listen(4639, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const post = async (path: string, body: unknown, cookie?: string) => {
  const res = await fetch(`http://127.0.0.1:4639/api/users${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as any,
    setCookie: res.headers.get('set-cookie') ?? '',
  };
};

// Somebody who signs in with a password, which is the whole point of this.
const EMAIL = 'dean@st-eng.example';
{
  const items = ensure('cybm');
  const seed = items.find((u) => u.email === 'astridy2004@gmail.com')!;
  items.unshift({ ...seed, id: 'dean', name: 'Dean Tan', email: EMAIL, login: 'Yes', practice: false } as never);
  save(items);
}
// Set a password the way an admin does.
const sessionFor = (id: string, email: string) =>
  `cyb_session=${jwt.sign({ sub: id, email, name: email }, 'test-session-secret', { expiresIn: '1h' })}`;
const admin = sessionFor('astrid', 'astridy2004@gmail.com');
let r = await post('/dean/password', { password: 'correct-horse' }, admin);
check('an admin sets a password', r.status, 200);

// --- A password on its own is not a way in ------------------------------------
// Nobody signs in with a password alone now. Somebody who has one and no second
// factor is sent to set one up before any session exists — a requirement that
// let people through "just this once" would be a requirement in name only, and
// the accounts it exists for are the ones that never get round to it.
r = await post('/login', { email: EMAIL, password: 'correct-horse' });
check('the password alone does not sign them in', Boolean(r.body.user), false);
check('it sends them to set one up', r.body.totpSetupRequired, true);
check('and no session is set on the way', r.setCookie.includes('cyb_session='), false);

// Enrolling from the sign-in form itself, with the challenge standing in for
// the session they do not have yet.
const forced = r.body.challenge as string;
r = await post('/totp/start', { challenge: forced });
check('the challenge is enough to start enrolling', r.body.secret?.length, 32);
const forcedSecret = r.body.secret as string;
r = await post('/totp/enable', { challenge: forced, code: totpCode(forcedSecret) });
check('and to finish', r.status, 200);
// Both factors shown, so this is where the session begins — sending them back
// to type the password again would ask twice for what they just proved.
check('which signs them in', r.setCookie.includes('cyb_session='), true);
check('and says so', r.body.signedIn, true);

// Put it back to the no-second-factor state for the rest of the file.
{
  const items = ensure('cybm');
  const row = items.find((u) => u.id === 'dean')!;
  delete row.totpSecret;
  delete row.totpEnabledAt;
  delete row.totpRecovery;
  save(items);
}
const dean = sessionFor('dean', EMAIL);

// --- Enrolling ----------------------------------------------------------------
r = await post('/totp/start', {}, dean);
check('enrolling hands over a secret', r.body.secret?.length, 32);
check('and the line an authenticator reads', r.body.uri?.startsWith('otpauth://totp/CYBills:'), true);
const secret = r.body.secret as string;

// Until a code proves it, nothing about signing in has changed. A half-finished
// enrolment must never be able to lock somebody out.
r = await post('/login', { email: EMAIL, password: 'correct-horse' });
check('a pending secret does not count as a second factor', r.body.totpSetupRequired, true);
check('and still mints no session', r.setCookie.includes('cyb_session='), false);

r = await post('/totp/enable', { code: '000000' }, dean);
check('a wrong code does not turn it on', r.status, 401);

r = await post('/totp/enable', { code: totpCode(secret) }, dean);
check('the right code does', r.status, 200);
const recovery = r.body.recoveryCodes as string[];
check('and hands over the recovery codes, once', recovery.length, 10);

// --- Signing in with it -------------------------------------------------------
r = await post('/login', { email: EMAIL, password: 'correct-horse' });
check('the password alone still does not sign them in', Boolean(r.body.user), false);
check('but now it asks for the code rather than for setup', r.body.totpRequired, true);
check('and sets no session on the way', r.setCookie.includes('cyb_session='), false);
const challenge = r.body.challenge as string;

r = await post('/login/totp', { challenge, code: '000000' });
check('a wrong code is refused', r.status, 401);
r = await post('/login/totp', { challenge, code: totpCode(secret) });
check('the right one signs them in', Boolean(r.body.user), true);
check('now a session comes back', r.setCookie.includes('cyb_session='), true);
// The secret never leaves the server.
check('and the secret is not in the reply', JSON.stringify(r.body).includes(secret), false);
check('nor is anything else that could mint a code', 'totpSecret' in r.body.user, false);
check('but whether it is on is said', r.body.user.totpEnabled, true);

// A session cookie is not a challenge. Without the `kind` check it would verify
// here and skip the very step it is meant to stand behind.
r = await post('/login/totp', { challenge: jwt.sign({ sub: 'dean', email: EMAIL }, 'test-session-secret'), code: totpCode(secret) });
check('a session token is not accepted as a challenge', r.status, 401);

// An expired challenge is not a way in either.
r = await post('/login/totp', {
  challenge: jwt.sign({ sub: 'dean', kind: 'totp' }, 'test-session-secret', { expiresIn: -10 }),
  code: totpCode(secret),
});
check('an expired challenge is refused', r.body.error, 'challenge_expired');

// --- Trusting a browser -------------------------------------------------------
// Asked once, then not again on this machine. Without it a second factor on a
// daily tool is a tax, and the way people pay a tax like that is by choosing a
// worse password.
{
  r = await post('/login', { email: EMAIL, password: 'correct-horse' });
  const res = await fetch('http://127.0.0.1:4639/api/users/login/totp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge: r.body.challenge, code: totpCode(secret), trust: true }),
  });
  const cookies = res.headers.get('set-cookie') ?? '';
  check('asking to be trusted sets a second cookie', cookies.includes('cyb_trust='), true);
  const trust = /cyb_trust=[^;]+/.exec(cookies)?.[0] ?? '';

  // The password alone is enough on THIS browser now, and only this one.
  const again = await fetch('http://127.0.0.1:4639/api/users/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: trust },
    body: JSON.stringify({ email: EMAIL, password: 'correct-horse' }),
  });
  const body = (await again.json()) as any;
  check('a trusted browser is not asked for a code', Boolean(body.user), true);
  check('and says that is why', body.trusted, true);

  // It names one person, so it cannot be carried to somebody else's sign-in.
  const other = await fetch('http://127.0.0.1:4639/api/users/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: trust },
    body: JSON.stringify({ email: 'astridy2004@gmail.com', password: 'nope' }),
  });
  check("another person's sign-in is unaffected by it", other.status, 401);

  // A reset retires every browser trusted under the old enrolment — which is
  // what you want on the day the laptop is the thing that went missing.
  await post('/dean/totp/reset', {}, admin);
  r = await post('/login', { email: EMAIL, password: 'correct-horse' });
  const enrol = r.body.challenge as string;
  const started = await post('/totp/start', { challenge: enrol });
  await post('/totp/enable', { challenge: enrol, code: totpCode(started.body.secret) });
  const stale = await fetch('http://127.0.0.1:4639/api/users/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: trust },
    body: JSON.stringify({ email: EMAIL, password: 'correct-horse' }),
  });
  const staleBody = (await stale.json()) as any;
  check('a reset retires the browsers trusted before it', staleBody.totpRequired, true);

  // Back to the original secret for the rest of the file.
  const items = ensure('cybm');
  const row = items.find((u) => u.id === 'dean')!;
  row.totpSecret = sealSecret(secret);
  row.totpRecovery = recovery.map(hashRecovery);
  save(items);
}

// --- The phone in the drawer --------------------------------------------------
r = await post('/login', { email: EMAIL, password: 'correct-horse' });
r = await post('/login/totp', { challenge: r.body.challenge, code: recovery[0]! });
check('a recovery code gets them in', Boolean(r.body.user), true);
check('and says one was spent', r.body.usedRecoveryCode, true);
check('with nine left', r.body.recoveryCodesLeft, 9);

r = await post('/login', { email: EMAIL, password: 'correct-horse' });
r = await post('/login/totp', { challenge: r.body.challenge, code: recovery[0]! });
check('the same recovery code cannot be used twice', r.status, 401);

// --- Turning it off -----------------------------------------------------------
r = await post('/totp/disable', { code: '000000' }, dean);
check('a walked-away-from session cannot turn it off on its own', r.status, 401);
r = await post('/totp/disable', { code: totpCode(secret) }, dean);
check('a current code can', r.status, 200);
r = await post('/login', { email: EMAIL, password: 'correct-horse' });
check('and they are asked to set one up again', r.body.totpSetupRequired, true);

// --- The phone that is genuinely gone -----------------------------------------
r = await post('/totp/start', {}, dean);
const second = r.body.secret as string;
await post('/totp/enable', { code: totpCode(second) }, dean);
r = await post('/login', { email: EMAIL, password: 'correct-horse' });
check('it is on again', r.body.totpRequired, true);

r = await post('/dean/totp/reset', {}, admin);
check('an admin can put them back where they started', r.status, 200);
r = await post('/login', { email: EMAIL, password: 'correct-horse' });
check('so they are asked to set one up again', r.body.totpSetupRequired, true);
// A reset clears it rather than revealing it: there is nothing an admin can
// read that would let them sign in as that person later.
check('and nothing of the secret is left', openSecret(ensure('cybm').find((u) => u.id === 'dean')!.totpSecret ?? ''), '');

server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
