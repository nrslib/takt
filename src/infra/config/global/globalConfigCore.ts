import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { GlobalConfigSchema } from '../../../core/models/index.js';
import type { PersistedGlobalConfig } from '../../../core/models/persisted-global-config.js';
import {
  normalizeConfigProviderReference,
  type ConfigProviderReference,
} from '../providerReference.js';
import {
  normalizeProviderProfiles,
  denormalizeProviderProfiles,
  normalizePieceOverrides,
  denormalizePieceOverrides,
  denormalizeProviderOptions,
} from '../configNormalizers.js';
import { getGlobalConfigPath } from '../paths.js';
import { applyGlobalConfigEnvOverrides } from '../env/config-env-overrides.js';
import { invalidateAllResolvedConfigCache } from '../resolutionCache.js';
import { validateProviderModelCompatibility } from '../providerModelCompatibility.js';
import {
  extractMigratedProjectLocalFallback,
  removeMigratedProjectLocalKeys,
  type GlobalMigratedProjectLocalFallback,
} from './globalMigratedProjectLocalFallback.js';
export { validateCliPath } from './cliPathValidator.js';
type ProviderType = NonNullable<PersistedGlobalConfig['provider']>;
type RawProviderReference = ConfigProviderReference<ProviderType>;
export class GlobalConfigManager {
  private static instance: GlobalConfigManager | null = null;
  private cachedConfig: PersistedGlobalConfig | null = null;
  private cachedMigratedProjectLocalFallback: GlobalMigratedProjectLocalFallback | null = null;
  private constructor() {}

  static getInstance(): GlobalConfigManager {
    if (!GlobalConfigManager.instance) {
      GlobalConfigManager.instance = new GlobalConfigManager();
    }
    return GlobalConfigManager.instance;
  }

  static resetInstance(): void {
    GlobalConfigManager.instance = null;
  }

  invalidateCache(): void {
    this.cachedConfig = null;
    this.cachedMigratedProjectLocalFallback = null;
  }

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
    const migratedProjectLocalFallback = extractMigratedProjectLocalFallback(rawConfig);
    const schemaInput = { ...rawConfig };
    removeMigratedProjectLocalKeys(schemaInput);

    const parsed = GlobalConfigSchema.parse(schemaInput);
    const normalizedProvider = normalizeConfigProviderReference(
      parsed.provider as RawProviderReference,
      parsed.model,
      parsed.provider_options as Record<string, unknown> | undefined,
    );
    const config: PersistedGlobalConfig = {
      language: parsed.language,
      provider: normalizedProvider.provider,
      model: normalizedProvider.model,
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
      geminiApiKey: parsed.gemini_api_key,
      googleApiKey: parsed.google_api_key,
      groqApiKey: parsed.groq_api_key,
      openrouterApiKey: parsed.openrouter_api_key,
      codexCliPath: parsed.codex_cli_path,
      claudeCliPath: parsed.claude_cli_path,
      cursorCliPath: parsed.cursor_cli_path,
      copilotCliPath: parsed.copilot_cli_path,
      copilotGithubToken: parsed.copilot_github_token,
      opencodeApiKey: parsed.opencode_api_key,
      cursorApiKey: parsed.cursor_api_key,
      bookmarksFile: parsed.bookmarks_file,
      pieceCategoriesFile: parsed.piece_categories_file,
      providerOptions: normalizedProvider.providerOptions,
      providerProfiles: normalizeProviderProfiles(parsed.provider_profiles as Record<string, { default_permission_mode: unknown; movement_permission_overrides?: Record<string, unknown> }> | undefined),
      runtime: parsed.runtime?.prepare && parsed.runtime.prepare.length > 0
        ? { prepare: [...new Set(parsed.runtime.prepare)] }
        : undefined,
      preventSleep: parsed.prevent_sleep,
      notificationSound: parsed.notification_sound,
      notificationSoundEvents: parsed.notification_sound_events ? {
        iterationLimit: parsed.notification_sound_events.iteration_limit,
        pieceComplete: parsed.notification_sound_events.piece_complete,
        pieceAbort: parsed.notification_sound_events.piece_abort,
        runComplete: parsed.notification_sound_events.run_complete,
        runAbort: parsed.notification_sound_events.run_abort,
      } : undefined,
      autoFetch: parsed.auto_fetch,
      baseBranch: parsed.base_branch,
      pieceOverrides: normalizePieceOverrides(parsed.piece_overrides as { quality_gates?: string[]; quality_gates_edit_only?: boolean; movements?: Record<string, { quality_gates?: string[] }> } | undefined),
    };
    validateProviderModelCompatibility(config.provider, config.model);
    this.cachedConfig = config;
    this.cachedMigratedProjectLocalFallback = migratedProjectLocalFallback;
    return config;
  }

  loadMigratedProjectLocalFallback(): GlobalMigratedProjectLocalFallback {
    if (this.cachedMigratedProjectLocalFallback !== null) {
      return this.cachedMigratedProjectLocalFallback;
    }
    this.load();
    return this.cachedMigratedProjectLocalFallback ?? {};
  }

  save(config: PersistedGlobalConfig): void {
    const configPath = getGlobalConfigPath();
    const raw: Record<string, unknown> = {
      language: config.language,
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
    if (config.geminiApiKey) {
      raw.gemini_api_key = config.geminiApiKey;
    }
    if (config.googleApiKey) {
      raw.google_api_key = config.googleApiKey;
    }
    if (config.groqApiKey) {
      raw.groq_api_key = config.groqApiKey;
    }
    if (config.openrouterApiKey) {
      raw.openrouter_api_key = config.openrouterApiKey;
    }
    if (config.codexCliPath) {
      raw.codex_cli_path = config.codexCliPath;
    }
    if (config.claudeCliPath) {
      raw.claude_cli_path = config.claudeCliPath;
    }
    if (config.cursorCliPath) {
      raw.cursor_cli_path = config.cursorCliPath;
    }
    if (config.copilotCliPath) {
      raw.copilot_cli_path = config.copilotCliPath;
    }
    if (config.copilotGithubToken) {
      raw.copilot_github_token = config.copilotGithubToken;
    }
    if (config.opencodeApiKey) {
      raw.opencode_api_key = config.opencodeApiKey;
    }
    if (config.cursorApiKey) {
      raw.cursor_api_key = config.cursorApiKey;
    }
    if (config.bookmarksFile) {
      raw.bookmarks_file = config.bookmarksFile;
    }
    if (config.pieceCategoriesFile) {
      raw.piece_categories_file = config.pieceCategoriesFile;
    }
    const rawProviderOptions = denormalizeProviderOptions(config.providerOptions);
    if (rawProviderOptions) {
      raw.provider_options = rawProviderOptions;
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
    if (config.autoFetch) {
      raw.auto_fetch = config.autoFetch;
    }
    if (config.baseBranch) {
      raw.base_branch = config.baseBranch;
    }
    const denormalizedPieceOverrides = denormalizePieceOverrides(config.pieceOverrides);
    if (denormalizedPieceOverrides) {
      raw.piece_overrides = denormalizedPieceOverrides;
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

export function loadGlobalMigratedProjectLocalFallback(): GlobalMigratedProjectLocalFallback {
  return GlobalConfigManager.getInstance().loadMigratedProjectLocalFallback();
}

export function saveGlobalConfig(config: PersistedGlobalConfig): void {
  GlobalConfigManager.getInstance().save(config);
}
