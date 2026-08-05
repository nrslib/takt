import type { StepProviderOptions } from '../../core/models/workflow-types.js';
import type { EnvSpec } from './env/config-env-overrides.js';

const PROVIDER_OPTIONS_ENV_SPEC_ENTRIES = [
  { path: 'provider_options', type: 'json' },
  { path: 'provider_options.codex.base_url', type: 'string' },
  { path: 'provider_options.codex.network_access', type: 'boolean' },
  { path: 'provider_options.codex.reasoning_effort', type: 'string' },
  { path: 'provider_options.codex.skills.repo', type: 'boolean' },
  { path: 'provider_options.codex.skills.user', type: 'boolean' },
  { path: 'provider_options.opencode.network_access', type: 'boolean' },
  { path: 'provider_options.opencode.variant', type: 'string' },
  { path: 'provider_options.opencode.allowed_tools', type: 'json' },
  { path: 'provider_options.opencode.guards.profile', type: 'string' },
  { path: 'provider_options.opencode.guards.model_profiles', type: 'json' },
  { path: 'provider_options.opencode.guards.call_timeout_ms', type: 'number' },
  { path: 'provider_options.opencode.guards.event_limit', type: 'number' },
  { path: 'provider_options.opencode.guards.text_byte_limit', type: 'number' },
  { path: 'provider_options.opencode.guards.reasoning_byte_limit', type: 'number' },
  { path: 'provider_options.claude.base_url', type: 'string' },
  { path: 'provider_options.claude.effort', type: 'string' },
  { path: 'provider_options.claude.skills.enabled', type: 'boolean' },
  { path: 'provider_options.claude.sandbox.allow_unsandboxed_commands', type: 'boolean' },
  { path: 'provider_options.claude.sandbox.excluded_commands', type: 'json' },
  { path: 'provider_options.claude_terminal.backend', type: 'string' },
  { path: 'provider_options.claude_terminal.timeout_ms', type: 'number' },
  { path: 'provider_options.claude_terminal.keep_session', type: 'boolean' },
  { path: 'provider_options.claude_terminal.transcript_poll_interval_ms', type: 'number' },
  { path: 'provider_options.copilot.effort', type: 'string' },
  { path: 'provider_options.kiro.agent', type: 'string' },
] as const satisfies readonly EnvSpec[];

const PROVIDER_OPTIONS_TRACE_PATH_ENTRIES = [
  'provider_options',
  'provider_options.codex',
  'provider_options.codex.base_url',
  'provider_options.codex.network_access',
  'provider_options.codex.reasoning_effort',
  'provider_options.codex.skills',
  'provider_options.codex.skills.repo',
  'provider_options.codex.skills.user',
  'provider_options.opencode',
  'provider_options.opencode.network_access',
  'provider_options.opencode.variant',
  'provider_options.opencode.allowed_tools',
  'provider_options.opencode.guards',
  'provider_options.opencode.guards.profile',
  'provider_options.opencode.guards.model_profiles',
  'provider_options.opencode.guards.call_timeout_ms',
  'provider_options.opencode.guards.event_limit',
  'provider_options.opencode.guards.text_byte_limit',
  'provider_options.opencode.guards.reasoning_byte_limit',
  'provider_options.claude',
  'provider_options.claude.base_url',
  'provider_options.claude.allowed_tools',
  'provider_options.claude.effort',
  'provider_options.claude.skills',
  'provider_options.claude.skills.enabled',
  'provider_options.claude.sandbox',
  'provider_options.claude.sandbox.allow_unsandboxed_commands',
  'provider_options.claude.sandbox.excluded_commands',
  'provider_options.claude_terminal',
  'provider_options.claude_terminal.backend',
  'provider_options.claude_terminal.timeout_ms',
  'provider_options.claude_terminal.keep_session',
  'provider_options.claude_terminal.transcript_poll_interval_ms',
  'provider_options.copilot',
  'provider_options.copilot.effort',
  'provider_options.kiro',
  'provider_options.kiro.agent',
] as const;

