import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { stringify } from 'yaml';
import { ProjectConfigSchema } from '../../../core/models/index.js';
import { copyProjectResourcesToDir } from '../../resources/index.js';
import type { ProjectConfig } from '../types.js';
import {
  normalizeConfigProviderReference,
  type ConfigProviderReference,
} from '../providerReference.js';
import {
  normalizePipelineConfig,
  normalizeProviderProfiles,
  denormalizeProviderProfiles,
  denormalizeProviderOptions,
  normalizePersonaProviders,
  normalizeTaktProviders,
  buildRawTaktProvidersOrThrow,
  normalizePieceOverrides,
  denormalizePieceOverrides,
  normalizeRuntime,
} from '../configNormalizers.js';
import {
  resolveAliasedPreviewCount,
  type RawProviderPermissionProfile,
} from '../configKeyAliases.js';
import { invalidateResolvedConfigCache } from '../resolutionCache.js';
import { expandOptionalHomePath } from '../pathExpansion.js';
import { getProjectConfigDir, getProjectConfigPath } from './projectConfigPaths.js';
import {
  normalizeSubmodules,
  normalizeWithSubmodules,
  normalizeAnalytics,
  denormalizeAnalytics,
  normalizePieceRuntimePreparePolicy,
  denormalizePieceRuntimePreparePolicy,
  normalizePieceArpeggioPolicy,
  denormalizePieceArpeggioPolicy,
  normalizeSyncConflictResolver,
  denormalizeSyncConflictResolver,
  normalizePieceMcpServers,
  denormalizePieceMcpServers,
} from './projectConfigTransforms.js';
import { loadProjectConfigTrace, type ConfigTrace } from '../traced/tracedConfigLoader.js';
import { getCachedProjectConfigTrace, setCachedProjectConfigTrace } from '../resolutionCache.js';
import { assertValidProjectConfig } from './projectConfigValidation.js';

export type { ProjectConfig as ProjectLocalConfig } from '../types.js';

type ProviderType = NonNullable<ProjectConfig['provider']>;
type RawProviderReference = ConfigProviderReference<ProviderType>;

/**
 * Load project configuration from .takt/config.yaml
 */
