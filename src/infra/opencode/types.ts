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

/**
 * Build the permission ruleset used at session creation.
 *
 * A session-scoped `deny` can never be escalated later (verified against a
 * live OpenCode server: neither agent-level `allow` nor a new ruleset can
 * override it), while TAKT reuses one session across step phases and the
 * report phase needs file writes on read-only steps. Therefore `edit`/`write`
 * denies are lifted to `allow` at session scope (`ask` rules stay: the
 * permission auto-reply already approves them per phase) and the per-phase
 * restriction is enforced by the explicit per-prompt tools map instead
 * (see buildOpenCodePromptTools).
 *
 * `external_directory` is denied explicitly. Note that this session-scoped
 * rule only holds until the first prompt: a prompt-level tools map is
 * materialized into `session.permission` by OpenCode and replaces this
 * ruleset. The authoritative deny lives in the server config passed to
 * `createOpencode` (see client.ts), which the rewrite does not touch; the
 * rule here covers the window before the first prompt.
 */
export function buildOpenCodeSessionPermission(
  mode?: PermissionMode,
  networkAccess?: boolean,
  allowedTools?: OpenCodeAllowedTools,
): OpenCodePermissionRule[] {
  const rules = buildOpenCodePermissionRuleset(mode, networkAccess, allowedTools)
    .map((rule) => (
      (rule.permission === 'edit' || rule.permission === 'write') && rule.action === 'deny'
        ? { ...rule, action: 'allow' as const }
        : rule
    ));
  for (const permission of ['edit', 'write'] as const) {
    if (!rules.some((rule) => rule.permission === permission)) {
      rules.push({ permission, pattern: '*', action: 'allow' });
    }
  }
  rules.push({ permission: 'external_directory', pattern: '*', action: 'deny' });
  return rules;
}

/**
 * OpenCode tool ids grouped by the permission that governs them.
 * `task` is intentionally absent: TAKT disables subagent spawning at the
 * agent level and never re-enables it per prompt. `skill` loads skill files
 * (read-shaped), so it follows the read permission.
 */
const OPEN_CODE_TOOL_IDS_BY_PERMISSION: Record<Exclude<OpenCodePermissionKey, 'task'>, readonly string[]> = {
  read: ['read', 'list', 'skill'],
  glob: ['glob'],
  grep: ['grep'],
  edit: ['edit', 'write', 'patch'],
  write: ['write'],
  bash: ['bash'],
  todowrite: ['todowrite', 'todoread'],
  websearch: ['websearch'],
  webfetch: ['webfetch'],
  question: ['question'],
};

/** 全プロンプトで明示するツール ID の完全集合（固着リーク防止の契約） */
export const OPEN_CODE_MANAGED_TOOL_IDS = Object.freeze([
  'task',
  ...new Set(Object.values(OPEN_CODE_TOOL_IDS_BY_PERMISSION).flat()),
]);

/**
 * Build the explicit per-prompt tools map that enforces the current phase's
 * tool restriction on a shared session.
 *
 * The map is sent with every prompt and always covers the full managed tool
 * set: OpenCode persists the last explicit map on the session, so omitting a
 * key would silently leak the previous phase's restriction into the next one
 * (verified against a live OpenCode server).
 */
export function buildOpenCodePromptTools(
  mode?: PermissionMode,
  networkAccess?: boolean,
  allowedTools?: OpenCodeAllowedTools,
): Record<string, boolean> {
  const enabledPermissions = new Set<string>();
  if (allowedTools !== undefined) {
    for (const permission of resolveOpenCodeAllowedPermissions(mode, networkAccess, allowedTools)) {
      enabledPermissions.add(permission);
    }
  } else {
    const permissionMap = applyNetworkAccessOverride(buildPermissionMap(mode), networkAccess);
    for (const [permission, action] of Object.entries(permissionMap)) {
      if (action !== 'deny') {
        enabledPermissions.add(permission);
      }
    }
  }

  const tools: Record<string, boolean> = { task: false };
  for (const [permission, toolIds] of Object.entries(OPEN_CODE_TOOL_IDS_BY_PERMISSION)) {
    for (const toolId of toolIds) {
      tools[toolId] = (tools[toolId] ?? false) || enabledPermissions.has(permission);
    }
  }
  return tools;
}

function buildOpenCodeAllowedToolsRuleset(
  mode: PermissionMode | undefined,
  networkAccess: boolean | undefined,
  allowedTools: OpenCodeAllowedTools,
): OpenCodePermissionRule[] {
  if (allowedTools.length === 0) {
    return [{ permission: '*', pattern: '*', action: 'deny' }];
  }

  const uniqueAllowed = resolveOpenCodeAllowedPermissions(mode, networkAccess, allowedTools);

  return [
    { permission: '*', pattern: '*', action: 'deny' },
    ...uniqueAllowed.map((permission) => ({ permission, pattern: '*', action: 'allow' as const })),
  ];
}

export function resolveOpenCodeAllowedPermissions(
  mode: PermissionMode | undefined,
  networkAccess: boolean | undefined,
  allowedTools: OpenCodeAllowedTools,
): string[] {
  const allowed = allowedTools
    .map(toOpenCodeAllowedPermission)
    .filter((permission): permission is string => (
      permission !== null
      && isOpenCodePermissionKey(permission)
      && (permission !== 'edit' || isAllowedByPermissionMode(permission, mode))
      && (networkAccess !== false || !isOpenCodeWebPermission(permission))
    ));
  return Array.from(new Set(allowed));
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
  childProcessEnv?: Readonly<Record<string, string>>;
}
