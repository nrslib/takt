import type { PermissionMode } from '../../core/models/index.js';

export const PI_READONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

const PI_EDIT_TOOLS = [...PI_READONLY_TOOLS, 'edit', 'write', 'bash'];
const PI_DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write'];
const PI_BUILTIN_TOOLS = new Set([
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
]);
const PI_TOOL_ALIASES: Readonly<Record<string, string>> = {
  read: 'read',
  Read: 'read',
  grep: 'grep',
  Grep: 'grep',
  find: 'find',
  Find: 'find',
  glob: 'find',
  Glob: 'find',
  ls: 'ls',
  LS: 'ls',
  edit: 'edit',
  Edit: 'edit',
  write: 'write',
  Write: 'write',
  bash: 'bash',
  Bash: 'bash',
};
const PI_READONLY_TOOL_SET = new Set<string>(PI_READONLY_TOOLS);

export interface PiToolInfo {
  readonly name: string;
  readonly source: string;
}

function normalizePiToolName(tool: string): string | undefined {
  const trimmed = tool.trim();
  return PI_TOOL_ALIASES[trimmed] ?? PI_TOOL_ALIASES[trimmed.toLowerCase()];
}

export function keepsPiToolWithoutEdit(tool: string): boolean {
  const normalized = normalizePiToolName(tool);
  return normalized !== undefined && PI_READONLY_TOOL_SET.has(normalized);
}

export function resolvePiActiveTools(
  permissionMode: PermissionMode | undefined,
  allowedTools: string[] | undefined,
  allTools: readonly PiToolInfo[],
): string[] {
  const allToolNames = allTools.map((tool) => tool.name);
  const permissionTools: readonly string[] | undefined = permissionMode === 'readonly'
    ? PI_READONLY_TOOLS
    : permissionMode === 'edit'
      ? PI_EDIT_TOOLS
      : undefined;

  let activeTools: string[];
  if (allowedTools === undefined) {
    if (permissionTools !== undefined) {
      activeTools = [...permissionTools];
    } else if (permissionMode === 'full') {
      activeTools = allToolNames;
    } else {
      const extensionTools = allToolNames.filter((tool) => !PI_BUILTIN_TOOLS.has(tool));
      activeTools = [...new Set([...PI_DEFAULT_TOOLS, ...extensionTools])];
    }
  } else {
    const normalized = [...new Set(allowedTools
      .map((tool) => normalizePiToolName(tool) ?? tool.trim())
      .filter((tool) => tool.length > 0))];
    if (permissionMode === 'readonly') {
      activeTools = normalized.filter((tool) => permissionTools?.includes(tool) === true);
    } else if (permissionMode === 'edit') {
      activeTools = normalized.filter((tool) => permissionTools?.includes(tool) === true || !PI_BUILTIN_TOOLS.has(tool));
    } else {
      activeTools = normalized;
    }
  }

  const requiresBuiltinReadTools = permissionMode === 'readonly'
    || allowedTools?.every(keepsPiToolWithoutEdit) === true;
  if (!requiresBuiltinReadTools) {
    return activeTools;
  }
  const builtinTools = new Set(allTools
    .filter((tool) => tool.source === 'builtin')
    .map((tool) => tool.name));
  return activeTools.filter((tool) => builtinTools.has(tool));
}
