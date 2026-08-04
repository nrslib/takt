import { normalizeFlagValue } from './flags.js';

// Applies an explicit CLI override on top of the resolved config.
// When the override switches the provider, the configured model is
// discarded — a model belongs to the provider it was configured for.
export function applyCliOverride(config, cliArgv) {
  const cliProvider = normalizeFlagValue(cliArgv.provider);
  const cliModel = normalizeFlagValue(cliArgv.model);
  const provider = cliProvider ?? config.provider;
  const providerSwitched = cliProvider !== undefined && cliProvider !== config.provider;
  const model = cliModel ?? (providerSwitched ? undefined : config.model);
  return { provider, model };
}
