import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

const allowed = [
  /^briefing(?:\/[a-f\d-]{36})?$/, /^runs(?:\/[a-f\d-]{36}\/(?:trace|rollback))?$/,
  /^approvals(?:\/approval_[a-f\d]{24}_v\d+)?$/, /^calendar(?:\.ics)?$/, /^bills(?:\.csv)?$/,
  /^policy(?:\/preview)?$/, /^schedule$/, /^events$/, /^kill-switch$/,
];

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const incomingOrigin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (request.headers.get('sec-fetch-site') === 'cross-site' ||
    (incomingOrigin && URL.canParse(incomingOrigin) && new URL(incomingOrigin).host !== host)) {
    return Response.json({ error: 'CROSS_ORIGIN_REQUEST' }, { status: 403 });
  }
  const endpoint = (await context.params).path.join('/');
  if (!allowed.some((pattern) => pattern.test(endpoint))) {
    return Response.json({ error: 'UNKNOWN_INBOX_ENDPOINT' }, { status: 404 });
  }
  const origin = process.env.CLAM_INBOX_API_ORIGIN || 'http://127.0.0.1:4000';
  const headers: Record<string, string> = {};
  if (process.env.CLAM_OPERATOR_TOKEN) headers['X-Clam-Operator-Token'] = process.env.CLAM_OPERATOR_TOKEN;
  if (request.headers.has('last-event-id')) headers['Last-Event-ID'] = request.headers.get('last-event-id')!;
  const body = request.method === 'GET' ? undefined : await request.text();
  if (body) headers['Content-Type'] = 'application/json';
  try {
    const upstream = await fetch(origin.replace(/\/$/, '') + '/api/inbox/' + endpoint, {
      method: request.method, body, headers, cache: 'no-store', signal: request.signal,
    });
    const resultHeaders = new Headers();
    for (const name of ['Content-Type', 'Content-Disposition', 'Cache-Control', 'X-Accel-Buffering']) {
      const value = upstream.headers.get(name);
      if (value) resultHeaders.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: resultHeaders });
  } catch {
    return Response.json({ error: 'INBOX_BACKEND_UNAVAILABLE' }, { status: 502 });
  }
}

export { proxy as GET, proxy as POST, proxy as PUT };
