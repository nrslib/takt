import type { MergeConfig, MergeSettings } from '../../core/models/config-types.js';

export function resolveMergeSettings(config: MergeConfig | undefined): MergeSettings {
  return {
    workflow: config?.workflow ?? 'merge-review-fix-simple',
    method: config?.method ?? 'squash',
    concurrency: config?.concurrency ?? 2,
    autoStart: config?.autoStart ?? false,
    includeDraft: config?.includeDraft ?? false,
    includeForks: config?.includeForks ?? false,
    threatCheckMaxDiffBytes: config?.threatCheckMaxDiffBytes ?? 200_000,
    ...(config?.where === undefined ? {} : { where: config.where }),
  };
}
