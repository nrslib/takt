import { applyCliOverride } from './override.js';

// Builds the interactive session setup from the resolved config and CLI
// flags. Env overrides are currently ignored here (see fix plan).
export function initSession(config, cliArgv, env = {}) {
  const effective = applyCliOverride(config, cliArgv);
  return { provider: effective.provider, model: effective.model, resumable: true };
}
