/**
 * Type definitions for OpenCode SDK integration
 */

import type { AskUserQuestionHandler } from '../../core/workflow/types.js';
import type { PermissionMode } from '../../core/models/index.js';
import type { StreamCallback } from '../../shared/types/provider.js';
import { mapsToOpenCodeEditPermission } from './allowedTools.js';

/** OpenCode permission reply values */
export type OpenCodePermissionReply = 'once' | 'always' | 'reject';
export type OpenCodePermissionAction = 'ask' | 'allow' | 'deny';
export type OpenCodePermissionRule = {
  permission: string;
  pattern: string;
  action: OpenCodePermissionAction;
};

/** Map TAKT PermissionMode to OpenCode permission reply */
export function mapToOpenCodePermissionReply(mode: PermissionMode): OpenCodePermissionReply {
  const mapping: Record<PermissionMode, OpenCodePermissionReply> = {
    readonly: 'reject',
    edit: 'once',
    full: 'always',
  };
  return mapping[mode];
}

const OPEN_CODE_DOOM_LOOP_PERMISSION = 'doom_loop';

export function resolveOpenCodePermissionReply(
  mode: PermissionMode | undefined,
  permission?: string,
  allowedToolsRuleset?: readonly OpenCodePermissionRule[],
): OpenCodePermissionReply {
  if (permission === OPEN_CODE_DOOM_LOOP_PERMISSION) {
    return 'once';
  }

  if (!permission || !isOpenCodePermissionKey(permission)) {
    return 'reject';
  }

  if (allowedToolsRuleset !== undefined) {
    return isPermissionAllowedByRuleset(permission, allowedToolsRuleset)
      ? mapAllowedRulesetReply(mode)
      : 'reject';
  }

  return mode ? mapToOpenCodePermissionReply(mode) : 'once';
}

function mapAllowedRulesetReply(mode: PermissionMode | undefined): OpenCodePermissionReply {
  return mode === 'full' ? 'always' : 'once';
}

function isPermissionAllowedByRuleset(
  permission: string | undefined,
  ruleset: readonly OpenCodePermissionRule[],
): boolean {
  if (!permission) {
    return false;
  }

  return ruleset.some((rule) => (
    rule.action === 'allow'
    && (rule.permission === permission || rule.permission === '*')
  ));
}

const OPEN_CODE_PERMISSION_KEYS = [
  'read',
  'glob',
  'grep',
  'edit',
  'write',
  'bash',
  'task',
  'todowrite',
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
    todowrite: 'deny',
    websearch: 'deny',
    webfetch: 'deny',
    question: 'deny',
  };

  if (mode === 'readonly') {
    return {
      ...allDeny,
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
    };
  }

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
      todowrite: 'allow',
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
      todowrite: 'allow',
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
    todowrite: 'ask',
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

export function buildOpenCodePermissionRuleset(
  mode?: PermissionMode,
  networkAccess?: boolean,
  allowedTools?: OpenCodeAllowedTools,
): OpenCodePermissionRule[] {
  if (allowedTools !== undefined) {
    return buildOpenCodeAllowedToolsRuleset(mode, networkAccess, allowedTools);
  }

  if (mode === 'full' && networkAccess === undefined) {
    return [{ permission: '*', pattern: '*', action: 'allow' }];
  }

  const permissionMap = applyNetworkAccessOverride(buildPermissionMap(mode), networkAccess);
  return OPEN_CODE_PERMISSION_KEYS.map((permission) => ({
    permission,
    pattern: '**',
    action: permissionMap[permission],
  }));
}

export type OpenCodeAllowedTools = readonly string[];

function buildOpenCodeAllowedToolsRuleset(
  mode: PermissionMode | undefined,
  networkAccess: boolean | undefined,
  allowedTools: OpenCodeAllowedTools,
): OpenCodePermissionRule[] {
  if (allowedTools.length === 0) {
    return OPEN_CODE_PERMISSION_KEYS.map((permission) => ({
      permission,
      pattern: '**',
      action: 'deny',
    }));
  }

  const allowed = allowedTools
    .map(toOpenCodeAllowedPermission)
    .filter((permission): permission is string => (
      permission !== null
      && isAllowedByPermissionMode(permission, mode)
      && (networkAccess !== false || !isOpenCodeWebPermission(permission))
    ));
  const uniqueAllowed = Array.from(new Set(allowed));

  return [
    { permission: '*', pattern: '*', action: 'deny' },
    ...uniqueAllowed.map((permission) => ({ permission, pattern: '*', action: 'allow' as const })),
  ];
}

function isOpenCodeWebPermission(permission: string): boolean {
  return permission === 'websearch' || permission === 'webfetch';
}

function isAllowedByPermissionMode(permission: string, mode: PermissionMode | undefined): boolean {
  if (!isOpenCodePermissionKey(permission)) {
    return false;
  }

  if (mode === undefined || mode === 'full') {
    return true;
  }

  const permissionMap = buildPermissionMap(mode);
  return permissionMap[permission] === 'allow';
}

function isOpenCodePermissionKey(permission: string): permission is OpenCodePermissionKey {
  return (OPEN_CODE_PERMISSION_KEYS as readonly string[]).includes(permission);
}

function toOpenCodeAllowedPermission(tool: string): string | null {
  const trimmed = tool.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes('*')) {
    throw new Error(`OpenCode allowedTools does not accept wildcard permission: ${trimmed}`);
  }
  if (mapsToOpenCodeEditPermission(trimmed)) {
    return 'edit';
  }

  switch (trimmed.toLowerCase()) {
    case 'read':
      return 'read';
    case 'glob':
      return 'glob';
    case 'grep':
      return 'grep';
    case 'bash':
      return 'bash';
    case 'task':
      return 'task';
    case 'todowrite':
    case 'todo_write':
      return 'todowrite';
    case 'websearch':
      return 'websearch';
    case 'webfetch':
      return 'webfetch';
    case 'question':
      return 'question';
    default:
      return trimmed;
  }
}

/** Options for calling OpenCode */
export interface OpenCodeCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model: string;
  systemPrompt?: string;
  /** Resolved OpenCode tool allowlist from provider_options.opencode.allowed_tools. */
  allowedTools?: OpenCodeAllowedTools;
  permissionMode?: PermissionMode;
  networkAccess?: boolean;
  variant?: string;
  onStream?: StreamCallback;
  onAskUserQuestion?: AskUserQuestionHandler;
  opencodeApiKey?: string;
  interactionTimeoutMs?: number;
}
