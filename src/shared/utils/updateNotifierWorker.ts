import { createRequire } from 'node:module';
import semver from 'semver';
import { readUpdateCache, saveUpdateCache } from './updateNotifierCache.js';
import { UPDATE_NOTIFIER_DISABLED_ARG } from './updateNotifierProcess.js';

const require = createRequire(import.meta.url);
const pkg = require('../../../package.json') as { name: string; version: string };
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function refreshUpdateCache(): Promise<void> {
  if ('NO_UPDATE_NOTIFIER' in process.env || process.argv.includes(UPDATE_NOTIFIER_DISABLED_ARG)) return;
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.CI !== undefined && process.env.CI !== 'false' && process.env.CI !== '0') return;
  const cache = readUpdateCache();
  if (cache.optOut === true) return;
  if (typeof cache.lastUpdateCheck === 'number' && Number.isFinite(cache.lastUpdateCheck)
    && Date.now() - cache.lastUpdateCheck < CHECK_INTERVAL_MS) return;
  const checkedCache = { ...cache, optOut: false, lastUpdateCheck: Date.now() };
  saveUpdateCache(checkedCache);
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/latest`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Update registry returned ${response.status}`);
  const value: unknown = await response.json();
  if (typeof value !== 'object' || value === null || !('version' in value)
    || typeof value.version !== 'string' || semver.valid(value.version) === null) {
    throw new Error('Update registry returned an invalid version');
  }
  saveUpdateCache({
    ...checkedCache,
    // The existing cache uses the dist-tag for identical versions, rather than null.
    update: { latest: value.version, current: pkg.version, name: pkg.name, type: semver.diff(pkg.version, value.version) ?? 'latest' },
  });
}

// This detached process owns failures; they must not change the parent CLI exit status.
try {
  await refreshUpdateCache();
} catch {
  process.exitCode = 1;
}
