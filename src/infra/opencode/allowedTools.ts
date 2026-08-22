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
