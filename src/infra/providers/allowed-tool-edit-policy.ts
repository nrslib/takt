export const CLAUDE_EDIT_TOOL_NAMES = new Set([
  'edit',
  'write',
  'apply_patch',
  'patch',
]);

export function keepsAllowedToolWithoutEdit(tool: string): boolean {
  return !CLAUDE_EDIT_TOOL_NAMES.has(tool.trim().toLowerCase());
}
