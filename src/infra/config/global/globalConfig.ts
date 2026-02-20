/**
 * Global configuration loader
 *
 * Manages ~/.takt/config.yaml.
 * GlobalConfigManager encapsulates the config cache as a singleton.
 */

import { readFileSync, existsSync, writeFileSync, statSync, accessSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { GlobalConfigSchema } from '../../../core/models/index.js';
import type { Language } from '../../../core/models/index.js';
import type { PersistedGlobalConfig, PersonaProviderEntry } from '../../../core/models/persisted-global-config.js';
import type { ProviderPermissionProfiles } from '../../../core/models/provider-profiles.js';
import { normalizeProviderOptions } from '../loaders/pieceParser.js';
import { getGlobalConfigPath } from '../paths.js';
import { DEFAULT_LANGUAGE } from '../../../shared/constants.js';
import { parseProviderModel } from '../../../shared/utils/providerModel.js';
import { applyGlobalConfigEnvOverrides, envVarNameFromPath } from '../env/config-env-overrides.js';
import { invalidateAllResolvedConfigCache } from '../resolutionCache.js';

/** Claude-specific model aliases that are not valid for other providers */
const CLAUDE_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function validateCodexCliPath(pathValue: string, sourceName: 'TAKT_CODEX_CLI_PATH' | 'codex_cli_path'): string {
  const trimmed = pathValue.trim();
  if (trimmed.length === 0) {
    throw new Error(`Configuration error: ${sourceName} must not be empty.`);
  }
  if (hasControlCharacters(trimmed)) {
    throw new Error(`Configuration error: ${sourceName} contains control characters.`);
  }
  if (!isAbsolute(trimmed)) {
    throw new Error(`Configuration error: ${sourceName} must be an absolute path: ${trimmed}`);
  }
  if (!existsSync(trimmed)) {
    throw new Error(`Configuration error: ${sourceName} path does not exist: ${trimmed}`);
  }
  const stats = statSync(trimmed);
  if (!stats.isFile()) {
    throw new Error(`Configuration error: ${sourceName} must point to an executable file: ${trimmed}`);
  }
  try {
    accessSync(trimmed, constants.X_OK);
  } catch {
    throw new Error(`Configuration error: ${sourceName} file is not executable: ${trimmed}`);
  }
  return trimmed;
}

function validateProviderModelCompatibility(provider: string | undefined, model: string | undefined): void {
  if (!provider) return;

  if (provider === 'opencode' && !model) {
    throw new Error(
      "Configuration error: provider 'opencode' requires model in 'provider/model' format (e.g. 'opencode/big-pickle')."
    );
  }

  if (!model) return;

  if ((provider === 'codex' || provider === 'opencode') && CLAUDE_MODEL_ALIASES.has(model)) {
    throw new Error(
      `Configuration error: model '${model}' is a Claude model alias but provider is '${provider}'. ` +
      `Either change the provider to 'claude' or specify a ${provider}-compatible model.`
    );
  }

  if (provider === 'opencode') {
    parseProviderModel(model, "Configuration error: model");
  }
}

function normalizePersonaProviders(
  raw: Record<string, NonNullable<PersonaProviderEntry['provider']> | PersonaProviderEntry> | undefined,
): Record<string, PersonaProviderEntry> | undefined {
  if (!raw) return undefined;
  return Object.fromEntries(
    Object.entries(raw).map(([persona, entry]) => {
      const normalized: PersonaProviderEntry = typeof entry === 'string' ? { provider: entry } : entry;
      validateProviderModelCompatibility(normalized.provider, normalized.model);
      return [persona, normalized];
    }),
  );
}

function normalizeProviderProfiles(
  raw: Record<string, { default_permission_mode: unknown; movement_permission_overrides?: Record<string, unknown> }> | undefined,
): ProviderPermissionProfiles | undefined {
  if (!raw) return undefined;

  const entries = Object.entries(raw).map(([provider, profile]) => [provider, {
    defaultPermissionMode: profile.default_permission_mode,
    movementPermissionOverrides: profile.movement_permission_overrides,
  }]);

  return Object.fromEntries(entries) as ProviderPermissionProfiles;
}

function denormalizeProviderProfiles(
  profiles: ProviderPermissionProfiles | undefined,
): Record<string, { default_permission_mode: string; movement_permission_overrides?: Record<string, string> }> | undefined {
  if (!profiles) return undefined;
  const entries = Object.entries(profiles);
  if (entries.length === 0) return undefined;

  return Object.fromEntries(entries.map(([provider, profile]) => [provider, {
    default_permission_mode: profile.defaultPermissionMode,
    ...(profile.movementPermissionOverrides
      ? { movement_permission_overrides: profile.movementPermissionOverrides }
      : {}),
  }])) as Record<string, { default_permission_mode: string; movement_permission_overrides?: Record<string, string> }>;
}

/**
 * Manages global configuration loading and caching.
 * Singleton — use GlobalConfigManager.getInstance().
 */
export class GlobalConfigManager {
  private static instance: GlobalConfigManager | null = null;
  private cachedConfig: PersistedGlobalConfig | null = null;

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
  load(): PersistedGlobalConfig {
    if (this.cachedConfig !== null) {
      return this.cachedConfig;
    }
    const configPath = getGlobalConfigPath();

    const rawConfig: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, 'utf-8');
      const parsedRaw = parseYaml(content);
      if (parsedRaw && typeof parsedRaw === 'object' && !Array.isArray(parsedRaw)) {
        Object.assign(rawConfig, parsedRaw as Record<string, unknown>);
      } else if (parsedRaw != null) {
        throw new Error('Configuration error: ~/.takt/config.yaml must be a YAML object.');
      }
    }

    applyGlobalConfigEnvOverrides(rawConfig);

    const parsed = GlobalConfigSchema.parse(rawConfig);
    const config: PersistedGlobalConfig = {
      language: parsed.language,
      logLevel: parsed.log_level,
      provider: parsed.provider,
      model: parsed.model,
      observability: parsed.observability ? {
        providerEvents: parsed.observability.provider_events,
      } : undefined,
      analytics: parsed.analytics ? {
        enabled: parsed.analytics.enabled,
        eventsPath: parsed.analytics.events_path,
        retentionDays: parsed.analytics.retention_days,
      } : undefined,
      worktreeDir: parsed.worktree_dir,
      autoPr: parsed.auto_pr,
      draftPr: parsed.draft_pr,
      disabledBuiltins: parsed.disabled_builtins,
      enableBuiltinPieces: parsed.enable_builtin_pieces,
      anthropicApiKey: parsed.anthropic_api_key,
      openaiApiKey: parsed.openai_api_key,
      codexCliPath: parsed.codex_cli_path,
      opencodeApiKey: parsed.opencode_api_key,
      pipeline: parsed.pipeline ? {
        defaultBranchPrefix: parsed.pipeline.default_branch_prefix,
        commitMessageTemplate: parsed.pipeline.commit_message_template,
        prBodyTemplate: parsed.pipeline.pr_body_template,
      } : undefined,
      minimalOutput: parsed.minimal_output,
      bookmarksFile: parsed.bookmarks_file,
      pieceCategoriesFile: parsed.piece_categories_file,
      personaProviders: normalizePersonaProviders(parsed.persona_providers as Record<string, NonNullable<PersonaProviderEntry['provider']> | PersonaProviderEntry> | undefined),
      providerOptions: normalizeProviderOptions(parsed.provider_options),
      providerProfiles: normalizeProviderProfiles(parsed.provider_profiles as Record<string, { default_permission_mode: unknown; movement_permission_overrides?: Record<string, unknown> }> | undefined),
      runtime: parsed.runtime?.prepare && parsed.runtime.prepare.length > 0
        ? { prepare: [...new Set(parsed.runtime.prepare)] }
        : undefined,
      branchNameStrategy: parsed.branch_name_strategy,
      preventSleep: parsed.prevent_sleep,
      notificationSound: parsed.notification_sound,
      notificationSoundEvents: parsed.notification_sound_events ? {
        iterationLimit: parsed.notification_sound_events.iteration_limit,
        pieceComplete: parsed.notification_sound_events.piece_complete,
        pieceAbort: parsed.notification_sound_events.piece_abort,
        runComplete: parsed.notification_sound_events.run_complete,
        runAbort: parsed.notification_sound_events.run_abort,
      } : undefined,
      interactivePreviewMovements: parsed.interactive_preview_movements,
      verbose: parsed.verbose,
      concurrency: parsed.concurrency,
      taskPollIntervalMs: parsed.task_poll_interval_ms,
    };
    validateProviderModelCompatibility(config.provider, config.model);
    this.cachedConfig = config;
    return config;
  }

  /** Save global configuration to disk and invalidate cache */
  save(config: PersistedGlobalConfig): void {
    const configPath = getGlobalConfigPath();
    const raw: Record<string, unknown> = {
      language: config.language,
      log_level: config.logLevel,
      provider: config.provider,
    };
    if (config.model) {
      raw.model = config.model;
    }
    if (config.observability && config.observability.providerEvents !== undefined) {
      raw.observability = {
        provider_events: config.observability.providerEvents,
      };
    }
    if (config.analytics) {
      const analyticsRaw: Record<string, unknown> = {};
      if (config.analytics.enabled !== undefined) analyticsRaw.enabled = config.analytics.enabled;
      if (config.analytics.eventsPath) analyticsRaw.events_path = config.analytics.eventsPath;
      if (config.analytics.retentionDays !== undefined) analyticsRaw.retention_days = config.analytics.retentionDays;
      if (Object.keys(analyticsRaw).length > 0) {
        raw.analytics = analyticsRaw;
      }
    }
    if (config.worktreeDir) {
      raw.worktree_dir = config.worktreeDir;
    }
    if (config.autoPr !== undefined) {
      raw.auto_pr = config.autoPr;
    }
    if (config.draftPr !== undefined) {
      raw.draft_pr = config.draftPr;
    }
    if (config.disabledBuiltins && config.disabledBuiltins.length > 0) {
      raw.disabled_builtins = config.disabledBuiltins;
    }
    if (config.enableBuiltinPieces !== undefined) {
      raw.enable_builtin_pieces = config.enableBuiltinPieces;
    }
    if (config.anthropicApiKey) {
      raw.anthropic_api_key = config.anthropicApiKey;
    }
    if (config.openaiApiKey) {
      raw.openai_api_key = config.openaiApiKey;
    }
    if (config.codexCliPath) {
      raw.codex_cli_path = config.codexCliPath;
    }
    if (config.opencodeApiKey) {
      raw.opencode_api_key = config.opencodeApiKey;
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
    if (config.pieceCategoriesFile) {
      raw.piece_categories_file = config.pieceCategoriesFile;
    }
    if (config.personaProviders && Object.keys(config.personaProviders).length > 0) {
      raw.persona_providers = config.personaProviders;
    }
    const rawProviderProfiles = denormalizeProviderProfiles(config.providerProfiles);
    if (rawProviderProfiles && Object.keys(rawProviderProfiles).length > 0) {
      raw.provider_profiles = rawProviderProfiles;
    }
    if (config.runtime?.prepare && config.runtime.prepare.length > 0) {
      raw.runtime = {
        prepare: [...new Set(config.runtime.prepare)],
      };
    }
    if (config.branchNameStrategy) {
      raw.branch_name_strategy = config.branchNameStrategy;
    }
    if (config.preventSleep !== undefined) {
      raw.prevent_sleep = config.preventSleep;
    }
    if (config.notificationSound !== undefined) {
      raw.notification_sound = config.notificationSound;
    }
    if (config.notificationSoundEvents) {
      const eventRaw: Record<string, unknown> = {};
      if (config.notificationSoundEvents.iterationLimit !== undefined) {
        eventRaw.iteration_limit = config.notificationSoundEvents.iterationLimit;
      }
      if (config.notificationSoundEvents.pieceComplete !== undefined) {
        eventRaw.piece_complete = config.notificationSoundEvents.pieceComplete;
      }
      if (config.notificationSoundEvents.pieceAbort !== undefined) {
        eventRaw.piece_abort = config.notificationSoundEvents.pieceAbort;
      }
      if (config.notificationSoundEvents.runComplete !== undefined) {
        eventRaw.run_complete = config.notificationSoundEvents.runComplete;
      }
      if (config.notificationSoundEvents.runAbort !== undefined) {
        eventRaw.run_abort = config.notificationSoundEvents.runAbort;
      }
      if (Object.keys(eventRaw).length > 0) {
        raw.notification_sound_events = eventRaw;
      }
    }
    if (config.interactivePreviewMovements !== undefined) {
      raw.interactive_preview_movements = config.interactivePreviewMovements;
    }
    if (config.verbose !== undefined) {
      raw.verbose = config.verbose;
    }
    if (config.concurrency !== undefined && config.concurrency > 1) {
      raw.concurrency = config.concurrency;
    }
    if (config.taskPollIntervalMs !== undefined && config.taskPollIntervalMs !== 500) {
      raw.task_poll_interval_ms = config.taskPollIntervalMs;
    }
    writeFileSync(configPath, stringifyYaml(raw), 'utf-8');
    this.invalidateCache();
    invalidateAllResolvedConfigCache();
  }
}

