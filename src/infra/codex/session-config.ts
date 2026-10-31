import type { CodexOptions } from '@openai/codex-sdk';
import { buildEnvWithNestedObservabilitySnapshot } from '../../shared/telemetry/index.js';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';
import { CODEX_CONFIG_PROFILE_ENV, CODEX_SPAWN_PROFILE, type CodexCallOptions, type CodexSpawnEnvironment } from './types.js';
import { buildCodexSkillConfig } from './skill-config.js';
import { CODEX_TOOL_PERMISSION_ENDPOINT_ENV, CODEX_TOOL_PERMISSION_TOKEN_ENV } from './tool-permission-hook-protocol.js';

function removeCodexConfigProfileMarker(environment: Record<string, string>): void {
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === CODEX_CONFIG_PROFILE_ENV.toLowerCase()) {
      delete environment[key];
    }
  }
}

export function hasCodexShellEnvironmentFilter(
  filters: Record<string, unknown> | undefined,
  name: string,
): boolean {
  const normalizedName = name.toLowerCase();
  return Object.keys(filters ?? {}).some((key) => key.toLowerCase() === normalizedName);
}

export function buildCodexSessionConfig(options: CodexCallOptions): {
  config: NonNullable<CodexOptions['config']>;
  env: Record<string, string>;
} {
  const skillScopes = options.mcpOnlySideEffects ? { repo: false, user: false } : options.skills;
  let codexSkillConfig = skillScopes
    ? buildCodexSkillConfig({
        cwd: options.cwd,
        env: { ...buildChildProcessEnv(), ...options.childProcessEnv },
        inheritance: skillScopes,
      })
    : undefined;

  // Runtime MCP adapter route (issue #1137): merge prepared MCP `mcp_servers`
  // into the Codex CLI config so resolved servers become the thread's
  // effective MCP set (order.md:177-182). The adapter materializes the
  // provider-native config shape; cast through `unknown` because the SDK's
  // `CodexConfigValue` is not exported and the structure is provider-native.
  const preparedMcpConfig = options.preparedMcp?.config;
  if (preparedMcpConfig?.mcp_servers !== undefined) {
    codexSkillConfig = {
      ...(codexSkillConfig ?? {}),
      mcp_servers: preparedMcpConfig.mcp_servers,
    } as unknown as CodexOptions['config'];
  }

  const codexEnvironment = buildEnvWithNestedObservabilitySnapshot(
    buildChildProcessEnv(),
    options.childProcessEnv,
  ) as CodexSpawnEnvironment;
  const headerFilters = preparedMcpConfig?.shell_environment_policy?.filters;
  for (const name of Object.keys(headerFilters ?? {})) {
    const value = options.childProcessEnv?.[name];
    if (value !== undefined) codexEnvironment[name] = value;
  }
  const referencesProfileEnv = hasCodexShellEnvironmentFilter(headerFilters, CODEX_CONFIG_PROFILE_ENV);
  if (referencesProfileEnv) {
    codexEnvironment[CODEX_SPAWN_PROFILE] = {
      ...(options.configProfile === undefined ? {} : { configProfile: options.configProfile }),
    };
  } else {
    removeCodexConfigProfileMarker(codexEnvironment);
    if (options.configProfile !== undefined) {
      codexEnvironment[CODEX_CONFIG_PROFILE_ENV] = options.configProfile;
    }
  }
  // Hook credentials are supplied only by its command, never by the Codex process environment.
  for (const key of [CODEX_TOOL_PERMISSION_ENDPOINT_ENV, CODEX_TOOL_PERMISSION_TOKEN_ENV]) {
    delete codexEnvironment[key];
  }
  const shellPath = codexEnvironment.PATH;
  const excludesPath = hasCodexShellEnvironmentFilter(headerFilters, 'PATH');
  const shellPolicy = {
    ...(shellPath === undefined || excludesPath ? {} : { set: { PATH: shellPath } }),
    ...(headerFilters === undefined ? {} : { filters: headerFilters }),
  };
  const codexConfig: CodexOptions['config'] = {
    ...(codexSkillConfig ?? {}),
    ...(options.reasoningEffort === undefined
      ? {}
      : { model_reasoning_effort: options.reasoningEffort }),
    ...((options.fastMode !== undefined || options.internalAgentIsolation === 'strict-readonly') ? {
      features: {
        ...(codexSkillConfig?.features as Record<string, boolean> | undefined),
        ...(options.fastMode === undefined ? {} : { fast_mode: options.fastMode }),
        ...(options.internalAgentIsolation === 'strict-readonly' ? { hooks: false } : {}),
      },
    } : {}),
    model_reasoning_summary: 'auto',
    ...(Object.keys(shellPolicy).length === 0
      ? {}
      : {
          shell_environment_policy: shellPolicy,
        }),
  };
  return { config: codexConfig, env: codexEnvironment };
}
