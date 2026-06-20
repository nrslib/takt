const OPENCODE_EDIT_PERMISSION_TOOL_NAMES = new Set([
  'edit',
  'write',
  'apply_patch',
  'patch',
]);

export function mapsToOpenCodeEditPermission(tool: string): boolean {
  return OPENCODE_EDIT_PERMISSION_TOOL_NAMES.has(tool.trim().toLowerCase());
}
