import type { TurnToolScope } from '../daemonTurn/toolScope.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from '../../core/models/index.js';
import { packageVersion } from '../../shared/package-info.js';
import type { ManagerAssignmentIdentity } from './assignment.js';
import { startManagerMcpConnection } from './managerMcpConnection.js';

export const TAKT_MANAGER_MCP_SERVER_NAME = 'takt_mgr_9f92c6ea76364b51a45846a08ee7ad09';

interface ManagerMcpOptions {
  turnScope: TurnToolScope;
  conversationTurn?: () => { patrol: boolean } | undefined;
}

export async function connectManagerMcp(
  cwd: string,
  assignment: ManagerAssignmentIdentity,
  userServers: Record<string, McpServerConfig> | undefined,
  options: ManagerMcpOptions,
) {
  const connection = await startManagerMcpConnection(cwd, assignment, options.turnScope, options.conversationTurn);
  let client: Client | undefined;
  let transport: StreamableHTTPClientTransport | undefined;
  const dispose = async (): Promise<void> => {
    connection.invalidate();
    try { await client?.close(); }
    finally {
      try { await transport?.close(); }
      finally { await connection.dispose(); }
    }
  };
  try {
    client = new Client({ name: 'takt-manager', version: packageVersion });
    const servers: Record<string, McpServerConfig> = { [TAKT_MANAGER_MCP_SERVER_NAME]: connection.config };
    transport = new StreamableHTTPClientTransport(new URL(connection.config.url), { requestInit: { headers: connection.config.headers } });
    await client.connect(transport);
    return { client, servers: { ...userServers, ...servers }, dispose };
  } catch (error) {
    try { await dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Manager MCP startup and cleanup failed'); }
    throw error;
  }
}
