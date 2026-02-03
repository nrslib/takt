/**
 * Global configuration loader
 *
 * Manages ~/.takt/config.yaml and project-level debug settings.
 * GlobalConfigManager encapsulates the config cache as a singleton.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { GlobalConfigSchema } from '../../../core/models/index.js';
import type { GlobalConfig, DebugConfig, Language } from '../../../core/models/index.js';
import { getGlobalConfigPath, getProjectConfigPath } from '../paths.js';
import { DEFAULT_LANGUAGE } from '../../../shared/constants.js';

/** Create default global configuration (fresh instance each call) */
function createDefaultGlobalConfig(): GlobalConfig {
  return {
    language: DEFAULT_LANGUAGE,
    trustedDirectories: [],
    defaultWorkflow: 'default',
    logLevel: 'info',
    provider: 'claude',
    enableBuiltinWorkflows: true,
  };
}

/**
 * Manages global configuration loading and caching.
 * Singleton — use GlobalConfigManager.getInstance().
 */
export class GlobalConfigManager {
  private static instance: GlobalConfigManager | null = null;
  private cachedConfig: GlobalConfig | null = null;

  private constructor() {}

  static getInstance(): GlobalConfigManager {
    if (!GlobalConfigManager.instance) {
      GlobalConfigManager.instance = new GlobalConfigManager();
    }
    return GlobalConfigManager.instance;
  }

  /** Reset singleton for testing */
  static resetInstance(): void {
    GlobalConfigManager.instance = null;
  }

  /** Invalidate the cached configuration */
  invalidateCache(): void {
    this.cachedConfig = null;
  }

  /** Load global configuration (cached) */
  load(): GlobalConfig {
    if (this.cachedConfig !== null) {
      return this.cachedConfig;
    }
    const configPath = getGlobalConfigPath();
    if (!existsSync(configPath)) {
      const defaultConfig = createDefaultGlobalConfig();
      this.cachedConfig = defaultConfig;
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
      enableBuiltinWorkflows: parsed.enable_builtin_workflows,
      anthropicApiKey: parsed.anthropic_api_key,
      openaiApiKey: parsed.openai_api_key,
      pipeline: parsed.pipeline ? {
        defaultBranchPrefix: parsed.pipeline.default_branch_prefix,
        commitMessageTemplate: parsed.pipeline.commit_message_template,
        prBodyTemplate: parsed.pipeline.pr_body_template,
      } : undefined,
      minimalOutput: parsed.minimal_output,
      bookmarksFile: parsed.bookmarks_file,
      workflowCategoriesFile: parsed.workflow_categories_file,
    };
    this.cachedConfig = config;
    return config;
  }

  /** Save global configuration to disk and invalidate cache */
  save(config: GlobalConfig): void {
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
    if (config.enableBuiltinWorkflows !== undefined) {
      raw.enable_builtin_workflows = config.enableBuiltinWorkflows;
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
    if (config.bookmarksFile) {
      raw.bookmarks_file = config.bookmarksFile;
    }
    if (config.workflowCategoriesFile) {
      raw.workflow_categories_file = config.workflowCategoriesFile;
    }
    writeFileSync(configPath, stringifyYaml(raw), 'utf-8');
    this.invalidateCache();
  }
}

// ---- Backward-compatible module-level functions ----

export function invalidateGlobalConfigCache(): void {
  GlobalConfigManager.getInstance().invalidateCache();
}

export function loadGlobalConfig(): GlobalConfig {
  return GlobalConfigManager.getInstance().load();
}

export function saveGlobalConfig(config: GlobalConfig): void {
  GlobalConfigManager.getInstance().save(config);
}

export function getDisabledBuiltins(): string[] {
  try {
    const config = loadGlobalConfig();
    return config.disabledBuiltins ?? [];
  } catch {
    return [];
  }
}

export function getBuiltinWorkflowsEnabled(): boolean {
  try {
    const config = loadGlobalConfig();
    return config.enableBuiltinWorkflows !== false;
  } catch {
    return true;
  }
}

export function getLanguage(): Language {
  try {
    const config = loadGlobalConfig();
    return config.language;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export function setLanguage(language: Language): void {
  const config = loadGlobalConfig();
  config.language = language;
  saveGlobalConfig(config);
}

export function setProvider(provider: 'claude' | 'codex'): void {
  const config = loadGlobalConfig();
  config.provider = provider;
  saveGlobalConfig(config);
}

export function addTrustedDirectory(dir: string): void {
  const config = loadGlobalConfig();
  const resolvedDir = join(dir);
  if (!config.trustedDirectories.includes(resolvedDir)) {
    config.trustedDirectories.push(resolvedDir);
    saveGlobalConfig(config);
  }
}

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

