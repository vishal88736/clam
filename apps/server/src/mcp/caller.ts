import { scanOutboundSecrets } from '@clam/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpCaller } from '../inbox/contracts.js';

export function mcpCaller(server: McpServer, grant: { tokenId: string; inboxId: string }, tool: string): McpCaller {
  const name = server.server.getClientVersion()?.name;
  const client = name && /^[\w .()+/-]{1,64}$/.test(name) && !/\b(?:clm_|ya29\.)/i.test(name) &&
    !scanOutboundSecrets(name) ? name : 'MCP client';
  return { tool, client, token_id: grant.tokenId, inbox_id: grant.inboxId };
}
