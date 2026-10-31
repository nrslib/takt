import type { ToolPermissionDecision, ToolPermissionDecisionRequest } from '../../core/workflow/types.js';

export const CODEX_TOOL_PERMISSION_ENDPOINT_ENV = 'TAKT_CODEX_TOOL_PERMISSION_ENDPOINT';
export const CODEX_TOOL_PERMISSION_TOKEN_ENV = 'TAKT_CODEX_TOOL_PERMISSION_TOKEN';
// The judge has 30 seconds; transport deadlines leave time to return an explicit denial.
export const CODEX_TOOL_PERMISSION_DECISION_TIMEOUT_MS = 60_000;
export const CODEX_TOOL_PERMISSION_HANDLER_TIMEOUT_MS = 65_000;
export const CODEX_TOOL_PERMISSION_HOOK_TIMEOUT_SECONDS = 90;

export interface CodexToolPermissionHookDefinition {
  command: string;
  matcher: string;
  timeout: number;
}

export function isHookRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCodexToolPermissionInput(value: unknown): ToolPermissionDecisionRequest {
  if (!isHookRecord(value) || value.hook_event_name !== 'PreToolUse'
    || typeof value.tool_name !== 'string' || !value.tool_name.trim()
    || typeof value.cwd !== 'string' || !value.cwd.trim() || !Object.hasOwn(value, 'tool_input')) {
    throw new Error('Invalid PreToolUse input');
  }
  return { toolName: value.tool_name, toolInput: value.tool_input, cwd: value.cwd };
}

export function parseCodexToolPermissionDecision(value: unknown): ToolPermissionDecision {
  if (isHookRecord(value)) {
    if (value.decision === 'allow') return { decision: 'allow' };
    if (value.decision === 'deny' && typeof value.reason === 'string' && value.reason.trim()) {
      return { decision: 'deny', reason: value.reason };
    }
  }
  throw new Error('Invalid tool permission decision');
}

export function toCodexToolPermissionOutput(decision: ToolPermissionDecision) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: decision.decision,
      permissionDecisionReason: decision.decision === 'deny' ? decision.reason : '',
    },
  };
}

export function parseCodexToolPermissionOutput(value: unknown): ReturnType<typeof toCodexToolPermissionOutput> {
  if (!isHookRecord(value) || !isHookRecord(value.hookSpecificOutput)
    || value.hookSpecificOutput.hookEventName !== 'PreToolUse') {
    throw new Error('Invalid PreToolUse output');
  }
  const output = value.hookSpecificOutput;
  return toCodexToolPermissionOutput(parseCodexToolPermissionDecision({
    decision: output.permissionDecision, reason: output.permissionDecisionReason,
  }));
}

export function codexToolPermissionDenial(reason: string): ReturnType<typeof toCodexToolPermissionOutput> {
  return toCodexToolPermissionOutput({ decision: 'deny', reason });
}

export function buildCodexToolPermissionHookConfig(definition: CodexToolPermissionHookDefinition) {
  return {
    PreToolUse: [{ matcher: definition.matcher, hooks: [{ type: 'command', command: definition.command, timeout: definition.timeout }] }],
  };
}
