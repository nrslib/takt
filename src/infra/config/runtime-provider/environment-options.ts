import type { ProviderRoutingEntry } from '../../../core/models/config-types.js';
import { mergeProviderOptions } from '../providerOptions.js';
import { resolveProviderOptionsWithTrace } from '../resolveConfigValue.js';
import type { CompiledProviderEnvironment } from './environment.js';

/**
 * Apply dedicated DeepSeek effort env overrides to compiled direct-consumer profiles.
 * Defaults, internal agents, companions and the auto-router bypass the workflow resolver;
 * only their DeepSeek entries are updated, leaving other providers and absent env intact.
 */
export function applyDeepSeekEnvironmentOptions(
  projectCwd: string,
  environment: CompiledProviderEnvironment,
): CompiledProviderEnvironment {
  const traced = resolveProviderOptionsWithTrace(projectCwd);
  const reasoningEffort = traced.value?.deepseekHarness?.reasoningEffort;
  if (reasoningEffort === undefined
    || traced.originResolver('deepseekHarness.reasoningEffort') !== 'env') {
    return environment;
  }
  const override = { deepseekHarness: { reasoningEffort } };
  const mergeEntry = (entry: ProviderRoutingEntry): ProviderRoutingEntry => (
    entry.provider === 'deepseek-harness'
      ? { ...entry, providerOptions: mergeProviderOptions(entry.providerOptions, override) }
      : entry
  );
  return {
    ...environment,
    ...(environment.provider === 'deepseek-harness'
      ? { providerOptions: mergeProviderOptions(environment.providerOptions, override) }
      : {}),
    ...(environment.autoRouting?.router.provider !== 'deepseek-harness' ? {} : {
      autoRouting: {
        ...environment.autoRouting,
        router: {
          ...environment.autoRouting.router,
          providerOptions: mergeProviderOptions(environment.autoRouting.router.providerOptions, override),
        },
      },
    }),
    ...(environment.internalAgents === undefined ? {} : {
      internalAgents: Object.fromEntries(
        Object.entries(environment.internalAgents).map(([name, entry]) => [name, mergeEntry(entry)]),
      ),
    }),
    ...(environment.companions === undefined ? {} : {
      companions: Object.fromEntries(
        Object.entries(environment.companions).map(([name, entry]) => [name, mergeEntry(entry)]),
      ),
    }),
  };
}
