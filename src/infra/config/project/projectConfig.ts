import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
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
  normalizePersonaProviders,
  normalizeTaktProviders,
  normalizePieceOverrides,
  normalizeRuntime,
} from '../configNormalizers.js';
import { invalidateResolvedConfigCache } from '../resolutionCache.js';
import { expandOptionalHomePath } from '../pathExpansion.js';
import { getProjectConfigDir, getProjectConfigPath } from './projectConfigPaths.js';
import { isProjectConfigEnabled } from './projectConfigGuards.js';
import { loadProjectConfigDocument, stringifyProjectConfig } from './projectConfigFile.js';
import {
  normalizeSubmodules,
  normalizeWithSubmodules,
  normalizeAnalytics,
  formatIssuePath,
  normalizePieceRuntimePreparePolicy,
  normalizePieceArpeggioPolicy,
  normalizeSyncConflictResolver,
  normalizePieceMcpServers,
} from './projectConfigTransforms.js';

export type { ProjectConfig as ProjectLocalConfig } from '../types.js';

type ProviderType = NonNullable<ProjectConfig['provider']>;
type RawProviderReference = ConfigProviderReference<ProviderType>;

function loadRawProjectConfig(projectDir: string): Record<string, unknown> {
  const rawConfig = isProjectConfigEnabled(projectDir)
    ? loadProjectConfigDocument(getProjectConfigPath(projectDir))
    : {};

  applyProjectConfigEnvOverrides(rawConfig);
  return rawConfig;
}

/**
 * Load project configuration from .takt/config.yaml
 */
export function loadProjectConfig(projectDir: string): ProjectConfig {
  const configPath = getProjectConfigPath(projectDir);
  const rawConfig = loadRawProjectConfig(projectDir);
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
    interactive_preview_movements,
    piece_overrides,
    runtime,
    piece_runtime_prepare,
    piece_arpeggio,
    sync_conflict_resolver,
    piece_mcp_servers,
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

  const normalizedTaktProviders = normalizeTaktProviders(
    takt_providers as {
      assistant?: {
        provider?: ProjectConfig['provider'];
        model?: string;
      };
    } | undefined,
  );

  return {
    pipeline: normalizedPipeline,
    taktProviders: normalizedTaktProviders,
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
    pieceRuntimePrepare: normalizePieceRuntimePreparePolicy(piece_runtime_prepare),
    pieceArpeggio: normalizePieceArpeggioPolicy(piece_arpeggio),
    syncConflictResolver: normalizeSyncConflictResolver(sync_conflict_resolver),
    pieceMcpServers: normalizePieceMcpServers(piece_mcp_servers),
  };
}

/**
 * Save project configuration to .takt/config.yaml
 */
export function saveProjectConfig(projectDir: string, config: ProjectConfig): void {
  if (!isProjectConfigEnabled(projectDir)) {
    return;
  }

  const configDir = getProjectConfigDir(projectDir);
  const configPath = getProjectConfigPath(projectDir);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  copyProjectResourcesToDir(configDir);
  const content = stringifyProjectConfig(config);
  writeFileSync(configPath, content, 'utf-8');
  invalidateResolvedConfigCache(projectDir);
}

export function updateProjectConfig<K extends keyof ProjectConfig>(
  projectDir: string,
  key: K,
  value: ProjectConfig[K]
): void {
  if (!isProjectConfigEnabled(projectDir)) {
    return;
  }

  const config = loadProjectConfig(projectDir);
  const nextConfig: ProjectConfig = {
    ...config,
    [key]: value,
  };
  saveProjectConfig(projectDir, nextConfig);
}
