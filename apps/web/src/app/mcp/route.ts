import { NextRequest } from 'next/server';

const BACKEND_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') || 'http://localhost:4000';

async function proxyMcp(req: NextRequest) {
  const headers = new Headers();
  const auth = req.headers.get('authorization');
  const accept = req.headers.get('accept');
  const contentType = req.headers.get('content-type');
  const sessionId = req.headers.get('mcp-session-id');

  if (auth) headers.set('authorization', auth);
  if (accept) headers.set('accept', accept);
  if (contentType) headers.set('content-type', contentType);
  if (sessionId) headers.set('mcp-session-id', sessionId);

  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();

  const upstream = await fetch(`${BACKEND_BASE}/mcp`, {
    method: req.method,
    headers,
    body,
  });

  const respHeaders = new Headers();
  const ct = upstream.headers.get('content-type');
  const sid = upstream.headers.get('mcp-session-id');
  if (ct) respHeaders.set('content-type', ct);
  if (sid) respHeaders.set('mcp-session-id', sid);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

export async function GET(req: NextRequest) {
  return proxyMcp(req);
}

export async function POST(req: NextRequest) {
  return proxyMcp(req);
}

export async function DELETE(req: NextRequest) {
  return proxyMcp(req);
}