export function invalidateGlobalConfigCache(): void {
  GlobalConfigManager.getInstance().invalidateCache();
  invalidateAllResolvedConfigCache();
}

export function loadGlobalConfig(): PersistedGlobalConfig {
  return GlobalConfigManager.getInstance().load();
}

export function saveGlobalConfig(config: PersistedGlobalConfig): void {
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

export function getBuiltinPiecesEnabled(): boolean {
  try {
    const config = loadGlobalConfig();
    return config.enableBuiltinPieces !== false;
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

export function setProvider(provider: 'claude' | 'codex' | 'opencode'): void {
  const config = loadGlobalConfig();
  config.provider = provider;
  saveGlobalConfig(config);
}

/**
 * Resolve the Anthropic API key.
 * Priority: TAKT_ANTHROPIC_API_KEY env var > config.yaml > undefined (CLI auth fallback)
 */
export function resolveAnthropicApiKey(): string | undefined {
  const envKey = process.env[envVarNameFromPath('anthropic_api_key')];
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
  const envKey = process.env[envVarNameFromPath('openai_api_key')];
  if (envKey) return envKey;

  try {
    const config = loadGlobalConfig();
    return config.openaiApiKey;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Codex CLI path override.
 * Priority: TAKT_CODEX_CLI_PATH env var > config.yaml > undefined (SDK vendored binary fallback)
 */
export function resolveCodexCliPath(): string | undefined {
  const envPath = process.env[envVarNameFromPath('codex_cli_path')];
  if (envPath !== undefined) {
    return validateCodexCliPath(envPath, 'TAKT_CODEX_CLI_PATH');
  }

  let config: PersistedGlobalConfig;
  try {
    config = loadGlobalConfig();
  } catch {
    return undefined;
  }
  if (config.codexCliPath === undefined) {
    return undefined;
  }
  return validateCodexCliPath(config.codexCliPath, 'codex_cli_path');
}

/**
 * Resolve the OpenCode API key.
 * Priority: TAKT_OPENCODE_API_KEY env var > config.yaml > undefined
 */
export function resolveOpencodeApiKey(): string | undefined {
  const envKey = process.env[envVarNameFromPath('opencode_api_key')];
  if (envKey) return envKey;

  try {
    const config = loadGlobalConfig();
    return config.opencodeApiKey;
  } catch {
    return undefined;
  }
}
