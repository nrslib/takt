import * as globalConfigModule from './global/globalConfig.js';
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
import { MIGRATED_PROJECT_LOCAL_DEFAULTS } from './migratedProjectLocalDefaults.js';
import {
  MIGRATED_PROJECT_LOCAL_CONFIG_KEYS,
  type MigratedProjectLocalConfigKey,
} from './migratedProjectLocalKeys.js';

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
  mergeMode?: 'analytics';
  pieceValue?: (pieceContext: PieceContext | undefined) => LoadedConfig[K] | undefined;
}
type GlobalMigratedProjectLocalFallback = Partial<
  Pick<LoadedConfig, MigratedProjectLocalConfigKey>
>;

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

const MIGRATED_PROJECT_LOCAL_RESOLUTION_REGISTRY = Object.fromEntries(
  MIGRATED_PROJECT_LOCAL_CONFIG_KEYS.map((key) => [key, { layers: ['local', 'global'] as const }]),
) as Partial<{ [K in ConfigParameterKey]: ResolutionRule<K> }>;
const MIGRATED_PROJECT_LOCAL_CONFIG_KEY_SET = new Set(
  MIGRATED_PROJECT_LOCAL_CONFIG_KEYS as ConfigParameterKey[],
);

const RESOLUTION_REGISTRY: Partial<{ [K in ConfigParameterKey]: ResolutionRule<K> }> = {
  piece: { layers: ['local', 'global'] },
  logLevel: { layers: ['local', 'global'] },
  provider: {
    layers: ['local', 'piece', 'global'],
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
  ...MIGRATED_PROJECT_LOCAL_RESOLUTION_REGISTRY,
  autoFetch: { layers: ['global'] },
  baseBranch: { layers: ['local', 'global'] },
  pieceOverrides: { layers: ['local', 'global'] },
};

function resolveAnalyticsMerged(
  project: ReturnType<typeof loadProjectConfigCached>,
  global: ReturnType<typeof globalConfigModule.loadGlobalConfig>,
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
  global: ReturnType<typeof globalConfigModule.loadGlobalConfig>,
): ConfigValueSource {
  if (project.analytics !== undefined) return 'project';
  if (global.analytics !== undefined) return 'global';
  return 'default';
}

function getLocalLayerValue<K extends ConfigParameterKey>(
  project: ReturnType<typeof loadProjectConfigCached>,
  key: K,
): LoadedConfig[K] | undefined {
  return project[key as keyof typeof project] as LoadedConfig[K] | undefined;
}

function getGlobalLayerValue<K extends ConfigParameterKey>(
  global: ReturnType<typeof globalConfigModule.loadGlobalConfig>,
  globalMigratedProjectLocalFallback: GlobalMigratedProjectLocalFallback,
  key: K,
): LoadedConfig[K] | undefined {
  if (key === 'logLevel' && global.logging?.level !== undefined) {
    return global.logging.level as LoadedConfig[K];
  }

  if (isMigratedProjectLocalConfigKey(key)) {
    return globalMigratedProjectLocalFallback[key] as LoadedConfig[K] | undefined;
  }
  return global[key as keyof typeof global] as LoadedConfig[K] | undefined;
}

function resolveByRegistry<K extends ConfigParameterKey>(
  key: K,
  project: ReturnType<typeof loadProjectConfigCached>,
  global: ReturnType<typeof globalConfigModule.loadGlobalConfig>,
  globalMigratedProjectLocalFallback: GlobalMigratedProjectLocalFallback,
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
      value = getGlobalLayerValue(global, globalMigratedProjectLocalFallback, key);
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

  const fallbackDefaultValue = MIGRATED_PROJECT_LOCAL_DEFAULTS[key as keyof typeof MIGRATED_PROJECT_LOCAL_DEFAULTS];
  if (fallbackDefaultValue !== undefined) {
    return { value: fallbackDefaultValue as LoadedConfig[K], source: 'default' };
  }

  return { value: undefined as LoadedConfig[K], source: 'default' };
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
  const global = globalConfigModule.loadGlobalConfig();
  const globalMigratedProjectLocalFallback = isMigratedProjectLocalConfigKey(key)
    ? globalConfigModule.loadGlobalMigratedProjectLocalFallback()
    : {};
  return resolveByRegistry(key, project, global, globalMigratedProjectLocalFallback, options);
}

function isMigratedProjectLocalConfigKey(
  key: ConfigParameterKey,
): key is MigratedProjectLocalConfigKey {
  return MIGRATED_PROJECT_LOCAL_CONFIG_KEY_SET.has(key);
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

export function isVerboseShortcutEnabled(
  projectDir: string,
  options?: ResolveConfigOptions,
): boolean {
  const verbose = resolveConfigValue(projectDir, 'verbose', options);
  if (verbose === true) {
    return true;
  }

  const logging = resolveConfigValue(projectDir, 'logging', options);
  if (logging?.debug === true || logging?.trace === true) {
    return true;
  }

  return resolveConfigValue(projectDir, 'logLevel', options) === 'debug';
}
