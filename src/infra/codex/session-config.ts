import type { CodexOptions } from '@openai/codex-sdk';
import { buildEnvWithNestedObservabilitySnapshot } from '../../shared/telemetry/index.js';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';
import { CODEX_CONFIG_PROFILE_ENV, type CodexCallOptions } from './types.js';
import { buildCodexSkillConfig } from './skill-config.js';

function removeCodexConfigProfileMarker(environment: Record<string, string>): void {
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === CODEX_CONFIG_PROFILE_ENV.toLowerCase()) {
      delete environment[key];
    }
  }
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
  ) as Record<string, string>;
  removeCodexConfigProfileMarker(codexEnvironment);
  if (options.configProfile !== undefined) {
    codexEnvironment[CODEX_CONFIG_PROFILE_ENV] = options.configProfile;
  }
  const shellPath = codexEnvironment.PATH;
  const codexConfig: CodexOptions['config'] = {
    ...(codexSkillConfig ?? {}),
    ...(options.reasoningEffort === undefined
      ? {}
      : { model_reasoning_effort: options.reasoningEffort }),
    ...(options.fastMode === undefined
      ? {}
      : { features: { fast_mode: options.fastMode } }),
    model_reasoning_summary: 'auto',
    ...(shellPath === undefined
      ? {}
      : {
          shell_environment_policy: {
            set: { PATH: shellPath },
          },
        }),
  };
  return { config: codexConfig, env: codexEnvironment };
}
