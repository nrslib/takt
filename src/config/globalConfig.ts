/**
 * Global configuration loader
 *
 * Manages ~/.takt/config.yaml and project-level debug settings.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { GlobalConfigSchema } from '../models/schemas.js';
import type { GlobalConfig, DebugConfig, Language } from '../models/types.js';
import { getGlobalConfigPath, getProjectConfigPath } from './paths.js';
import { DEFAULT_LANGUAGE } from '../constants.js';

/** Create default global configuration (fresh instance each call) */
function createDefaultGlobalConfig(): GlobalConfig {
  return {
    language: DEFAULT_LANGUAGE,
    trustedDirectories: [],
    defaultWorkflow: 'default',
    logLevel: 'info',
    provider: 'claude',
  };
}

/** Module-level cache for global configuration */
let cachedConfig: GlobalConfig | null = null;

/** Invalidate the cached global configuration (call after mutation) */
export function invalidateGlobalConfigCache(): void {
  cachedConfig = null;
}

/** Load global configuration */
export function loadGlobalConfig(): GlobalConfig {
  if (cachedConfig !== null) {
    return cachedConfig;
  }
  const configPath = getGlobalConfigPath();
  if (!existsSync(configPath)) {
    const defaultConfig = createDefaultGlobalConfig();
    cachedConfig = defaultConfig;
    return defaultConfig;
  }
  const content = readFileSync(configPath, 'utf-8');
  const raw = parseYaml(content);
  const parsed = GlobalConfigSchema.parse(raw);
  const config: GlobalConfig = {
    language: parsed.language,
    trustedDirectories: parsed.trusted_directories,
    defaultWorkflow: parsed.default_workflow,
    logLevel: parsed.log_level,
    provider: parsed.provider,
    model: parsed.model,
    debug: parsed.debug ? {
      enabled: parsed.debug.enabled,
      logFile: parsed.debug.log_file,
    } : undefined,
    worktreeDir: parsed.worktree_dir,
    disabledBuiltins: parsed.disabled_builtins,
    anthropicApiKey: parsed.anthropic_api_key,
    openaiApiKey: parsed.openai_api_key,
    pipeline: parsed.pipeline ? {
      defaultBranchPrefix: parsed.pipeline.default_branch_prefix,
      commitMessageTemplate: parsed.pipeline.commit_message_template,
      prBodyTemplate: parsed.pipeline.pr_body_template,
    } : undefined,
    minimalOutput: parsed.minimal_output,
  };
  cachedConfig = config;
  return config;
}

/** Save global configuration */
export function saveGlobalConfig(config: GlobalConfig): void {
  const configPath = getGlobalConfigPath();
  const raw: Record<string, unknown> = {
    language: config.language,
    trusted_directories: config.trustedDirectories,
    default_workflow: config.defaultWorkflow,
    log_level: config.logLevel,
    provider: config.provider,
  };
  if (config.model) {
    raw.model = config.model;
  }
  if (config.debug) {
    raw.debug = {
      enabled: config.debug.enabled,
      log_file: config.debug.logFile,
    };
  }
  if (config.worktreeDir) {
    raw.worktree_dir = config.worktreeDir;
  }
  if (config.disabledBuiltins && config.disabledBuiltins.length > 0) {
    raw.disabled_builtins = config.disabledBuiltins;
  }
  if (config.anthropicApiKey) {
    raw.anthropic_api_key = config.anthropicApiKey;
  }
  if (config.openaiApiKey) {
    raw.openai_api_key = config.openaiApiKey;
  }
  if (config.pipeline) {
    const pipelineRaw: Record<string, unknown> = {};
    if (config.pipeline.defaultBranchPrefix) pipelineRaw.default_branch_prefix = config.pipeline.defaultBranchPrefix;
    if (config.pipeline.commitMessageTemplate) pipelineRaw.commit_message_template = config.pipeline.commitMessageTemplate;
    if (config.pipeline.prBodyTemplate) pipelineRaw.pr_body_template = config.pipeline.prBodyTemplate;
    if (Object.keys(pipelineRaw).length > 0) {
      raw.pipeline = pipelineRaw;
    }
  }
  if (config.minimalOutput !== undefined) {
    raw.minimal_output = config.minimalOutput;
  }
  writeFileSync(configPath, stringifyYaml(raw), 'utf-8');
  invalidateGlobalConfigCache();
}

