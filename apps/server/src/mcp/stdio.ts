import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

async function runBridge() {
  const token = process.env.CLAM_MCP_TOKEN;
  if (!token || !/^clm_(?:ag|inbox|pod)_[\w-]+$/.test(token)) throw new Error('Set CLAM_MCP_TOKEN to a scoped Clam token.');
  const url = new URL('/mcp', process.env.CLAM_API_URL || process.env.CLAM_PUBLIC_URL || 'http://localhost:4000');
  if (url.username || url.password || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) {
    throw new Error('Use HTTPS for a remote Clam server.');
  }
  const local = new Server({ name: 'clam-stdio', version: '1.0.0' }, { capabilities: { tools: {} } });
  let connection: Promise<Client> | undefined;
  const connect = () => connection ??= (async () => {
    const remote = new Client(local.getClientVersion() ?? { name: 'clam-stdio-bridge', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { redirect: 'error', headers: { Authorization: 'Bearer ' + token } },
    });
    await remote.connect(transport);
    return remote;
  })().catch(() => {
    connection = undefined;
    throw new Error('Clam HTTP endpoint is unavailable or rejected the scoped MCP token.');
  });
  local.setRequestHandler(ListToolsRequestSchema, async (request) => (await connect()).listTools(request.params));
  local.setRequestHandler(CallToolRequestSchema, async (request) => (await connect()).callTool(request.params));
  local.onclose = () => { void connection?.then((remote) => remote.close()).catch(() => undefined); };
  process.stdin.once('end', () => { void local.close(); });
  await local.connect(new StdioServerTransport());
}

runBridge().catch(() => {
  process.stderr.write('Clam stdio bridge could not connect. Check CLAM_API_URL and CLAM_MCP_TOKEN.\n');
  process.exitCode = 1;
});
