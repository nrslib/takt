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
  normalizePieceOverrides,
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
import { sanitizeConfigValue } from './globalConfigLegacyMigration.js';
import { serializeGlobalConfig } from './globalConfigSerializer.js';
export { validateCliPath } from './cliPathValidator.js';

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

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
        const sanitizedParsedRaw = getRecord(sanitizeConfigValue(parsedRaw, 'config'));
        if (!sanitizedParsedRaw) {
          throw new Error('Configuration error: ~/.takt/config.yaml must be a YAML object.');
        }
        for (const [key, value] of Object.entries(sanitizedParsedRaw)) {
          rawConfig[key] = value;
        }
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
      logging: parsed.logging ? {
        level: parsed.logging.level,
        trace: parsed.logging.trace,
        debug: parsed.logging.debug,
        providerEvents: parsed.logging.provider_events,
        usageEvents: parsed.logging.usage_events,
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
    const raw = serializeGlobalConfig(config);
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
