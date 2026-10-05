// The rail's CYWorkspace link is offered to whoever can sign in at the other
// end: the practice's own team, and a client's person who has an account there
// as well. Who has one is CYWorkspace's to say, so it is asked — and a client's
// person it does not know, or a CYWorkspace that cannot be reached, gets no
// link rather than a sign-in page they cannot pass.
//
// Driven over real HTTP at both ends: `/api/users/me` as the browser calls it,
// and a stub standing in for CYWorkspace, so what is asserted is the request
// that actually goes out.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-cywslink-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';
process.env.GOOGLE_CLIENT_ID = 'x';
process.env.GOOGLE_CLIENT_SECRET = 'x';
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4672';
process.env.CYWORKSPACE_API_KEY = 'the-shared-key';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'CYBM', tenantId: 't-1', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

// CYWorkspace: knows one address, and can be switched off.
const asked: { email: string; key: string }[] = [];
let up = true;
const cyws = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (!up || req.url !== '/api/webhooks/cybills/has-account') {
      res.writeHead(404).end('Not found');
      return;
    }
    const email = String(JSON.parse(raw || '{}').email || '');
    asked.push({ email, key: String(req.headers['x-api-key'] || '') });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ account: email === 'angela@yakson.example' }));
  });
}).listen(4672, '127.0.0.1');
await new Promise((r) => cyws.once('listening', r));

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const jwt = (await import('jsonwebtoken')).default;
const { usersRouter, ensure, save } = await import('../src/users.ts');
const { forgetCywsAccounts } = await import('../src/cywsAccount.ts');

const items = ensure('cybm');
const colleague = items.find((u) => u.email === 'astridy2004@gmail.com')!;
colleague.practice = true;
const client = (id: string, email: string) =>
  ({ ...colleague, id, name: id, email, practice: false, practiceRole: 'Standard', role: 'Business Admin', clientAccess: [], allClients: false }) as never;
items.unshift(client('angela', 'Angela@Yakson.example'), client('jii', 'jii@yakson.example'));
save(items);

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/users', usersRouter);
const server = app.listen(4671, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const me = async (email: string) => {
  const cookie = `cyb_session=${jwt.sign({ sub: email, email, name: email }, 'test-session-secret', { expiresIn: '1h' })}`;
  const res = await fetch('http://127.0.0.1:4671/api/users/me', { headers: { Cookie: cookie } });
  return (await res.json()) as any;
};

check('a client’s person with a CYWorkspace account is offered the link', (await me('angela@yakson.example')).cyworkspace, true);
check('…asked by address, lowercased, with the shared key', asked[0], { email: 'angela@yakson.example', key: 'the-shared-key' });
check('a client’s person without one is not', (await me('jii@yakson.example')).cyworkspace, false);
const before = asked.length;
check('a colleague is offered it', (await me('astridy2004@gmail.com')).cyworkspace, true);
check('…without CYWorkspace being asked', asked.length, before);
await me('angela@yakson.example');
check('an answer is remembered rather than asked on every page load', asked.length, before);

up = false;
forgetCywsAccounts();
const down = await me('angela@yakson.example');
check('a CYWorkspace that does not answer means no link', down.cyworkspace, false);
check('…and the rest of the membership still arrives', down.status, 'active');

server.close();
cyws.close();
finish(failures);