const PROVIDER_OPTIONS_FILE_PREFERRED_ENV_PATH_ENTRIES = [
  'provider_options.codex.base_url',
  'provider_options.claude.base_url',
] as const;

const PROVIDER_OPTIONS_INTERNAL_PATH_ENTRIES = [
  'codex.baseUrl',
  'codex.networkAccess',
  'codex.reasoningEffort',
  'codex.skills.repo',
  'codex.skills.user',
  'opencode.networkAccess',
  'opencode.variant',
  'opencode.allowedTools',
  'opencode.guards.profile',
  'opencode.guards.modelProfiles',
  'opencode.guards.callTimeoutMs',
  'opencode.guards.eventLimit',
  'opencode.guards.textByteLimit',
  'opencode.guards.reasoningByteLimit',
  'claude.baseUrl',
  'claude.allowedTools',
  'claude.effort',
  'claude.sandbox.allowUnsandboxedCommands',
  'claude.sandbox.excludedCommands',
  'claude.skills.enabled',
  'claudeTerminal.backend',
  'claudeTerminal.timeoutMs',
  'claudeTerminal.keepSession',
  'claudeTerminal.transcriptPollIntervalMs',
  'copilot.effort',
  'kiro.agent',
] as const;

export type ProviderOptionsTracePath = (typeof PROVIDER_OPTIONS_TRACE_PATH_ENTRIES)[number];
export type ProviderOptionsInternalPath = (typeof PROVIDER_OPTIONS_INTERNAL_PATH_ENTRIES)[number];

export const PROVIDER_OPTIONS_ENV_SPECS: readonly EnvSpec[] = PROVIDER_OPTIONS_ENV_SPEC_ENTRIES;
export const PROVIDER_OPTIONS_TRACE_PATHS: readonly ProviderOptionsTracePath[] = PROVIDER_OPTIONS_TRACE_PATH_ENTRIES;
export const PROVIDER_OPTIONS_FILE_PREFERRED_ENV_PATHS: readonly ProviderOptionsTracePath[] =
  PROVIDER_OPTIONS_FILE_PREFERRED_ENV_PATH_ENTRIES;
export const PROVIDER_OPTIONS_TRACKED_KEYS = [
  'provider_options',
  'provider_options.codex',
  'provider_options.codex.skills',
  'provider_options.opencode',
  'provider_options.opencode.guards',
  'provider_options.claude',
  'provider_options.claude.skills',
  'provider_options.claude.sandbox',
  'provider_options.claude_terminal',
  'provider_options.copilot',
  'provider_options.kiro',
  ...PROVIDER_OPTIONS_ENV_SPEC_ENTRIES.map((spec) => spec.path).filter((path) => path !== 'provider_options'),
  'provider_options.claude.allowed_tools',
] as const;

export function hasProviderOptionsPath(
  providerOptions: StepProviderOptions | undefined,
  path: string,
): boolean {
  if (!providerOptions) {
    return false;
  }
  if (path.length === 0) {
    return true;
  }

  let current: unknown = providerOptions;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || !(segment in current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current !== undefined;
}

export function getPresentProviderOptionPaths(
  providerOptions: StepProviderOptions | undefined,
): readonly ProviderOptionsInternalPath[] {
  return PROVIDER_OPTIONS_INTERNAL_PATH_ENTRIES.filter((path) => hasProviderOptionsPath(providerOptions, path));
}

export function toProviderOptionsTracePath(path: string): string {
  if (path.length === 0) {
    return 'provider_options';
  }

  const converted = path.split('.').map((segment) => {
    if (segment === 'networkAccess') return 'network_access';
    if (segment === 'allowedTools') return 'allowed_tools';
    if (segment === 'allowUnsandboxedCommands') return 'allow_unsandboxed_commands';
    if (segment === 'excludedCommands') return 'excluded_commands';
    return segment.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  });

  return `provider_options.${converted.join('.')}`;
}
