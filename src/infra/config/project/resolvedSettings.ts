import { envVarNameFromPath } from '../env/config-env-overrides.js';
import { loadConfig } from '../loadConfig.js';

function resolveValue<T>(
  envValue: T | undefined,
  localValue: T | undefined,
  globalValue: T | undefined,
  defaultValue: T,
): T {
  if (envValue !== undefined) return envValue;
  if (localValue !== undefined) return localValue;
  if (globalValue !== undefined) return globalValue;
  return defaultValue;
}

function loadEnvBooleanSetting(configKey: string): boolean | undefined {
  const envKey = envVarNameFromPath(configKey);
  const raw = process.env[envKey];
  if (raw === undefined) return undefined;

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  throw new Error(`${envKey} must be one of: true, false`);
}

export function isVerboseMode(projectDir: string): boolean {
  const envValue = loadEnvBooleanSetting('verbose');
  const config = loadConfig(projectDir);
  return resolveValue(envValue, undefined, config.verbose, false);
}
