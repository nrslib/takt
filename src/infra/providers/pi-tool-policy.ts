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
  'powershell',
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
  powershell: 'powershell',
};
const PI_READONLY_TOOL_SET = new Set<string>(PI_READONLY_TOOLS);

export interface PiToolInfo {
  readonly name: string;
  readonly source: string;
  readonly sourcePath?: string;
}

/** Maps workflow tool aliases to Pi builtin names without accepting unknown aliases. */
function normalizePiToolName(tool: string): string | undefined {
  const trimmed = tool.trim();
  return PI_TOOL_ALIASES[trimmed] ?? PI_TOOL_ALIASES[trimmed.toLowerCase()];
}

/** Whether a workflow tool can remain available when editing is disabled. */
export function keepsPiToolWithoutEdit(tool: string): boolean {
  const normalized = normalizePiToolName(tool);
  return normalized !== undefined && PI_READONLY_TOOL_SET.has(normalized);
}

/** Selects explicitly trusted extension tools, including builtin overrides. */
function explicitExtensionToolNames(
  allTools: readonly PiToolInfo[],
  explicitExtensionPaths: readonly string[],
): string[] {
  if (explicitExtensionPaths.length === 0) {
    return [];
  }
  const explicitPaths = new Set(explicitExtensionPaths);
  return allTools
    .filter((tool) => (
      tool.sourcePath !== undefined
      && explicitPaths.has(tool.sourcePath)
    ))
    .map((tool) => tool.name);
}

/**
 * Combines builtin permissions with extension-wide grants in readonly/edit modes.
 * An allowlist that is empty after normalization always denies all tools; outside
 * those two modes an explicit allowlist remains authoritative. Builtin overrides
 * must satisfy both the mode and any explicit allowlist; only non-builtin extension
 * names receive the extension-wide grant. Callers must validate extension provenance.
 */
export function resolvePiActiveTools(
  permissionMode: PermissionMode | undefined,
  allowedTools: string[] | undefined,
  allTools: readonly PiToolInfo[],
  explicitExtensionPaths: readonly string[] = [],
): string[] {
  const allToolNames = allTools.map((tool) => tool.name);
  const explicitTools = explicitExtensionToolNames(allTools, explicitExtensionPaths);
  const permissionTools: readonly string[] | undefined = permissionMode === 'readonly'
    ? PI_READONLY_TOOLS
    : permissionMode === 'edit'
      ? PI_EDIT_TOOLS
      : undefined;
  const normalizedAllowedTools = allowedTools === undefined
    ? undefined
    : [...new Set(allowedTools
      .map((tool) => normalizePiToolName(tool) ?? tool.trim())
      .filter((tool) => tool.length > 0))];

  let activeTools: string[];
  if (normalizedAllowedTools === undefined) {
    if (permissionTools !== undefined) {
      activeTools = [...permissionTools];
    } else if (permissionMode === 'full') {
      activeTools = allToolNames;
    } else {
      const extensionTools = allToolNames.filter((tool) => !PI_BUILTIN_TOOLS.has(tool));
      activeTools = [...new Set([...PI_DEFAULT_TOOLS, ...extensionTools])];
    }
  } else {
    activeTools = permissionTools === undefined
      ? normalizedAllowedTools
      : normalizedAllowedTools.filter((tool) => permissionTools.includes(tool));
  }

  if (permissionTools !== undefined && (normalizedAllowedTools === undefined || normalizedAllowedTools.length > 0)) {
    const nonBuiltinExtensionTools = explicitTools.filter((tool) => !PI_BUILTIN_TOOLS.has(tool));
    activeTools = [...new Set([...activeTools, ...nonBuiltinExtensionTools])];
  }

  const enforcesBuiltinProvenance = permissionMode === 'readonly'
    || permissionMode === 'edit'
    || (permissionMode === undefined && allowedTools !== undefined)
    || (permissionMode === 'full' && allowedTools?.every(keepsPiToolWithoutEdit) === true);
  if (!enforcesBuiltinProvenance) {
    return activeTools;
  }

  const builtinTools = new Set(allTools
    .filter((tool) => tool.source === 'builtin')
    .map((tool) => tool.name));
  const shadowedBuiltinTools = new Set(allTools
    .filter((tool) => PI_BUILTIN_TOOLS.has(tool.name) && tool.source !== 'builtin')
    .map((tool) => tool.name));
  const piOwnedTools = new Set(allTools
    .filter((tool) => tool.name === 'bash' && tool.source === 'sdk')
    .map((tool) => tool.name));
  return activeTools.filter((tool) => (
    explicitTools.includes(tool)
    || piOwnedTools.has(tool)
    || (builtinTools.has(tool) && !shadowedBuiltinTools.has(tool))
  ));
}