/** Get list of disabled builtin names */
export function getDisabledBuiltins(): string[] {
  try {
    const config = loadGlobalConfig();
    return config.disabledBuiltins ?? [];
  } catch {
    return [];
  }
}

/** Get current language setting */
export function getLanguage(): Language {
  try {
    const config = loadGlobalConfig();
    return config.language;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

/** Set language setting */
export function setLanguage(language: Language): void {
  const config = loadGlobalConfig();
  config.language = language;
  saveGlobalConfig(config);
}

/** Set provider setting */
export function setProvider(provider: 'claude' | 'codex'): void {
  const config = loadGlobalConfig();
  config.provider = provider;
  saveGlobalConfig(config);
}

/** Add a trusted directory */
export function addTrustedDirectory(dir: string): void {
  const config = loadGlobalConfig();
  const resolvedDir = join(dir);
  if (!config.trustedDirectories.includes(resolvedDir)) {
    config.trustedDirectories.push(resolvedDir);
    saveGlobalConfig(config);
  }
}

/** Check if a directory is trusted */
export function isDirectoryTrusted(dir: string): boolean {
  const config = loadGlobalConfig();
  const resolvedDir = join(dir);
  return config.trustedDirectories.some(
    (trusted) => resolvedDir === trusted || resolvedDir.startsWith(trusted + '/')
  );
}

/**
 * Resolve the Anthropic API key.
 * Priority: TAKT_ANTHROPIC_API_KEY env var > config.yaml > undefined (CLI auth fallback)
 */
export function resolveAnthropicApiKey(): string | undefined {
  const envKey = process.env['TAKT_ANTHROPIC_API_KEY'];
  if (envKey) return envKey;

  try {
    const config = loadGlobalConfig();
    return config.anthropicApiKey;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the OpenAI API key.
 * Priority: TAKT_OPENAI_API_KEY env var > config.yaml > undefined (CLI auth fallback)
 */
export function resolveOpenaiApiKey(): string | undefined {
  const envKey = process.env['TAKT_OPENAI_API_KEY'];
  if (envKey) return envKey;

  try {
    const config = loadGlobalConfig();
    return config.openaiApiKey;
  } catch {
    return undefined;
  }
}

/** Load project-level debug configuration (from .takt/config.yaml) */
export function loadProjectDebugConfig(projectDir: string): DebugConfig | undefined {
  const configPath = getProjectConfigPath(projectDir);
  if (!existsSync(configPath)) {
    return undefined;
  }
  try {
    const content = readFileSync(configPath, 'utf-8');
    const raw = parseYaml(content);
    if (raw && typeof raw === 'object' && 'debug' in raw) {
      const debug = raw.debug;
      if (debug && typeof debug === 'object') {
        return {
          enabled: Boolean(debug.enabled),
          logFile: typeof debug.log_file === 'string' ? debug.log_file : undefined,
        };
      }
    }
  } catch {
    // Ignore parse errors
  }
  return undefined;
}

/** Get effective debug config (project overrides global) */
export function getEffectiveDebugConfig(projectDir?: string): DebugConfig | undefined {
  const globalConfig = loadGlobalConfig();
  let debugConfig = globalConfig.debug;

  if (projectDir) {
    const projectDebugConfig = loadProjectDebugConfig(projectDir);
    if (projectDebugConfig) {
      debugConfig = projectDebugConfig;
    }
  }

  return debugConfig;
}
