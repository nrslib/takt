import type { AnalyticsConfig, SubmoduleSelection } from '../../../core/models/config-types.js';

const SUBMODULES_ALL = 'all';

export function normalizeSubmodules(raw: unknown): SubmoduleSelection | undefined {
  if (raw === undefined) return undefined;

  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === SUBMODULES_ALL) {
      return SUBMODULES_ALL;
    }
    throw new Error('Invalid submodules: string value must be "all"');
  }

  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new Error('Invalid submodules: explicit path list must not be empty');
    }

    const normalizedPaths = raw.map((entry) => {
      if (typeof entry !== 'string') {
        throw new Error('Invalid submodules: path entries must be strings');
      }
      const trimmed = entry.trim();
      if (trimmed.length === 0) {
        throw new Error('Invalid submodules: path entries must not be empty');
      }
      if (trimmed.includes('*')) {
        throw new Error(`Invalid submodules: wildcard is not supported (${trimmed})`);
      }
      return trimmed;
    });

    return normalizedPaths;
  }

  throw new Error('Invalid submodules: must be "all" or an explicit path list');
}

export function normalizeWithSubmodules(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'boolean') return raw;
  throw new Error('Invalid with_submodules: value must be boolean');
}

export function normalizeAnalytics(raw: Record<string, unknown> | undefined): AnalyticsConfig | undefined {
  if (!raw) return undefined;
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : undefined;
  const eventsPath = typeof raw.events_path === 'string'
    ? raw.events_path
    : (typeof raw.eventsPath === 'string' ? raw.eventsPath : undefined);
  const retentionDays = typeof raw.retention_days === 'number'
    ? raw.retention_days
    : (typeof raw.retentionDays === 'number' ? raw.retentionDays : undefined);

  if (enabled === undefined && eventsPath === undefined && retentionDays === undefined) {
    return undefined;
  }
  return { enabled, eventsPath, retentionDays };
}

export function denormalizeAnalytics(config: AnalyticsConfig | undefined): Record<string, unknown> | undefined {
  if (!config) return undefined;
  const raw: Record<string, unknown> = {};
  if (config.enabled !== undefined) raw.enabled = config.enabled;
  if (config.eventsPath) raw.events_path = config.eventsPath;
  if (config.retentionDays !== undefined) raw.retention_days = config.retentionDays;
  return Object.keys(raw).length > 0 ? raw : undefined;
}

export function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  return path.map((segment) => String(segment)).join('.');
}