export function loadProjectConfig(projectDir: string): ProjectConfig {
  const configPath = getProjectConfigPath(projectDir);
  const { parsedConfig, rawConfig, trace } = loadProjectConfigTrace(configPath);
  setCachedProjectConfigTrace(projectDir, trace);
  assertValidProjectConfig(parsedConfig, configPath, true);
  assertValidProjectConfig(rawConfig, configPath);
  const parsedConfigResult = ProjectConfigSchema.parse(rawConfig);

  const {
    language,
    provider,
    model,
    allow_git_hooks,
    allow_git_filters,
    auto_pr,
    draft_pr,
    vcs_provider,
    base_branch,
    submodules,
    with_submodules,
    provider_options,
    provider_profiles,
    analytics,
    pipeline,
    takt_providers,
    persona_providers,
    branch_name_strategy,
    minimal_output,
    concurrency,
    task_poll_interval_ms,
    piece_overrides,
    runtime,
    piece_runtime_prepare,
    piece_arpeggio,
    sync_conflict_resolver,
    piece_mcp_servers,
  } = parsedConfigResult;
  const normalizedProvider = normalizeConfigProviderReference(
    provider as RawProviderReference,
    model as string | undefined,
    provider_options as Record<string, unknown> | undefined,
  );
  const normalizedSubmodules = normalizeSubmodules(submodules);
  const normalizedWithSubmodules = normalizeWithSubmodules(with_submodules);
  const effectiveWithSubmodules = normalizedSubmodules === undefined ? normalizedWithSubmodules : undefined;
  const normalizedPipeline = normalizePipelineConfig(
    pipeline as { default_branch_prefix?: string; commit_message_template?: string; pr_body_template?: string } | undefined,
  );
  const normalizedPersonaProviders = normalizePersonaProviders(
    persona_providers as Record<string, string | { type?: string; provider?: string; model?: string }> | undefined,
  );

  const analyticsConfig = normalizeAnalytics(analytics as Record<string, unknown> | undefined);

  const normalizedTaktProviders = normalizeTaktProviders(
    takt_providers as {
      assistant?: {
        provider?: ProjectConfig['provider'];
        model?: string;
      };
    } | undefined,
  );

  return {
    language: language as ProjectConfig['language'],
    pipeline: normalizedPipeline,
    taktProviders: normalizedTaktProviders,
    personaProviders: normalizedPersonaProviders,
    branchNameStrategy: branch_name_strategy as ProjectConfig['branchNameStrategy'],
    minimalOutput: minimal_output as boolean | undefined,
    concurrency: concurrency as number | undefined,
    taskPollIntervalMs: task_poll_interval_ms as number | undefined,
    interactivePreviewMovements: resolveAliasedPreviewCount(
      parsedConfigResult as Record<string, unknown>,
      configPath,
    ),
    allowGitHooks: allow_git_hooks as boolean | undefined,
    allowGitFilters: allow_git_filters as boolean | undefined,
    autoPr: auto_pr as boolean | undefined,
    draftPr: draft_pr as boolean | undefined,
    vcsProvider: vcs_provider as ProjectConfig['vcsProvider'],
    baseBranch: base_branch as string | undefined,
    submodules: normalizedSubmodules,
    withSubmodules: effectiveWithSubmodules,
    analytics: analyticsConfig ? {
      ...analyticsConfig,
      eventsPath: expandOptionalHomePath(analyticsConfig.eventsPath),
    } : undefined,
    provider: normalizedProvider.provider,
    model: normalizedProvider.model,
    providerOptions: normalizedProvider.providerOptions,
    providerProfiles: normalizeProviderProfiles(
      provider_profiles as Record<string, RawProviderPermissionProfile> | undefined,
    ),
    pieceOverrides: normalizePieceOverrides(
      piece_overrides as {
        quality_gates?: string[];
        quality_gates_edit_only?: boolean;
        movements?: Record<string, { quality_gates?: string[] }>;
        personas?: Record<string, { quality_gates?: string[] }>;
      } | undefined
    ),
    runtime: normalizeRuntime(runtime),
    pieceRuntimePrepare: normalizePieceRuntimePreparePolicy(piece_runtime_prepare),
    pieceArpeggio: normalizePieceArpeggioPolicy(piece_arpeggio),
    syncConflictResolver: normalizeSyncConflictResolver(sync_conflict_resolver),
    pieceMcpServers: normalizePieceMcpServers(piece_mcp_servers),
  };
}

export function loadProjectConfigTraceState(projectDir: string): ConfigTrace {
  const cached = getCachedProjectConfigTrace(projectDir);
  if (cached) {
    return cached;
  }
  loadProjectConfig(projectDir);
  const trace = getCachedProjectConfigTrace(projectDir);
  if (!trace) {
    throw new Error(`Project config trace is not available for ${projectDir}`);
  }
  return trace;
}

/**
 * Save project configuration to .takt/config.yaml
 */
