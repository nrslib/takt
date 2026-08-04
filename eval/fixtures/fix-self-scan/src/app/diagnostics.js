import { sourceLabel } from '../core/resolve.js';
import { validateProviderName, validateModelName } from '../core/validate.js';

// Collects human-readable diagnostics for the resolved config.
export function collectDiagnostics(config, entries) {
  const problems = [];
  const provider = validateProviderName(config.provider);
  if (!provider.ok) problems.push(provider.reason);
  const model = validateModelName(config.model);
  if (!model.ok) problems.push(model.reason);
  const origins = entries.map((entry) => `${entry.key}<-${sourceLabel(entry.origin, 'unknown')}`);
  return { problems, origins };
}
