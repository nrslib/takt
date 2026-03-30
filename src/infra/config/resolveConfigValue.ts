import * as globalConfigModule from './global/globalConfig.js';
import { loadGlobalConfigTraceState } from './global/globalConfigCore.js';
import { mergeProviderOptions } from './providerOptions.js';
import { loadProjectConfig, loadProjectConfigTraceState } from './project/projectConfig.js';
import { expandOptionalHomePath } from './pathExpansion.js';
import {
  PROVIDER_OPTIONS_TRACE_PATHS,
  getPresentProviderOptionPaths,
  hasProviderOptionsPath,
  toProviderOptionsTracePath,
} from './providerOptionsContract.js';
import {
  getCachedProjectConfig,
  getCachedResolvedValue,
  hasCachedResolvedValue,
  setCachedProjectConfig,
  setCachedResolvedValue,
} from './resolutionCache.js';
import type { ConfigParameterKey, LoadedConfig } from './resolvedConfig.js';
import type {
  ProviderOptionsOriginResolver,
  ProviderOptionsSource,
  ProviderOptionsTraceOrigin,
} from '../../core/piece/types.js';
import type { MovementProviderOptions } from '../../core/models/piece-types.js';

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

/** Default values for project-local keys that need NonNullable guarantees */
const PROJECT_LOCAL_DEFAULTS: Partial<Record<ConfigParameterKey, unknown>> = {
  minimalOutput: false,
  concurrency: 1,
  taskPollIntervalMs: 500,
  interactivePreviewMovements: 3,
};

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

const RESOLUTION_REGISTRY: Partial<{ [K in ConfigParameterKey]: ResolutionRule<K> }> = {
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
  allowGitHooks: { layers: ['local', 'global'] },
  allowGitFilters: { layers: ['local', 'global'] },
  vcsProvider: { layers: ['local', 'global'] },
  autoPr: { layers: ['local', 'global'] },
  draftPr: { layers: ['local', 'global'] },
  analytics: { layers: ['local', 'global'], mergeMode: 'analytics' },
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
  const eventsPath = expandOptionalHomePath(localAnalytics?.eventsPath ?? globalAnalytics?.eventsPath);
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
  key: K,
): LoadedConfig[K] | undefined {
  return global[key as keyof typeof global] as LoadedConfig[K] | undefined;
}

function resolveByRegistry<K extends ConfigParameterKey>(
  projectDir: string,
  key: K,
  project: ReturnType<typeof loadProjectConfigCached>,
  global: ReturnType<typeof globalConfigModule.loadGlobalConfig>,
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
        if (key === 'providerOptions') {
          return { value, source: getProviderOptionsSource(loadProjectConfigTraceState(projectDir)) };
        }
        return { value, source: 'project' };
      }
      if (layer === 'piece') {
        return { value, source: 'piece' };
      }
      if (key === 'providerOptions') {
        return { value, source: getProviderOptionsSource(loadGlobalConfigTraceState()) };
      }
      return { value, source: 'global' };
    }
  }

  const fallbackDefaultValue = PROJECT_LOCAL_DEFAULTS[key];
  if (fallbackDefaultValue !== undefined) {
    return { value: fallbackDefaultValue as LoadedConfig[K], source: 'default' };
  }

  return { value: undefined as LoadedConfig[K], source: 'default' };
}

function resolveUncachedConfigValue<K extends ConfigParameterKey>(
  projectDir: string,
  key: K,
  options?: ResolveConfigOptions,
): ResolvedConfigValue<K> {
  const project = loadProjectConfigCached(projectDir);
  const global = globalConfigModule.loadGlobalConfig();
  return resolveByRegistry(projectDir, key, project, global, options);
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

export function isDebugLoggingEnabled(
  projectDir: string,
  options?: ResolveConfigOptions,
): boolean {
  const logging = resolveConfigValue(projectDir, 'logging', options);
  return logging?.debug === true || logging?.trace === true || logging?.level === 'debug';
}

type TracedConfigState = {
  getOrigin(path: string): ProviderOptionsTraceOrigin;
};

function resolveProviderOptionsSourceFromValues(
  providerOptions: MovementProviderOptions | undefined,
  originResolver: ProviderOptionsOriginResolver,
): ProviderOptionsSource {
  const paths = getPresentProviderOptionPaths(providerOptions);
  let sawLocal = false;
  let sawGlobal = false;
  for (const path of paths) {
    const origin = originResolver(path);
    if (origin === 'env' || origin === 'cli') {
      return 'env';
    }
    if (origin === 'local') {
      sawLocal = true;
      continue;
    }
    if (origin === 'global') {
      sawGlobal = true;
    }
  }
  if (sawLocal) {
    return 'project';
  }
  if (sawGlobal) {
    return 'global';
  }
  return 'default';
}

function getProviderOptionsSource(trace: TracedConfigState): ConfigValueSource {
  let sawLocal = false;
  let sawGlobal = false;
  for (const path of PROVIDER_OPTIONS_TRACE_PATHS) {
    const origin = trace.getOrigin(path);
    if (origin === 'env') {
      return 'env';
    }
    if (origin === 'cli') {
      return 'env';
    }
    if (origin === 'local') {
      sawLocal = true;
      continue;
    }
    if (origin === 'global') {
      sawGlobal = true;
    }
  }
  if (sawLocal) {
    return 'project';
  }
  if (sawGlobal) {
    return 'global';
  }
  return 'default';
}

export function resolveProviderOptionsWithTrace(
  projectDir: string,
): {
  value: LoadedConfig['providerOptions'];
  source: ProviderOptionsSource;
  originResolver: ProviderOptionsOriginResolver;
} {
  const project = loadProjectConfigCached(projectDir);
  const global = globalConfigModule.loadGlobalConfig();
  const mergedProviderOptions = mergeProviderOptions(global.providerOptions, project.providerOptions);

  if (mergedProviderOptions !== undefined) {
    const projectTrace = loadProjectConfigTraceState(projectDir);
    const globalTrace = loadGlobalConfigTraceState();
    const originResolver: ProviderOptionsOriginResolver = (path: string) => {
      if (hasProviderOptionsPath(project.providerOptions, path)) {
        return projectTrace.getOrigin(toProviderOptionsTracePath(path));
      }
      if (hasProviderOptionsPath(global.providerOptions, path)) {
        return globalTrace.getOrigin(toProviderOptionsTracePath(path));
      }
      if (project.providerOptions !== undefined) {
        return projectTrace.getOrigin(toProviderOptionsTracePath(path));
      }
      if (global.providerOptions !== undefined) {
        return globalTrace.getOrigin(toProviderOptionsTracePath(path));
      }
      return 'default';
    };
    return {
      value: mergedProviderOptions,
      source: resolveProviderOptionsSourceFromValues(mergedProviderOptions, originResolver),
      originResolver,
    };
  }

  return {
    value: undefined,
    source: 'default',
    originResolver: () => 'default',
  };
}
