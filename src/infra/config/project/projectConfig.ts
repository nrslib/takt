/**
 * Project-level configuration management
 *
 * Manages .takt/config.yaml for project-specific settings.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { copyProjectResourcesToDir } from '../../resources/index.js';
import type { ProjectLocalConfig } from '../types.js';
import type { ProviderPermissionProfiles } from '../../../core/models/provider-profiles.js';
import type { AnalyticsConfig, SubmoduleSelection } from '../../../core/models/persisted-global-config.js';
import { applyProjectConfigEnvOverrides } from '../env/config-env-overrides.js';
import { normalizeProviderOptions } from '../loaders/pieceParser.js';
import { invalidateResolvedConfigCache } from '../resolutionCache.js';

export type { ProjectLocalConfig } from '../types.js';

/** Default project configuration */
const DEFAULT_PROJECT_CONFIG: ProjectLocalConfig = {
  piece: 'default',
};

const SUBMODULES_ALL = 'all';

function normalizeSubmodules(raw: unknown): SubmoduleSelection | undefined {
  if (raw === undefined) return undefined;

  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === SUBMODULES_ALL) {
      return SUBMODULES_ALL;
    }
    throw new Error('Invalid submodules: string value must be "all"');
  }

  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new Error('Invalid submodules: explicit path list must not be empty');
    }

    const normalizedPaths = raw.map((entry) => {
      if (typeof entry !== 'string') {
        throw new Error('Invalid submodules: path entries must be strings');
      }
      const trimmed = entry.trim();
      if (trimmed.length === 0) {
        throw new Error('Invalid submodules: path entries must not be empty');
      }
      if (trimmed.includes('*')) {
        throw new Error(`Invalid submodules: wildcard is not supported (${trimmed})`);
      }
      return trimmed;
    });

    return normalizedPaths;
  }

  throw new Error('Invalid submodules: must be "all" or an explicit path list');
}

function normalizeWithSubmodules(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'boolean') return raw;
  throw new Error('Invalid with_submodules: value must be boolean');
}

/**
 * Get project takt config directory (.takt in project)
 * Note: Defined locally to avoid circular dependency with paths.ts
 */
function getConfigDir(projectDir: string): string {
  return join(resolve(projectDir), '.takt');
}

/**
 * Get project config file path
 * Note: Defined locally to avoid circular dependency with paths.ts
 */
function getConfigPath(projectDir: string): string {
  return join(getConfigDir(projectDir), 'config.yaml');
}

function normalizeProviderProfiles(raw: Record<string, { default_permission_mode: unknown; movement_permission_overrides?: Record<string, unknown> }> | undefined): ProviderPermissionProfiles | undefined {
  if (!raw) return undefined;
  return Object.fromEntries(
    Object.entries(raw).map(([provider, profile]) => [provider, {
      defaultPermissionMode: profile.default_permission_mode,
      movementPermissionOverrides: profile.movement_permission_overrides,
    }]),
  ) as ProviderPermissionProfiles;
}

