import { loadGlobalConfig } from './global/globalConfig.js';
import { loadProjectConfig } from './project/projectConfig.js';
import { envVarNameFromPath } from './env/config-env-overrides.js';
import {
  getCachedProjectConfig,
  getCachedResolvedValue,
  hasCachedResolvedValue,
  setCachedProjectConfig,
  setCachedResolvedValue,
} from './resolutionCache.js';
import type { ConfigParameterKey, LoadedConfig } from './resolvedConfig.js';

export type { ConfigParameterKey } from './resolvedConfig.js';
export { invalidateResolvedConfigCache, invalidateAllResolvedConfigCache } from './resolutionCache.js';

export interface PieceContext {
  provider?: LoadedConfig['provider'];
  model?: LoadedConfig['model'];
  providerOptions?: LoadedConfig['providerOptions'];
}

export interface ResolveConfigOptions {
  pieceContext?: PieceContext;
}

export type ConfigValueSource = 'env' | 'project' | 'piece' | 'global' | 'default';

export interface ResolvedConfigValue<K extends ConfigParameterKey> {
  value: LoadedConfig[K];
  source: ConfigValueSource;
}

type ResolutionLayer = 'local' | 'piece' | 'global';
interface ResolutionRule<K extends ConfigParameterKey> {
  layers: readonly ResolutionLayer[];
  defaultValue?: LoadedConfig[K];
  mergeMode?: 'analytics';
  pieceValue?: (pieceContext: PieceContext | undefined) => LoadedConfig[K] | undefined;
}

function loadProjectConfigCached(projectDir: string) {
  const cached = getCachedProjectConfig(projectDir);
  if (cached !== undefined) {
    return cached;
  }
  const loaded = loadProjectConfig(projectDir);
  setCachedProjectConfig(projectDir, loaded);
  return loaded;
}

const DEFAULT_RULE: ResolutionRule<ConfigParameterKey> = {
  layers: ['local', 'global'],
};

const PROVIDER_OPTIONS_ENV_PATHS = [
  'provider_options',
  'provider_options.codex.network_access',
  'provider_options.opencode.network_access',
  'provider_options.claude.sandbox.allow_unsandboxed_commands',
  'provider_options.claude.sandbox.excluded_commands',
] as const;

const RESOLUTION_REGISTRY: Partial<{ [K in ConfigParameterKey]: ResolutionRule<K> }> = {
  piece: { layers: ['local', 'global'], defaultValue: 'default' },
  provider: {
    layers: ['local', 'piece', 'global'],
    defaultValue: 'claude',
    pieceValue: (pieceContext) => pieceContext?.provider,
  },
  model: {
    layers: ['local', 'piece', 'global'],
    pieceValue: (pieceContext) => pieceContext?.model,
  },
  providerOptions: {
    layers: ['local', 'piece', 'global'],
    pieceValue: (pieceContext) => pieceContext?.providerOptions,
  },
  autoPr: { layers: ['local', 'global'] },
  draftPr: { layers: ['local', 'global'] },
  analytics: { layers: ['local', 'global'], mergeMode: 'analytics' },
  verbose: { layers: ['local', 'global'], defaultValue: false },
};

function resolveAnalyticsMerged(
  project: ReturnType<typeof loadProjectConfigCached>,
  global: ReturnType<typeof loadGlobalConfig>,
): LoadedConfig['analytics'] {
  const localAnalytics = project.analytics;
  const globalAnalytics = global.analytics;

  const enabled = localAnalytics?.enabled ?? globalAnalytics?.enabled;
  const eventsPath = localAnalytics?.eventsPath ?? globalAnalytics?.eventsPath;
  const retentionDays = localAnalytics?.retentionDays ?? globalAnalytics?.retentionDays;

  if (enabled === undefined && eventsPath === undefined && retentionDays === undefined) {
    return undefined;
  }
  return { enabled, eventsPath, retentionDays };
}

function resolveAnalyticsSource(
  project: ReturnType<typeof loadProjectConfigCached>,
  global: ReturnType<typeof loadGlobalConfig>,
): ConfigValueSource {
  if (project.analytics !== undefined) return 'project';
  if (global.analytics !== undefined) return 'global';
  return 'default';
}

