import type { StepProviderOptions } from '../../../core/models/workflow-types.js';
import type { ProviderType } from '../../../shared/types/provider.js';
import {
  mergeProviderOptions,
  resolveEffectiveProviderOptions,
  selectEnvironmentProviderOptions,
} from '../providerOptions.js';
import { getProviderOptionRoots } from '../providerOptionsContract.js';
import { resolveProviderOptionsWithTrace } from '../resolveConfigValue.js';

/**
 * Resolve runtime profile options with only explicit provider-options environment overrides.
 * Runtime profiles must not inherit unrelated project/global provider options.
 */
export function resolveRuntimeProviderOptions(
  projectCwd: string,
  provider: ProviderType | undefined,
  runtimeOptions: StepProviderOptions | undefined,
  callOptions?: StepProviderOptions,
): StepProviderOptions | undefined {
  const resolved = resolveProviderOptionsWithTrace(projectCwd);
  const environmentOptions = provider === undefined
    ? undefined
    : selectEnvironmentProviderOptions(
      resolved.value,
      resolved.originResolver,
      getProviderOptionRoots(provider),
    );
  const runtimeAndCallOptions = mergeProviderOptions(runtimeOptions, callOptions);
  const providerOptions = resolveEffectiveProviderOptions(
    'env',
    resolved.originResolver,
    environmentOptions,
    runtimeAndCallOptions,
    undefined,
    provider,
  );
  return providerOptions;
}
