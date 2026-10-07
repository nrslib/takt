import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';
import type { MockCallOptions, ScenarioEntry } from './types.js';

export async function executeMockMcpCalls(
  calls: NonNullable<ScenarioEntry['mcpToolCalls']>, options: MockCallOptions,
): Promise<void> {
  for (const call of calls) {
    const server = options.preparedMcp?.resolvedServers?.servers[call.server];
    if (server === undefined || (server.type !== undefined && server.type !== 'stdio') || server.command === undefined) {
      throw new Error(`Mock MCP requires a configured stdio server: ${call.server}`);
    }
    const permission = `mcp__${call.server}__${call.tool}`;
    if (!options.allowedTools?.includes(permission)) throw new Error(`Mock MCP tool is not allowed: ${permission}`);
    options.abortSignal?.throwIfAborted();
    const client = new Client({ name: 'takt-mock-provider', version: '1.0.0' });
    const env = Object.fromEntries(Object.entries(buildChildProcessEnv({ ...process.env, ...server.env }))
      .filter((entry): entry is [string, string] => entry[1] !== undefined));
    const transport = new StdioClientTransport({ command: server.command, args: server.args, env, cwd: options.cwd, stderr: 'pipe' });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: call.tool, arguments: call.arguments }, undefined, { signal: options.abortSignal });
      if (result.isError === true) throw new Error(`Mock MCP tool failed: ${permission}`);
    } finally {
      try { await client.close(); }
      finally { await transport.close(); }
    }
  }
}
