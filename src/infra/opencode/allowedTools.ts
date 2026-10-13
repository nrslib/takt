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
  const serverName = parsed.serverName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${serverName}_${parsed.toolName}`;
}
