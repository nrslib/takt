import type { ConfigParameterKey } from './resolveConfigValue.js';
import { resolveConfigValue, resolveConfigValues } from './resolveConfigValue.js';
import type { ResolveConfigOptions } from './resolveConfigValue.js';
import type { LoadedConfig } from './resolvedConfig.js';

export function resolvePieceConfigValue<K extends ConfigParameterKey>(
  projectDir: string,
  key: K,
  options?: ResolveConfigOptions,
): LoadedConfig[K] {
  return resolveConfigValue(projectDir, key, options);
}

export function resolvePieceConfigValues<K extends ConfigParameterKey>(
  projectDir: string,
  keys: readonly K[],
  options?: ResolveConfigOptions,
): Pick<LoadedConfig, K> {
  return resolveConfigValues(projectDir, keys, options);
}
