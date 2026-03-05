import type { GlobalConfig } from '../../../core/models/config-types.js';
import { envVarNameFromPath } from '../env/config-env-overrides.js';
import { loadGlobalConfig, validateCliPath } from './globalConfigCore.js';

export function resolveAnthropicApiKey(): string | undefined {
  const envKey = process.env[envVarNameFromPath('anthropic_api_key')];
  if (envKey) return envKey;

  const config = loadGlobalConfig();
  return config.anthropicApiKey;
}

export function resolveOpenaiApiKey(): string | undefined {
  const envKey = process.env[envVarNameFromPath('openai_api_key')];
  if (envKey) return envKey;

  const config = loadGlobalConfig();
  return config.openaiApiKey;
}

export function resolveCodexCliPath(): string | undefined {
  const envPath = process.env[envVarNameFromPath('codex_cli_path')];
  if (envPath !== undefined) {
    return validateCliPath(envPath, 'TAKT_CODEX_CLI_PATH');
  }

  const config: GlobalConfig = loadGlobalConfig();
  if (config.codexCliPath === undefined) {
    return undefined;
  }
  return validateCliPath(config.codexCliPath, 'codex_cli_path');
}

export function resolveClaudeCliPath(): string | undefined {
  const envPath = process.env[envVarNameFromPath('claude_cli_path')];
  if (envPath !== undefined) {
    return validateCliPath(envPath, 'TAKT_CLAUDE_CLI_PATH');
  }

  const config: GlobalConfig = loadGlobalConfig();
  if (config.claudeCliPath === undefined) {
    return undefined;
  }
  return validateCliPath(config.claudeCliPath, 'claude_cli_path');
}

export function resolveCursorCliPath(): string | undefined {
  const envPath = process.env[envVarNameFromPath('cursor_cli_path')];
  if (envPath !== undefined) {
    return validateCliPath(envPath, 'TAKT_CURSOR_CLI_PATH');
  }

  const config: GlobalConfig = loadGlobalConfig();
  if (config.cursorCliPath === undefined) {
    return undefined;
  }
  return validateCliPath(config.cursorCliPath, 'cursor_cli_path');
}

export function resolveOpencodeApiKey(): string | undefined {
  const envKey = process.env[envVarNameFromPath('opencode_api_key')];
  if (envKey) return envKey;

  const config = loadGlobalConfig();
  return config.opencodeApiKey;
}

export function resolveCursorApiKey(): string | undefined {
  const envKey = process.env[envVarNameFromPath('cursor_api_key')];
  if (envKey) return envKey;

  const config = loadGlobalConfig();
  return config.cursorApiKey;
}

export function resolveCopilotCliPath(): string | undefined {
  const envPath = process.env[envVarNameFromPath('copilot_cli_path')];
  if (envPath !== undefined) {
    return validateCliPath(envPath, 'TAKT_COPILOT_CLI_PATH');
  }

  const config: GlobalConfig = loadGlobalConfig();
  if (config.copilotCliPath === undefined) {
    return undefined;
  }
  return validateCliPath(config.copilotCliPath, 'copilot_cli_path');
}

export function resolveCopilotGithubToken(): string | undefined {
  const envKey = process.env[envVarNameFromPath('copilot_github_token')];
  if (envKey) return envKey;

  const config = loadGlobalConfig();
  return config.copilotGithubToken;
}
