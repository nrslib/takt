import type { ConfigParameterKey } from './resolveConfigValue.js';
import { resolveConfigValue, resolveConfigValues } from './resolveConfigValue.js';
import type { LoadedConfig } from './loadConfig.js';

export function resolvePieceConfigValue<K extends ConfigParameterKey>(
  projectDir: string,
  key: K,
): LoadedConfig[K] {
  return resolveConfigValue(projectDir, key);
}

export function resolvePieceConfigValues<K extends ConfigParameterKey>(
  projectDir: string,
  keys: readonly K[],
): Pick<LoadedConfig, K> {
  return resolveConfigValues(projectDir, keys);
}
