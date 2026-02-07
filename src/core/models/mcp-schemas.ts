/**
 * Zod schemas for MCP (Model Context Protocol) server configuration.
 *
 * Supports three transports: stdio, SSE, and HTTP.
 * Note: Uses zod v4 syntax for SDK compatibility.
 */

import { z } from 'zod/v4';

/** MCP server configuration for stdio transport */
const McpStdioServerSchema = z.object({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

/** MCP server configuration for SSE transport */
const McpSseServerSchema = z.object({
  type: z.literal('sse'),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
});

/** MCP server configuration for HTTP transport */
const McpHttpServerSchema = z.object({
  type: z.literal('http'),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
});

/** MCP server configuration (union of all YAML-configurable transports) */
export const McpServerConfigSchema = z.union([
  McpStdioServerSchema,
  McpSseServerSchema,
  McpHttpServerSchema,
]);

/** MCP servers map: server name → config */
export const McpServersSchema = z.record(z.string(), McpServerConfigSchema).optional();
