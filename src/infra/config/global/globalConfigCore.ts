import { writeFileSync } from 'node:fs';
import { stringify as stringifyYaml } from 'yaml';
import { GlobalConfigSchema } from '../../../core/models/index.js';
import type { GlobalConfig } from '../../../core/models/config-types.js';
import {
  normalizeConfigProviderReference,
  type ConfigProviderReference,
} from '../providerReference.js';
import {
  normalizeProviderProfiles,
  normalizePieceOverrides,
  normalizePipelineConfig,
  normalizePersonaProviders,
  normalizeTaktProviders,
  buildRawTaktProvidersOrThrow,
  normalizeRuntime,
} from '../configNormalizers.js';
import {
  resolveAliasedPreviewCount,
  resolveAliasedConfigKey,
  resolveAliasedNotificationSoundEvents,
  type RawProviderPermissionProfile,
} from '../configKeyAliases.js';
import { getGlobalConfigPath } from '../paths.js';
import { invalidateAllResolvedConfigCache } from '../resolutionCache.js';
import { validateProviderModelCompatibility } from '../providerModelCompatibility.js';
import { expandOptionalHomePath } from '../pathExpansion.js';
import { sanitizeConfigValue } from './globalConfigLegacyMigration.js';
import { serializeGlobalConfig } from './globalConfigSerializer.js';
import { loadGlobalConfigTrace, type ConfigTrace } from '../traced/tracedConfigLoader.js';
import { warnLegacyGlobalConfigYamlKeysOncePerProcess } from '../legacy-workflow-key-deprecation.js';
export { validateCliPath } from './cliPathValidator.js';

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function assertNoUnknownGlobalConfigKeys(rawConfig: Record<string, unknown>): void {
  const parsedResult = GlobalConfigSchema.safeParse(rawConfig);
  if (parsedResult.success) {
    return;
  }
  const issue = parsedResult.error.issues.find((candidate) => candidate.code === 'unrecognized_keys');
  if (!issue) {
    return;
  }
  throw new Error(issue.message);
}

