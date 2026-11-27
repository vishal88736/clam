import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpTokenKind, siftvaneEnvironment } from '@siftvane/shared';

async function runBridge() {
  const env = siftvaneEnvironment(process.env);
  const token = env.SIFTVANE_MCP_TOKEN;
  if (!token || !mcpTokenKind(token)) throw new Error('Set SIFTVANE_MCP_TOKEN to a scoped Siftvane token.');
  const url = new URL('/mcp', env.SIFTVANE_API_URL || env.SIFTVANE_PUBLIC_URL || 'http://localhost:4000');
  if (url.username || url.password || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) {
    throw new Error('Use HTTPS for a remote Siftvane server.');
  }
  const local = new Server({ name: 'siftvane-stdio', version: '1.0.0' }, { capabilities: { tools: {} } });
  let connection: Promise<Client> | undefined;
  const connect = () => connection ??= (async () => {
    const remote = new Client(local.getClientVersion() ?? { name: 'siftvane-stdio-bridge', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { redirect: 'error', headers: { Authorization: 'Bearer ' + token } },
    });
    await remote.connect(transport);
    return remote;
  })().catch(() => {
    connection = undefined;
    throw new Error('Siftvane HTTP endpoint is unavailable or rejected the scoped MCP token.');
  });
  local.setRequestHandler(ListToolsRequestSchema, async (request) => (await connect()).listTools(request.params));
  local.setRequestHandler(CallToolRequestSchema, async (request) => (await connect()).callTool(request.params));
  local.onclose = () => { void connection?.then((remote) => remote.close()).catch(() => undefined); };
  process.stdin.once('end', () => { void local.close(); });
  await local.connect(new StdioServerTransport());
}

runBridge().catch(() => {
  process.stderr.write('Siftvane stdio bridge could not connect. Check SIFTVANE_API_URL and SIFTVANE_MCP_TOKEN.\n');
  process.exitCode = 1;
});
