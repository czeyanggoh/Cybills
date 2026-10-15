import type { Request } from 'express';

// A clock has no request, and the read it starts wants one: the entity to
// attribute the model call to (recordUsage reads X-Org-Id) and an origin for a
// link back (appOrigin, which prefers APP_ORIGIN and so never needs the host).
// This is that much of a request and no more — no session, no cookies, nothing
// anybody could mistake for a person. Used by
// the two things that read documents on a clock: the Drive folder poller and
// the scheduled portal retrieval.
export function robotRequest(orgId: string, path: string): Request {
  const headers: Record<string, string> = { 'x-org-id': orgId };
  const header = (name: string) => headers[String(name).toLowerCase()];
  return {
    headers,
    header,
    get: header,
    cookies: {},
    query: {},
    params: {},
    body: {},
    path,
    protocol: 'https',
  } as unknown as Request;
}