export function saveProjectConfig(projectDir: string, config: ProjectConfig): void {
  const configDir = getProjectConfigDir(projectDir);
  const configPath = getProjectConfigPath(projectDir);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  copyProjectResourcesToDir(configDir);

  const savePayload: Record<string, unknown> = { ...config };
  const normalizedSubmodules = normalizeSubmodules(config.submodules);

  const rawAnalytics = denormalizeAnalytics(config.analytics);
  if (rawAnalytics) {
    savePayload.analytics = rawAnalytics;
  } else {
    delete savePayload.analytics;
  }

  const rawProfiles = denormalizeProviderProfiles(config.providerProfiles);
  if (rawProfiles && Object.keys(rawProfiles).length > 0) {
    savePayload.provider_profiles = rawProfiles;
  } else {
    delete savePayload.provider_profiles;
  }
  const rawProviderOptions = denormalizeProviderOptions(config.providerOptions);
  if (rawProviderOptions) {
    savePayload.provider_options = rawProviderOptions;
  } else {
    delete savePayload.provider_options;
  }
  for (const [camel, snake] of [
    ['language', 'language'],
    ['autoPr', 'auto_pr'], ['draftPr', 'draft_pr'], ['allowGitHooks', 'allow_git_hooks'],
    ['allowGitFilters', 'allow_git_filters'], ['vcsProvider', 'vcs_provider'],
    ['baseBranch', 'base_branch'], ['branchNameStrategy', 'branch_name_strategy'],
    ['minimalOutput', 'minimal_output'], ['taskPollIntervalMs', 'task_poll_interval_ms'],
    ['interactivePreviewMovements', 'interactive_preview_steps'], ['concurrency', 'concurrency'],
  ] as const) {
    if (config[camel] !== undefined) savePayload[snake] = config[camel];
  }
  delete savePayload.pipeline;
  if (config.pipeline) {
    const pr: Record<string, unknown> = {};
    if (config.pipeline.defaultBranchPrefix !== undefined) pr.default_branch_prefix = config.pipeline.defaultBranchPrefix;
    if (config.pipeline.commitMessageTemplate !== undefined) pr.commit_message_template = config.pipeline.commitMessageTemplate;
    if (config.pipeline.prBodyTemplate !== undefined) pr.pr_body_template = config.pipeline.prBodyTemplate;
    if (Object.keys(pr).length > 0) savePayload.pipeline = pr;
  }
  if (config.personaProviders && Object.keys(config.personaProviders).length > 0) {
    savePayload.persona_providers = config.personaProviders;
  } else {
    delete savePayload.persona_providers;
  }
  const rawTaktProviders = buildRawTaktProvidersOrThrow(config.taktProviders);
  if (rawTaktProviders) {
    savePayload.takt_providers = rawTaktProviders;
  } else {
    delete savePayload.takt_providers;
  }
  if (normalizedSubmodules !== undefined) {
    savePayload.submodules = normalizedSubmodules;
    delete savePayload.with_submodules;
  } else {
    delete savePayload.submodules;
    if (config.withSubmodules !== undefined) {
      savePayload.with_submodules = config.withSubmodules;
    } else {
      delete savePayload.with_submodules;
    }
  }
  for (const k of [
    'providerProfiles', 'providerOptions', 'autoPr', 'draftPr', 'allowGitHooks',
    'allowGitFilters', 'vcsProvider', 'baseBranch', 'withSubmodules',
    'branchNameStrategy', 'minimalOutput', 'taskPollIntervalMs',
    'interactivePreviewMovements', 'personaProviders', 'taktProviders',
    'pieceRuntimePrepare', 'pieceArpeggio', 'syncConflictResolver',
    'pieceMcpServers',
  ] as const) {
    delete savePayload[k];
  }

  const rawPieceOverrides = denormalizePieceOverrides(config.pieceOverrides);
  if (rawPieceOverrides) {
    savePayload.piece_overrides = rawPieceOverrides;
  }
  delete savePayload.pieceOverrides;

  const normalizedRuntime = normalizeRuntime(config.runtime);
  if (normalizedRuntime) {
    savePayload.runtime = normalizedRuntime;
  } else {
    delete savePayload.runtime;
  }
  for (const [key, raw] of [
    ['piece_runtime_prepare', denormalizePieceRuntimePreparePolicy(config.pieceRuntimePrepare)],
    ['piece_arpeggio', denormalizePieceArpeggioPolicy(config.pieceArpeggio)],
    ['sync_conflict_resolver', denormalizeSyncConflictResolver(config.syncConflictResolver)],
    ['piece_mcp_servers', denormalizePieceMcpServers(config.pieceMcpServers)],
  ] as const) {
    if (raw) { savePayload[key] = raw; } else { delete savePayload[key]; }
  }

  const content = stringify(savePayload, { indent: 2 });
  writeFileSync(configPath, content, 'utf-8');
  invalidateResolvedConfigCache(projectDir);
}

export function updateProjectConfig<K extends keyof ProjectConfig>(
  projectDir: string,
  key: K,
  value: ProjectConfig[K]
): void {
  const config = loadProjectConfig(projectDir);
  config[key] = value;
  saveProjectConfig(projectDir, config);
}
