import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

const allowed = {
  GET: /^(?:session|google\/(?:login|start|connect|callback))$/,
  POST: /^(?:inbox|logout|google\/(?:disconnect|token)\/[a-f\d-]{36}|google\/token\/sandbox)$/,
};

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const host = request.headers.get('host');
  const origin = request.headers.get('origin');
  if ((origin && (!URL.canParse(origin) || new URL(origin).host !== host)) ||
      (request.method === 'POST' && request.headers.get('sec-fetch-site') === 'cross-site')) {
    return Response.json({ error: 'CROSS_ORIGIN_REQUEST' }, { status: 403 });
  }
  const endpoint = (await context.params).path.join('/');
  const matcher = allowed[request.method as keyof typeof allowed];
  if (!matcher?.test(endpoint)) return Response.json({ error: 'UNKNOWN_AUTH_ENDPOINT' }, { status: 404 });
  const base = process.env.SIFTVANE_INBOX_API_ORIGIN || process.env.CLAM_INBOX_API_ORIGIN || 'http://127.0.0.1:4000';
  const headers = new Headers();
  for (const name of ['Cookie', 'Content-Type']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const upstream = await fetch(base.replace(/\/$/, '') + '/api/auth/' + endpoint + request.nextUrl.search, {
      method: request.method, headers, cache: 'no-store', redirect: 'manual',
      body: request.method === 'POST' ? await request.text() : undefined, signal: request.signal,
    });
    const resultHeaders = new Headers({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    for (const name of ['Content-Type', 'Location']) {
      const value = upstream.headers.get(name);
      if (value) resultHeaders.set(name, value);
    }
    for (const value of upstream.headers.getSetCookie()) resultHeaders.append('Set-Cookie', value);
    return new Response(upstream.body, { status: upstream.status, headers: resultHeaders });
  } catch {
    return Response.json({ error: 'INBOX_BACKEND_UNAVAILABLE' }, { status: 502 });
  }
}

export { proxy as GET, proxy as POST };
