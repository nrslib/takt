/**
 * Type definitions for OpenCode SDK integration
 */

import type { StreamCallback } from '../claude/index.js';
import type { AskUserQuestionHandler } from '../../core/piece/types.js';
import type { PermissionMode } from '../../core/models/index.js';

/** OpenCode permission reply values */
export type OpenCodePermissionReply = 'once' | 'always' | 'reject';
export type OpenCodePermissionAction = 'ask' | 'allow' | 'deny';

/** Map TAKT PermissionMode to OpenCode permission reply */
export function mapToOpenCodePermissionReply(mode: PermissionMode): OpenCodePermissionReply {
  const mapping: Record<PermissionMode, OpenCodePermissionReply> = {
    readonly: 'reject',
    edit: 'once',
    full: 'always',
  };
  return mapping[mode];
}

const OPEN_CODE_PERMISSION_KEYS = [
  'read',
  'glob',
  'grep',
  'edit',
  'write',
  'bash',
  'task',
  'websearch',
  'webfetch',
  'question',
] as const;

export type OpenCodePermissionKey = typeof OPEN_CODE_PERMISSION_KEYS[number];

export type OpenCodePermissionMap = Record<OpenCodePermissionKey, OpenCodePermissionAction>;

function buildPermissionMap(mode?: PermissionMode): OpenCodePermissionMap {
  const allDeny: OpenCodePermissionMap = {
    read: 'deny',
    glob: 'deny',
    grep: 'deny',
    edit: 'deny',
    write: 'deny',
    bash: 'deny',
    task: 'deny',
    websearch: 'deny',
    webfetch: 'deny',
    question: 'deny',
  };

  if (mode === 'readonly') return allDeny;

  if (mode === 'full') {
    return {
      ...allDeny,
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      edit: 'allow',
      write: 'allow',
      bash: 'allow',
      task: 'allow',
      websearch: 'allow',
      webfetch: 'allow',
      question: 'allow',
    };
  }

  if (mode === 'edit') {
    return {
      ...allDeny,
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      edit: 'allow',
      write: 'allow',
      bash: 'allow',
      task: 'allow',
      websearch: 'allow',
      webfetch: 'allow',
      question: 'deny',
    };
  }

  return {
    ...allDeny,
    read: 'ask',
    glob: 'ask',
    grep: 'ask',
    edit: 'ask',
    write: 'ask',
    bash: 'ask',
    task: 'ask',
    websearch: 'ask',
    webfetch: 'ask',
    question: 'deny',
  };
}

function applyNetworkAccessOverride(
  map: OpenCodePermissionMap,
  networkAccess?: boolean,
): OpenCodePermissionMap {
  if (networkAccess === undefined) {
    return map;
  }

  const action: OpenCodePermissionAction = networkAccess ? 'allow' : 'deny';
  return {
    ...map,
    webfetch: action,
    websearch: action,
  };
}

export function buildOpenCodePermissionConfig(
  mode?: PermissionMode,
  networkAccess?: boolean,
): OpenCodePermissionAction | Record<string, OpenCodePermissionAction> {
  if (networkAccess === undefined) {
    if (mode === 'readonly') return 'deny';
    if (mode === 'full') return 'allow';
  }
  return applyNetworkAccessOverride(buildPermissionMap(mode), networkAccess);
}

export function buildOpenCodePermissionRuleset(
  mode?: PermissionMode,
  networkAccess?: boolean,
): Array<{ permission: string; pattern: string; action: OpenCodePermissionAction }> {
  const permissionMap = applyNetworkAccessOverride(buildPermissionMap(mode), networkAccess);
  return OPEN_CODE_PERMISSION_KEYS.map((permission) => ({
    permission,
    pattern: '**',
    action: permissionMap[permission],
  }));
}

const BUILTIN_TOOL_MAP: Record<string, string> = {
  Read: 'read',
  Glob: 'glob',
  Grep: 'grep',
  Edit: 'edit',
  Write: 'write',
  Bash: 'bash',
  WebSearch: 'websearch',
  WebFetch: 'webfetch',
};

export function mapToOpenCodeTools(allowedTools?: string[]): Record<string, boolean> | undefined {
  if (!allowedTools) {
    return undefined;
  }
  if (allowedTools.length === 0) {
    return {};
  }

  const mapped = new Set<string>();
  for (const tool of allowedTools) {
    const normalized = tool.trim();
    if (!normalized) {
      continue;
    }
    const mappedTool = BUILTIN_TOOL_MAP[normalized] ?? normalized;
    mapped.add(mappedTool);
  }

  if (mapped.size === 0) {
    return {};
  }

  const tools: Record<string, boolean> = {};
  for (const tool of mapped) {
    tools[tool] = true;
  }
  return tools;
}

/** Options for calling OpenCode */
export interface OpenCodeCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model: string;
  systemPrompt?: string;
  allowedTools?: string[];
  /** Permission mode for automatic permission handling */
  permissionMode?: PermissionMode;
  /** Override network access (webfetch/websearch) */
  networkAccess?: boolean;
  /** Enable streaming mode with callback (best-effort) */
  onStream?: StreamCallback;
  onAskUserQuestion?: AskUserQuestionHandler;
  /** OpenCode API key */
  opencodeApiKey?: string;
  /** JSON Schema for structured output */
  outputSchema?: Record<string, unknown>;
}
