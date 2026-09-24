import type { StepProviderOptions } from '../../../core/models/workflow-types.js';
import type { ProviderOptionsOriginResolver } from '../../../core/workflow/provider-options-trace.js';
import {
  getPresentProviderOptionPaths,
} from '../providerOptionsContract.js';
import {
  mergeProviderOptions,
  resolveEffectiveProviderOptions,
  resolveProviderOptionOrigin,
} from '../providerOptions.js';
import { resolveProviderOptionsWithTrace } from '../resolveConfigValue.js';

function getProviderOptionValue(
  providerOptions: StepProviderOptions,
  path: string,
): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, providerOptions);
}

function setProviderOptionValue(
  providerOptions: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const segments = path.split('.');
  const lastSegment = segments.at(-1);
  if (lastSegment === undefined) {
    return;
  }
  let current = providerOptions;
  for (const segment of segments.slice(0, -1)) {
    const nested = current[segment];
    if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[lastSegment] = value;
}

function selectEnvironmentProviderOptions(
  providerOptions: StepProviderOptions | undefined,
  originResolver: ProviderOptionsOriginResolver,
): StepProviderOptions | undefined {
  if (providerOptions === undefined) {
    return undefined;
  }

  const selected: Record<string, unknown> = {};
  for (const path of getPresentProviderOptionPaths(providerOptions)) {
    const origin = resolveProviderOptionOrigin(originResolver, path, 'default');
    if (origin !== 'env' && origin !== 'cli') {
      continue;
    }
    const value = getProviderOptionValue(providerOptions, path);
    if (value !== undefined) {
      setProviderOptionValue(selected, path, value);
    }
  }
  return Object.keys(selected).length === 0
    ? undefined
    : selected as StepProviderOptions;
}

/**
 * Resolve runtime profile options with only explicit provider-options environment overrides.
 * Runtime profiles must not inherit unrelated project/global provider options.
 */
export function resolveRuntimeProviderOptions(
  projectCwd: string,
  runtimeOptions: StepProviderOptions | undefined,
  callOptions?: StepProviderOptions,
): StepProviderOptions | undefined {
  const resolved = resolveProviderOptionsWithTrace(projectCwd);
  const environmentOptions = selectEnvironmentProviderOptions(
    resolved.value,
    resolved.originResolver,
  );
  const runtimeAndCallOptions = mergeProviderOptions(runtimeOptions, callOptions);
  const providerOptions = resolveEffectiveProviderOptions(
    'env',
    resolved.originResolver,
    environmentOptions,
    runtimeAndCallOptions,
  );
  return providerOptions;
}