type ProviderType = NonNullable<GlobalConfig['provider']>;
type RawProviderReference = ConfigProviderReference<ProviderType>;
export class GlobalConfigManager {
  private static instance: GlobalConfigManager | null = null;
  private cachedConfig: GlobalConfig | null = null;
  private cachedTrace: ConfigTrace | null = null;
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
    this.cachedTrace = null;
  }

  load(): GlobalConfig {
    if (this.cachedConfig !== null) {
      return this.cachedConfig;
    }
    const configPath = getGlobalConfigPath();

    const { parsedConfig, rawConfig, trace } = loadGlobalConfigTrace(
      configPath,
      (value: unknown) => {
        if (value == null) {
          return value;
        }
        const sanitized = getRecord(sanitizeConfigValue(value, 'config'));
        if (!sanitized) {
          throw new Error('Configuration error: ~/.takt/config.yaml must be a YAML object.');
        }
        return sanitized;
      },
    );
    warnLegacyGlobalConfigYamlKeysOncePerProcess(parsedConfig);
    assertNoUnknownGlobalConfigKeys(parsedConfig);
    const parsed = GlobalConfigSchema.parse(rawConfig);
    const normalizedProvider = normalizeConfigProviderReference(
      parsed.provider as RawProviderReference,
      parsed.model,
      parsed.provider_options as Record<string, unknown> | undefined,
    );
    const parsedRecord = parsed as Record<string, unknown>;
    const resolvedEnableBuiltinWorkflows = resolveAliasedConfigKey<boolean>(
      '~/.takt/config.yaml',
      parsedRecord,
      'enable_builtin_workflows',
      'enable_builtin_pieces',
    );
    const resolvedWorkflowCategoriesFile = resolveAliasedConfigKey<string>(
      '~/.takt/config.yaml',
      parsedRecord,
      'workflow_categories_file',
      'piece_categories_file',
    );
    const resolvedPieceRuntimePrepare = resolveAliasedConfigKey<{ custom_scripts?: boolean }>(
      '~/.takt/config.yaml',
      parsedRecord,
      'workflow_runtime_prepare',
      'piece_runtime_prepare',
    );
    const resolvedPieceArpeggio = resolveAliasedConfigKey<{
      custom_data_source_modules?: boolean;
      custom_merge_inline_js?: boolean;
      custom_merge_files?: boolean;
    }>(
      '~/.takt/config.yaml',
      parsedRecord,
      'workflow_arpeggio',
      'piece_arpeggio',
    );
    const resolvedPieceMcpServers = resolveAliasedConfigKey<{ stdio?: boolean; sse?: boolean; http?: boolean }>(
      '~/.takt/config.yaml',
      parsedRecord,
      'workflow_mcp_servers',
      'piece_mcp_servers',
    );
    const resolvedNotificationSoundEvents = resolveAliasedNotificationSoundEvents(
      '~/.takt/config.yaml',
      parsed.notification_sound_events as Record<string, unknown> | undefined,
    );
    const resolvedPieceOverrides = resolveAliasedConfigKey(
      '~/.takt/config.yaml',
      parsedRecord,
      'workflow_overrides',
      'piece_overrides',
    ) as {
      quality_gates?: string[];
      quality_gates_edit_only?: boolean;
      movements?: Record<string, { quality_gates?: string[] }>;
      steps?: Record<string, { quality_gates?: string[] }>;
      personas?: Record<string, { quality_gates?: string[] }>;
    } | undefined;
    const config: GlobalConfig = {
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
        eventsPath: expandOptionalHomePath(parsed.analytics.events_path),
        retentionDays: parsed.analytics.retention_days,
      } : undefined,
      worktreeDir: expandOptionalHomePath(parsed.worktree_dir),
      allowGitHooks: parsed.allow_git_hooks,
      allowGitFilters: parsed.allow_git_filters,
      vcsProvider: parsed.vcs_provider as GlobalConfig['vcsProvider'],
      autoPr: parsed.auto_pr,
      draftPr: parsed.draft_pr,
      disabledBuiltins: parsed.disabled_builtins,
      enableBuiltinPieces: resolvedEnableBuiltinWorkflows,
      anthropicApiKey: parsed.anthropic_api_key,
      openaiApiKey: parsed.openai_api_key,
      geminiApiKey: parsed.gemini_api_key,
      googleApiKey: parsed.google_api_key,
      groqApiKey: parsed.groq_api_key,
      openrouterApiKey: parsed.openrouter_api_key,
      codexCliPath: expandOptionalHomePath(parsed.codex_cli_path),
      claudeCliPath: expandOptionalHomePath(parsed.claude_cli_path),
      cursorCliPath: expandOptionalHomePath(parsed.cursor_cli_path),
      copilotCliPath: expandOptionalHomePath(parsed.copilot_cli_path),
      copilotGithubToken: parsed.copilot_github_token,
      opencodeApiKey: parsed.opencode_api_key,
      cursorApiKey: parsed.cursor_api_key,
      bookmarksFile: expandOptionalHomePath(parsed.bookmarks_file),
      pieceCategoriesFile: expandOptionalHomePath(resolvedWorkflowCategoriesFile),
      providerOptions: normalizedProvider.providerOptions,
      providerProfiles: normalizeProviderProfiles(
        parsed.provider_profiles as Record<string, RawProviderPermissionProfile> | undefined,
      ),
      runtime: normalizeRuntime(parsed.runtime),
      pieceRuntimePrepare: resolvedPieceRuntimePrepare ? {
        customScripts: resolvedPieceRuntimePrepare.custom_scripts,
      } : undefined,
      pieceArpeggio: resolvedPieceArpeggio ? {
        customDataSourceModules: resolvedPieceArpeggio.custom_data_source_modules,
        customMergeInlineJs: resolvedPieceArpeggio.custom_merge_inline_js,
        customMergeFiles: resolvedPieceArpeggio.custom_merge_files,
      } : undefined,
      syncConflictResolver: parsed.sync_conflict_resolver ? {
        autoApproveTools: parsed.sync_conflict_resolver.auto_approve_tools,
      } : undefined,
      pieceMcpServers: resolvedPieceMcpServers ? {
        stdio: resolvedPieceMcpServers.stdio,
        sse: resolvedPieceMcpServers.sse,
        http: resolvedPieceMcpServers.http,
      } : undefined,
      preventSleep: parsed.prevent_sleep,
      notificationSound: parsed.notification_sound,
      notificationSoundEvents: resolvedNotificationSoundEvents ? {
        iterationLimit: resolvedNotificationSoundEvents.iteration_limit as boolean | undefined,
        pieceComplete: resolvedNotificationSoundEvents.piece_complete as boolean | undefined,
        pieceAbort: resolvedNotificationSoundEvents.piece_abort as boolean | undefined,
        runComplete: resolvedNotificationSoundEvents.run_complete as boolean | undefined,
        runAbort: resolvedNotificationSoundEvents.run_abort as boolean | undefined,
      } : undefined,
      autoFetch: parsed.auto_fetch,
      baseBranch: parsed.base_branch,
      pieceOverrides: normalizePieceOverrides(resolvedPieceOverrides),
      // Project-local keys (also accepted in global config)
      pipeline: normalizePipelineConfig(
        parsed.pipeline as { default_branch_prefix?: string; commit_message_template?: string; pr_body_template?: string } | undefined,
      ),
      taktProviders: normalizeTaktProviders(
        parsed.takt_providers as {
          assistant?: {
            provider?: GlobalConfig['provider'];
            model?: string;
          };
        } | undefined,
      ),
      personaProviders: normalizePersonaProviders(
        parsed.persona_providers as Record<string, string | { type?: string; provider?: string; model?: string }> | undefined,
      ),
      branchNameStrategy: parsed.branch_name_strategy as GlobalConfig['branchNameStrategy'],
      minimalOutput: parsed.minimal_output as boolean | undefined,
      concurrency: parsed.concurrency as number | undefined,
      taskPollIntervalMs: parsed.task_poll_interval_ms as number | undefined,
      interactivePreviewMovements: resolveAliasedPreviewCount(parsed as Record<string, unknown>, '~/.takt/config.yaml'),
    };
    validateProviderModelCompatibility(config.provider, config.model);
    this.cachedConfig = config;
    this.cachedTrace = trace;
    return config;
  }

  getTrace(): ConfigTrace {
    if (this.cachedTrace !== null) {
      return this.cachedTrace;
    }
    this.load();
    if (this.cachedTrace === null) {
      throw new Error('Global config trace is not available');
    }
    return this.cachedTrace;
  }

  save(config: GlobalConfig): void {
    const configPath = getGlobalConfigPath();
    const raw = serializeGlobalConfig(config);

    const rawTaktProviders = buildRawTaktProvidersOrThrow(config.taktProviders);
    if (rawTaktProviders) {
      raw.takt_providers = rawTaktProviders;
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

export function loadGlobalConfig(): GlobalConfig {
  return GlobalConfigManager.getInstance().load();
}

export function saveGlobalConfig(config: GlobalConfig): void {
  GlobalConfigManager.getInstance().save(config);
}

export function loadGlobalConfigTraceState(): ConfigTrace {
  return GlobalConfigManager.getInstance().getTrace();
}