function getLocalLayerValue<K extends ConfigParameterKey>(
  project: ReturnType<typeof loadProjectConfigCached>,
  key: K,
): LoadedConfig[K] | undefined {
  switch (key) {
    case 'piece':
      return project.piece as LoadedConfig[K] | undefined;
    case 'provider':
      return project.provider as LoadedConfig[K] | undefined;
    case 'autoPr':
      return project.auto_pr as LoadedConfig[K] | undefined;
    case 'draftPr':
      return project.draft_pr as LoadedConfig[K] | undefined;
    case 'verbose':
      return project.verbose as LoadedConfig[K] | undefined;
    case 'analytics':
      return project.analytics as LoadedConfig[K] | undefined;
    case 'providerOptions':
      return project.providerOptions as LoadedConfig[K] | undefined;
    case 'providerProfiles':
      return project.providerProfiles as LoadedConfig[K] | undefined;
    default:
      return undefined;
  }
}

function getGlobalLayerValue<K extends ConfigParameterKey>(
  global: ReturnType<typeof loadGlobalConfig>,
  key: K,
): LoadedConfig[K] | undefined {
  return global[key as keyof typeof global] as LoadedConfig[K] | undefined;
}

function resolveByRegistry<K extends ConfigParameterKey>(
  key: K,
  project: ReturnType<typeof loadProjectConfigCached>,
  global: ReturnType<typeof loadGlobalConfig>,
  options: ResolveConfigOptions | undefined,
): ResolvedConfigValue<K> {
  const rule = (RESOLUTION_REGISTRY[key] ?? DEFAULT_RULE) as ResolutionRule<K>;
  if (rule.mergeMode === 'analytics') {
    return {
      value: resolveAnalyticsMerged(project, global) as LoadedConfig[K],
      source: resolveAnalyticsSource(project, global),
    };
  }

  for (const layer of rule.layers) {
    let value: LoadedConfig[K] | undefined;
    if (layer === 'local') {
      value = getLocalLayerValue(project, key);
    } else if (layer === 'piece') {
      value = rule.pieceValue?.(options?.pieceContext);
    } else {
      value = getGlobalLayerValue(global, key);
    }
    if (value !== undefined) {
      if (layer === 'local') {
        if (key === 'providerOptions' && hasProviderOptionsEnvOverride()) {
          return { value, source: 'env' };
        }
        return { value, source: 'project' };
      }
      if (layer === 'piece') {
        return { value, source: 'piece' };
      }
      return { value, source: 'global' };
    }
  }

  return { value: rule.defaultValue as LoadedConfig[K], source: 'default' };
}

function hasProviderOptionsEnvOverride(): boolean {
  return PROVIDER_OPTIONS_ENV_PATHS.some((path) => process.env[envVarNameFromPath(path)] !== undefined);
}

function resolveUncachedConfigValue<K extends ConfigParameterKey>(
  projectDir: string,
  key: K,
  options?: ResolveConfigOptions,
): ResolvedConfigValue<K> {
  const project = loadProjectConfigCached(projectDir);
  const global = loadGlobalConfig();
  return resolveByRegistry(key, project, global, options);
}

export function resolveConfigValueWithSource<K extends ConfigParameterKey>(
  projectDir: string,
  key: K,
  options?: ResolveConfigOptions,
): ResolvedConfigValue<K> {
  const resolved = resolveUncachedConfigValue(projectDir, key, options);
  if (!options?.pieceContext) {
    setCachedResolvedValue(projectDir, key, resolved.value);
  }
  return resolved;
}

export function resolveConfigValue<K extends ConfigParameterKey>(
  projectDir: string,
  key: K,
  options?: ResolveConfigOptions,
): LoadedConfig[K] {
  if (!options?.pieceContext && hasCachedResolvedValue(projectDir, key)) {
    return getCachedResolvedValue(projectDir, key) as LoadedConfig[K];
  }
  return resolveConfigValueWithSource(projectDir, key, options).value;
}

export function resolveConfigValues<K extends ConfigParameterKey>(
  projectDir: string,
  keys: readonly K[],
  options?: ResolveConfigOptions,
): Pick<LoadedConfig, K> {
  const result = {} as Pick<LoadedConfig, K>;
  for (const key of keys) {
    result[key] = resolveConfigValue(projectDir, key, options);
  }
  return result;
}
