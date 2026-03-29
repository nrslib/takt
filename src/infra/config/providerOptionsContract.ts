import type { MovementProviderOptions } from '../../core/models/piece-types.js';
import type { EnvSpec } from './env/config-env-overrides.js';

const PROVIDER_OPTIONS_ENV_SPEC_ENTRIES = [
  { path: 'provider_options', type: 'json' },
  { path: 'provider_options.codex.network_access', type: 'boolean' },
  { path: 'provider_options.opencode.network_access', type: 'boolean' },
  { path: 'provider_options.claude.sandbox.allow_unsandboxed_commands', type: 'boolean' },
  { path: 'provider_options.claude.sandbox.excluded_commands', type: 'json' },
] as const satisfies readonly EnvSpec[];

const PROVIDER_OPTIONS_TRACE_PATH_ENTRIES = [
  'provider_options',
  'provider_options.codex',
  'provider_options.codex.network_access',
  'provider_options.opencode',
  'provider_options.opencode.network_access',
  'provider_options.claude',
  'provider_options.claude.allowed_tools',
  'provider_options.claude.sandbox',
  'provider_options.claude.sandbox.allow_unsandboxed_commands',
  'provider_options.claude.sandbox.excluded_commands',
] as const;

const PROVIDER_OPTIONS_INTERNAL_PATH_ENTRIES = [
  'codex.networkAccess',
  'opencode.networkAccess',
  'claude.allowedTools',
  'claude.sandbox.allowUnsandboxedCommands',
  'claude.sandbox.excludedCommands',
] as const;

export type ProviderOptionsTracePath = (typeof PROVIDER_OPTIONS_TRACE_PATH_ENTRIES)[number];
export type ProviderOptionsInternalPath = (typeof PROVIDER_OPTIONS_INTERNAL_PATH_ENTRIES)[number];

export const PROVIDER_OPTIONS_ENV_SPECS: readonly EnvSpec[] = PROVIDER_OPTIONS_ENV_SPEC_ENTRIES;
export const PROVIDER_OPTIONS_TRACE_PATHS: readonly ProviderOptionsTracePath[] = PROVIDER_OPTIONS_TRACE_PATH_ENTRIES;
export const PROVIDER_OPTIONS_TRACKED_KEYS = [
  'provider_options',
  'provider_options.codex',
  'provider_options.opencode',
  'provider_options.claude',
  'provider_options.claude.sandbox',
  ...PROVIDER_OPTIONS_ENV_SPEC_ENTRIES.map((spec) => spec.path).filter((path) => path !== 'provider_options'),
  'provider_options.claude.allowed_tools',
] as const;

export function hasProviderOptionsPath(
  providerOptions: MovementProviderOptions | undefined,
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
  providerOptions: MovementProviderOptions | undefined,
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
