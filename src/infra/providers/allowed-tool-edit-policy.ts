export const CLAUDE_EDIT_TOOL_NAMES = new Set([
  'edit',
  'write',
  'apply_patch',
  'patch',
]);

const CLAUDE_UNSAFE_WITHOUT_EDIT_TOOL_NAMES = new Set([
  ...CLAUDE_EDIT_TOOL_NAMES,
  'bash',
]);

function getClaudeAllowedToolCanonicalName(tool: string): string {
  const trimmed = tool.trim();
  const argsStart = trimmed.indexOf('(');
  return (argsStart >= 0 ? trimmed.slice(0, argsStart) : trimmed).trim().toLowerCase();
}

function appendClaudeAllowedToolSpec(specs: string[], spec: string): string[] {
  const trimmed = spec.trim();
  return trimmed.length > 0 ? [...specs, trimmed] : specs;
}

export function splitClaudeAllowedToolSpecs(tool: string): string[] {
  let specs: string[] = [];
  let specStart = 0;
  let parenDepth = 0;

  for (let index = 0; index < tool.length; index++) {
    const char = tool[index];
    if (char === '(') {
      parenDepth++;
      continue;
    }
    if (char === ')' && parenDepth > 0) {
      parenDepth--;
      continue;
    }
    if (char === ',' && parenDepth === 0) {
      specs = appendClaudeAllowedToolSpec(specs, tool.slice(specStart, index));
      specStart = index + 1;
    }
  }

  return appendClaudeAllowedToolSpec(specs, tool.slice(specStart));
}

export function keepsAllowedToolWithoutEdit(tool: string): boolean {
  return splitClaudeAllowedToolSpecs(tool).every(
    (spec) => !CLAUDE_UNSAFE_WITHOUT_EDIT_TOOL_NAMES.has(getClaudeAllowedToolCanonicalName(spec)),
  );
}
