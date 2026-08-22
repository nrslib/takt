import { sourceLabel } from './resolve.js';

// Builds the run summary shown after execution. Reports the resolved
// config as-is; overrides applied at the app layer are not reflected yet.
export function buildRunSummary(config, entries) {
  return {
    provider: config.provider,
    model: config.model,
    sources: entries.map((entry) => ({
      key: entry.key,
      label: sourceLabel(entry.origin, 'unknown'),
    })),
  };
}
