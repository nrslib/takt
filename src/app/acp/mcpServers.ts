import type { McpServer } from '@agentclientprotocol/sdk';
import type { McpServerConfig } from '../../core/models/index.js';

function envVariablesToRecord(env: Array<{ name: string; value: string }>): Record<string, string> | undefined {
  if (env.length === 0) {
    return undefined;
  }
  const values: Record<string, string> = {};
  for (const entry of env) {
    const name = entry.name.trim();
    if (!name) {
      throw new Error('mcpServers env name is required');
    }
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      throw new Error(`Duplicate MCP server env name: ${name}`);
    }
    values[name] = entry.value;
  }
  return values;
}

export function normalizeAcpMcpServers(
  mcpServers: McpServer[] | undefined,
): Record<string, McpServerConfig> | undefined {
  if (mcpServers === undefined || mcpServers.length === 0) {
    return undefined;
  }
  const normalized: Record<string, McpServerConfig> = {};
  for (const server of mcpServers) {
    if ('type' in server) {
      throw new Error(`Unsupported ACP MCP server transport: ${server.type}`);
    }
    if (!('command' in server)) {
      throw new Error('Unsupported ACP MCP server transport');
    }
    const name = server.name.trim();
    if (!name) {
      throw new Error('mcpServers name is required');
    }
    if (Object.prototype.hasOwnProperty.call(normalized, name)) {
      throw new Error(`Duplicate MCP server name: ${name}`);
    }
    const command = server.command.trim();
    if (!command) {
      throw new Error(`mcpServers "${name}" command is required`);
    }
    const env = envVariablesToRecord(server.env);
    normalized[name] = {
      type: 'stdio',
      command,
      args: [...server.args],
      ...(env ? { env } : {}),
    };
  }
  return normalized;
}
