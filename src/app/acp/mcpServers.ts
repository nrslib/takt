import type { McpServer } from '@agentclientprotocol/sdk';
import type { McpServerConfig } from '../../core/models/index.js';

function requireAcpMcpServers(mcpServers: McpServer[] | undefined): McpServer[] {
  if (mcpServers === undefined) {
    throw new Error('mcpServers is required');
  }
  return mcpServers;
}

function envVariablesToRecord(env: Array<{ name: string; value: string }>): Record<string, string> | undefined {
  if (env.length === 0) {
    return undefined;
  }
  const values: Record<string, string> = {};
  for (const entry of env) {
    if (!entry.name.trim()) {
      throw new Error('mcpServers env name is required');
    }
    values[entry.name] = entry.value;
  }
  return values;
}

export function normalizeAcpMcpServers(
  mcpServers: McpServer[] | undefined,
): Record<string, McpServerConfig> | undefined {
  const requiredServers = requireAcpMcpServers(mcpServers);
  if (requiredServers.length === 0) {
    return undefined;
  }
  const normalized: Record<string, McpServerConfig> = {};
  for (const server of requiredServers) {
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
    if (!server.command.trim()) {
      throw new Error(`mcpServers "${name}" command is required`);
    }
    const env = envVariablesToRecord(server.env);
    normalized[name] = {
      type: 'stdio',
      command: server.command,
      args: [...server.args],
      ...(env ? { env } : {}),
    };
  }
  return normalized;
}
