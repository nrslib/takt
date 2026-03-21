import { existsSync, readFileSync } from 'node:fs';

import { parse, stringify } from 'yaml';

import {
  denormalizeAnalytics,
  denormalizePieceArpeggioPolicy,
  denormalizePieceMcpServers,
  denormalizePieceRuntimePreparePolicy,
  denormalizeSyncConflictResolver,
  normalizeSubmodules,
} from './projectConfigTransforms.js';
import type { ProjectConfig } from '../types.js';
import {
  buildRawTaktProvidersOrThrow,
  denormalizePieceOverrides,
  denormalizeProviderOptions,
  denormalizeProviderProfiles,
  normalizeRuntime,
} from '../configNormalizers.js';

export function loadProjectConfigDocument(configPath: string): Record<string, unknown> {
  const rawConfig: Record<string, unknown> = {};
  if (!existsSync(configPath)) {
    return rawConfig;
  }

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
    return rawConfig;
  }

  if (parsed != null) {
    throw new Error(`Configuration error: ${configPath} must be a YAML object.`);
  }

  return rawConfig;
}

export function stringifyProjectConfig(config: ProjectConfig): string {
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
    ['autoPr', 'auto_pr'], ['draftPr', 'draft_pr'], ['allowGitHooks', 'allow_git_hooks'],
    ['allowGitFilters', 'allow_git_filters'], ['vcsProvider', 'vcs_provider'],
    ['baseBranch', 'base_branch'], ['branchNameStrategy', 'branch_name_strategy'],
    ['minimalOutput', 'minimal_output'], ['taskPollIntervalMs', 'task_poll_interval_ms'],
    ['interactivePreviewMovements', 'interactive_preview_movements'], ['concurrency', 'concurrency'],
  ] as const) {
    if (config[camel] !== undefined) {
      savePayload[snake] = config[camel];
    }
  }

  delete savePayload.pipeline;
  if (config.pipeline) {
    const pipelinePayload: Record<string, unknown> = {};
    if (config.pipeline.defaultBranchPrefix !== undefined) {
      pipelinePayload.default_branch_prefix = config.pipeline.defaultBranchPrefix;
    }
    if (config.pipeline.commitMessageTemplate !== undefined) {
      pipelinePayload.commit_message_template = config.pipeline.commitMessageTemplate;
    }
    if (config.pipeline.prBodyTemplate !== undefined) {
      pipelinePayload.pr_body_template = config.pipeline.prBodyTemplate;
    }
    if (Object.keys(pipelinePayload).length > 0) {
      savePayload.pipeline = pipelinePayload;
    }
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

  for (const key of [
    'providerProfiles', 'providerOptions', 'autoPr', 'draftPr', 'allowGitHooks',
    'allowGitFilters', 'vcsProvider', 'baseBranch', 'withSubmodules',
    'branchNameStrategy', 'minimalOutput', 'taskPollIntervalMs',
    'interactivePreviewMovements', 'personaProviders', 'taktProviders',
    'pieceRuntimePrepare', 'pieceArpeggio', 'syncConflictResolver',
    'pieceMcpServers',
  ] as const) {
    delete savePayload[key];
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
    if (raw) {
      savePayload[key] = raw;
    } else {
      delete savePayload[key];
    }
  }

  return stringify(savePayload, { indent: 2 });
}
