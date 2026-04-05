import { resolve } from 'node:path';
import type { ProjectLocalConfig } from './types.js';
import type { ConfigParameterKey } from './resolvedConfig.js';
import type { ConfigTrace } from './traced/tracedConfigLoader.js';

const projectConfigCache = new Map<string, ProjectLocalConfig>();
const projectConfigTraceCache = new Map<string, ConfigTrace>();
const resolvedValueCache = new Map<string, unknown>();

function normalizeProjectDir(projectDir: string): string {
  return resolve(projectDir);
}

function resolvedValueKey(projectDir: string, key: ConfigParameterKey): string {
  return `${normalizeProjectDir(projectDir)}::${key}`;
}

export function getCachedProjectConfig(projectDir: string): ProjectLocalConfig | undefined {
  return projectConfigCache.get(normalizeProjectDir(projectDir));
}

export function setCachedProjectConfig(projectDir: string, config: ProjectLocalConfig): void {
  projectConfigCache.set(normalizeProjectDir(projectDir), config);
}

export function getCachedProjectConfigTrace(projectDir: string): ConfigTrace | undefined {
  return projectConfigTraceCache.get(normalizeProjectDir(projectDir));
}

export function setCachedProjectConfigTrace(projectDir: string, trace: ConfigTrace): void {
  projectConfigTraceCache.set(normalizeProjectDir(projectDir), trace);
}

export function hasCachedResolvedValue(projectDir: string, key: ConfigParameterKey): boolean {
  return resolvedValueCache.has(resolvedValueKey(projectDir, key));
}

export function getCachedResolvedValue(projectDir: string, key: ConfigParameterKey): unknown {
  return resolvedValueCache.get(resolvedValueKey(projectDir, key));
}

export function setCachedResolvedValue(projectDir: string, key: ConfigParameterKey, value: unknown): void {
  resolvedValueCache.set(resolvedValueKey(projectDir, key), value);
}

export function invalidateResolvedConfigCache(projectDir: string): void {
  const normalizedProjectDir = normalizeProjectDir(projectDir);
  projectConfigCache.delete(normalizedProjectDir);
  projectConfigTraceCache.delete(normalizedProjectDir);
  const prefix = `${normalizedProjectDir}::`;
  for (const key of resolvedValueCache.keys()) {
    if (key.startsWith(prefix)) {
      resolvedValueCache.delete(key);
    }
  }
}

export function invalidateAllResolvedConfigCache(): void {
  projectConfigCache.clear();
  projectConfigTraceCache.clear();
  resolvedValueCache.clear();
}
