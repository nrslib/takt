import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { ProjectConfigSchema } from '../../../core/models/index.js';
import { copyProjectResourcesToDir } from '../../resources/index.js';
import type { ProjectConfig } from '../types.js';
import { applyProjectConfigEnvOverrides } from '../env/config-env-overrides.js';
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
  normalizePieceOverrides,
  denormalizePieceOverrides,
  normalizeRuntime,
} from '../configNormalizers.js';
import { invalidateResolvedConfigCache } from '../resolutionCache.js';
import { expandOptionalHomePath } from '../pathExpansion.js';
import { getProjectConfigDir, getProjectConfigPath } from './projectConfigPaths.js';
import {
  normalizeSubmodules,
  normalizeWithSubmodules,
  normalizeAnalytics,
  denormalizeAnalytics,
  formatIssuePath,
} from './projectConfigTransforms.js';

export type { ProjectConfig as ProjectLocalConfig } from '../types.js';

type ProviderType = NonNullable<ProjectConfig['provider']>;
type RawProviderReference = ConfigProviderReference<ProviderType>;

/**
 * Load project configuration from .takt/config.yaml
 */
export function loadProjectConfig(projectDir: string): ProjectConfig {
  const configPath = getProjectConfigPath(projectDir);
  const rawConfig: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const content = readFileSync(configPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = parse(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Configuration error: failed to parse ${configPath}: ${message}`);
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.assign(rawConfig, parsed as Record<string, unknown>);
    } else if (parsed != null) {
      throw new Error(`Configuration error: ${configPath} must be a YAML object.`);
    }
  }

  applyProjectConfigEnvOverrides(rawConfig);
  const parsedResult = ProjectConfigSchema.safeParse(rawConfig);
  if (!parsedResult.success) {
    const firstIssue = parsedResult.error.issues[0];
    const issuePath = firstIssue ? formatIssuePath(firstIssue.path) : '(root)';
    const issueMessage = firstIssue?.message ?? 'Invalid configuration value';
    throw new Error(
      `Configuration error: invalid ${issuePath} in ${configPath}: ${issueMessage}`,
    );
  }
  const parsedConfig = parsedResult.data;

  const {
    provider,
    model,
    allow_git_hooks,
    allow_git_filters,
    auto_pr,
    draft_pr,
    base_branch,
    submodules,
    with_submodules,
    provider_options,
    provider_profiles,
    analytics,
    pipeline,
    persona_providers,
    branch_name_strategy,
    minimal_output,
    concurrency,
    task_poll_interval_ms,
    interactive_preview_movements,
    piece_overrides,
    runtime,
  } = parsedConfig;
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

  return {
    pipeline: normalizedPipeline,
    personaProviders: normalizedPersonaProviders,
    branchNameStrategy: branch_name_strategy as ProjectConfig['branchNameStrategy'],
    minimalOutput: minimal_output as boolean | undefined,
    concurrency: concurrency as number | undefined,
    taskPollIntervalMs: task_poll_interval_ms as number | undefined,
    interactivePreviewMovements: interactive_preview_movements as number | undefined,
    allowGitHooks: allow_git_hooks as boolean | undefined,
    allowGitFilters: allow_git_filters as boolean | undefined,
    autoPr: auto_pr as boolean | undefined,
    draftPr: draft_pr as boolean | undefined,
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
    providerProfiles: normalizeProviderProfiles(provider_profiles as Record<string, { default_permission_mode: unknown; movement_permission_overrides?: Record<string, unknown> }> | undefined),
    pieceOverrides: normalizePieceOverrides(
      piece_overrides as {
        quality_gates?: string[];
        quality_gates_edit_only?: boolean;
        movements?: Record<string, { quality_gates?: string[] }>;
        personas?: Record<string, { quality_gates?: string[] }>;
      } | undefined
    ),
    runtime: normalizeRuntime(runtime),
  };
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
  delete savePayload.providerProfiles;
  delete savePayload.providerOptions;

  if (config.autoPr !== undefined) savePayload.auto_pr = config.autoPr;
  if (config.draftPr !== undefined) savePayload.draft_pr = config.draftPr;
  if (config.allowGitHooks !== undefined) savePayload.allow_git_hooks = config.allowGitHooks;
  if (config.allowGitFilters !== undefined) savePayload.allow_git_filters = config.allowGitFilters;
  if (config.baseBranch !== undefined) savePayload.base_branch = config.baseBranch;
  if (config.branchNameStrategy !== undefined) savePayload.branch_name_strategy = config.branchNameStrategy;
  if (config.minimalOutput !== undefined) savePayload.minimal_output = config.minimalOutput;
  if (config.taskPollIntervalMs !== undefined) savePayload.task_poll_interval_ms = config.taskPollIntervalMs;
  if (config.interactivePreviewMovements !== undefined) savePayload.interactive_preview_movements = config.interactivePreviewMovements;
  if (config.concurrency !== undefined) savePayload.concurrency = config.concurrency;
  delete savePayload.pipeline;
  if (config.pipeline) {
    const pipelineRaw: Record<string, unknown> = {};
    if (config.pipeline.defaultBranchPrefix !== undefined) {
      pipelineRaw.default_branch_prefix = config.pipeline.defaultBranchPrefix;
    }
    if (config.pipeline.commitMessageTemplate !== undefined) {
      pipelineRaw.commit_message_template = config.pipeline.commitMessageTemplate;
    }
    if (config.pipeline.prBodyTemplate !== undefined) {
      pipelineRaw.pr_body_template = config.pipeline.prBodyTemplate;
    }
    if (Object.keys(pipelineRaw).length > 0) savePayload.pipeline = pipelineRaw;
  }
  if (config.personaProviders && Object.keys(config.personaProviders).length > 0) {
    savePayload.persona_providers = config.personaProviders;
  } else {
    delete savePayload.persona_providers;
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
  delete savePayload.autoPr;
  delete savePayload.draftPr;
  delete savePayload.allowGitHooks;
  delete savePayload.allowGitFilters;
  delete savePayload.baseBranch;
  delete savePayload.withSubmodules;
  delete savePayload.branchNameStrategy;
  delete savePayload.minimalOutput;
  delete savePayload.taskPollIntervalMs;
  delete savePayload.interactivePreviewMovements;
  delete savePayload.personaProviders;

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
