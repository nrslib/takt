import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import semver from 'semver';

export function updateCachePath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'configstore', 'update-notifier-takt.json');
}

export function readUpdateCache(): Record<string, unknown> {
  // A missing or corrupt optional cache must never prevent CLI startup.
  try {
    const value: unknown = JSON.parse(readFileSync(updateCachePath(), 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function consumeCachedNewerVersion(currentVersion: string): string | undefined {
  const cache = readUpdateCache();
  if (cache.optOut === true) return undefined;
  const update = cache.update;
  if (typeof update !== 'object' || update === null || !('latest' in update)) return undefined;
  const latest = update.latest;
  const version = typeof latest === 'string' ? semver.valid(latest) : null;
  if (version === null || semver.valid(currentVersion) === null || !semver.gt(version, currentVersion)) return undefined;
  const remainingCache = { ...cache };
  delete remainingCache.update;
  saveUpdateCache(remainingCache);
  return version;
}

export function saveUpdateCache(cache: Record<string, unknown>): void {
  const path = updateCachePath();
  const temporaryPath = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temporaryPath, JSON.stringify(cache, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
