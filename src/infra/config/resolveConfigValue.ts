import { loadConfig, type LoadedConfig } from './loadConfig.js';

export type ConfigParameterKey = keyof LoadedConfig;

export function resolveConfigValue<K extends ConfigParameterKey>(
  projectDir: string,
  key: K,
): LoadedConfig[K] {
  return loadConfig(projectDir)[key];
}

export function resolveConfigValues<K extends ConfigParameterKey>(
  projectDir: string,
  keys: readonly K[],
): Pick<LoadedConfig, K> {
  const config = loadConfig(projectDir);
  const result = {} as Pick<LoadedConfig, K>;
  for (const key of keys) {
    result[key] = config[key];
  }
  return result;
}