function denormalizeProviderProfiles(profiles: ProviderPermissionProfiles | undefined): Record<string, { default_permission_mode: string; movement_permission_overrides?: Record<string, string> }> | undefined {
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

function normalizeAnalytics(raw: Record<string, unknown> | undefined): AnalyticsConfig | undefined {
  if (!raw) return undefined;
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : undefined;
  const eventsPath = typeof raw.events_path === 'string'
    ? raw.events_path
    : (typeof raw.eventsPath === 'string' ? raw.eventsPath : undefined);
  const retentionDays = typeof raw.retention_days === 'number'
    ? raw.retention_days
    : (typeof raw.retentionDays === 'number' ? raw.retentionDays : undefined);

  if (enabled === undefined && eventsPath === undefined && retentionDays === undefined) {
    return undefined;
  }
  return { enabled, eventsPath, retentionDays };
}

function denormalizeAnalytics(config: AnalyticsConfig | undefined): Record<string, unknown> | undefined {
  if (!config) return undefined;
  const raw: Record<string, unknown> = {};
  if (config.enabled !== undefined) raw.enabled = config.enabled;
  if (config.eventsPath) raw.events_path = config.eventsPath;
  if (config.retentionDays !== undefined) raw.retention_days = config.retentionDays;
  return Object.keys(raw).length > 0 ? raw : undefined;
}

/**
 * Load project configuration from .takt/config.yaml
 */
export function loadProjectConfig(projectDir: string): ProjectLocalConfig {
  const configPath = getConfigPath(projectDir);

  const parsedConfig: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      const parsed = (parse(content) as Record<string, unknown> | null) ?? {};
      Object.assign(parsedConfig, parsed);
    } catch {
      return { ...DEFAULT_PROJECT_CONFIG };
    }
  }

  applyProjectConfigEnvOverrides(parsedConfig);

  const {
    auto_pr,
    draft_pr,
    base_branch,
    submodules,
    with_submodules,
    provider_options,
    provider_profiles,
    analytics,
    claude_cli_path,
    codex_cli_path,
    cursor_cli_path,
    ...rest
  } = parsedConfig;

  const normalizedSubmodules = normalizeSubmodules(submodules);
  const normalizedWithSubmodules = normalizeWithSubmodules(with_submodules);
  const effectiveWithSubmodules = normalizedSubmodules === undefined ? normalizedWithSubmodules : undefined;

  return {
    ...DEFAULT_PROJECT_CONFIG,
    ...(rest as ProjectLocalConfig),
    autoPr: auto_pr as boolean | undefined,
    draftPr: draft_pr as boolean | undefined,
    baseBranch: base_branch as string | undefined,
    submodules: normalizedSubmodules,
    withSubmodules: effectiveWithSubmodules,
    analytics: normalizeAnalytics(analytics as Record<string, unknown> | undefined),
    providerOptions: normalizeProviderOptions(provider_options as {
      codex?: { network_access?: boolean };
      opencode?: { network_access?: boolean };
      claude?: {
        sandbox?: {
          allow_unsandboxed_commands?: boolean;
          excluded_commands?: string[];
        };
      };
    } | undefined),
    providerProfiles: normalizeProviderProfiles(provider_profiles as Record<string, { default_permission_mode: unknown; movement_permission_overrides?: Record<string, unknown> }> | undefined),
    claudeCliPath: claude_cli_path as string | undefined,
    codexCliPath: codex_cli_path as string | undefined,
    cursorCliPath: cursor_cli_path as string | undefined,
  };
}

/**
 * Save project configuration to .takt/config.yaml
 */
export function saveProjectConfig(projectDir: string, config: ProjectLocalConfig): void {
  const configDir = getConfigDir(projectDir);
  const configPath = getConfigPath(projectDir);

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
  delete savePayload.providerProfiles;
  delete savePayload.providerOptions;

  if (config.autoPr !== undefined) savePayload.auto_pr = config.autoPr;
  if (config.draftPr !== undefined) savePayload.draft_pr = config.draftPr;
  if (config.baseBranch !== undefined) savePayload.base_branch = config.baseBranch;
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
  delete savePayload.baseBranch;
  delete savePayload.withSubmodules;

  const content = stringify(savePayload, { indent: 2 });
  writeFileSync(configPath, content, 'utf-8');
  invalidateResolvedConfigCache(projectDir);
}

/**
 * Update a single field in project configuration
 */
export function updateProjectConfig<K extends keyof ProjectLocalConfig>(
  projectDir: string,
  key: K,
  value: ProjectLocalConfig[K]
): void {
  const config = loadProjectConfig(projectDir);
  config[key] = value;
  saveProjectConfig(projectDir, config);
}

/**
 * Set current piece in project config
 */
export function setCurrentPiece(projectDir: string, piece: string): void {
  updateProjectConfig(projectDir, 'piece', piece);
}
