import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';
import type { MockCallOptions, ScenarioEntry } from './types.js';

export async function executeMockMcpCalls(
  calls: NonNullable<ScenarioEntry['mcpToolCalls']>, options: MockCallOptions,
  onCallCompleted: (call: { server: string; tool: string; result: unknown }) => void,
): Promise<'completed' | 'aborted'> {
  for (const call of calls) {
    const server = options.preparedMcp?.resolvedServers?.servers[call.server];
    if (server === undefined || (server.type !== undefined && server.type !== 'stdio') || server.command === undefined) {
      throw new Error(`Mock MCP requires a configured stdio server: ${call.server}`);
    }
    const permission = `mcp__${call.server}__${call.tool}`;
    if (!options.allowedTools?.includes(permission)) throw new Error(`Mock MCP tool is not allowed: ${permission}`);
    if (options.abortSignal?.aborted) return 'aborted';
    const client = new Client({ name: 'takt-mock-provider', version: '1.0.0' });
    const env = Object.fromEntries(Object.entries(buildChildProcessEnv({ ...process.env, ...server.env }))
      .filter((entry): entry is [string, string] => entry[1] !== undefined));
    const transport = new StdioClientTransport({ command: server.command, args: server.args, env, cwd: options.cwd, stderr: 'inherit' });
    const errors: unknown[] = [];
    let cleanupFailed = false;
    try {
      await client.connect(transport, { signal: options.abortSignal });
      const result = await client.callTool({ name: call.tool, arguments: call.arguments }, undefined, { signal: options.abortSignal });
      if (result.isError === true) throw new Error(`Mock MCP tool failed: ${permission}`);
      onCallCompleted({ server: call.server, tool: call.tool, result });
    } catch (error) {
      errors.push(error);
    } finally {
      for (const resource of [client, transport]) {
        try { await resource.close(); }
        catch (error) { cleanupFailed = true; errors.push(error); }
      }
    }
    if (errors.length > 1) throw new AggregateError(errors, 'Mock MCP call and cleanup failed');
    if (cleanupFailed) throw errors[0];
    if (options.abortSignal?.aborted) return 'aborted';
    if (errors.length === 1) throw errors[0];
  }
  return 'completed';
}
