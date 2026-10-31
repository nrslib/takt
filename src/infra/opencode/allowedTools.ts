import { parseMcpToolName } from '../providers/mcp/tool-name.js';

const OPENCODE_EDIT_PERMISSION_TOOL_NAMES = new Set([
  'edit',
  'write',
  'apply_patch',
  'patch',
]);

const OPENCODE_UNSAFE_WITHOUT_EDIT_TOOL_NAMES = new Set([
  ...OPENCODE_EDIT_PERMISSION_TOOL_NAMES,
]);

export function mapsToOpenCodeEditPermission(tool: string): boolean {
  return OPENCODE_EDIT_PERMISSION_TOOL_NAMES.has(tool.trim().toLowerCase());
}

export function keepsOpenCodeAllowedToolWithoutEdit(tool: string): boolean {
  return !OPENCODE_UNSAFE_WITHOUT_EDIT_TOOL_NAMES.has(tool.trim().toLowerCase());
}

const OPENCODE_UNSUPPORTED_NAME_CHARS = /[^a-zA-Z0-9_-]/g;

/**
 * Convert the common MCP tool spelling into OpenCode's normalized
 * `<server>_<tool>` permission name. Only the provider-facing name changes;
 * which MCP tools are trusted is decided before reaching this helper.
 */
export function toOpenCodeMcpToolName(tool: string): string | undefined {
  const parsed = parseMcpToolName(tool.trim());
  if (parsed === undefined || !/^[A-Za-z0-9_-]+$/.test(parsed.toolName)) {
    return undefined;
  }
  const serverName = parsed.serverName.replace(OPENCODE_UNSUPPORTED_NAME_CHARS, '_');
  return `${serverName}_${parsed.toolName}`;
}

/**
 * Permission that allows every tool of one MCP server. The server name is used
 * as-is (never re-parsed from a `mcp__<name>` string) so names containing `__`
 * or ending in `_` still select exactly their own tools.
 */
export function toOpenCodeMcpServerPermission(serverName: string): string {
  return `${serverName.replace(OPENCODE_UNSUPPORTED_NAME_CHARS, '_')}_*`;
}
