import type { StepProviderOptions } from '../../core/models/workflow-types.js';
import { mergeProviderOptions, normalizeProviderOptions } from './providerOptions.js';
import { normalizeProviderBlockOptions } from './providerBlockOptions.js';

export type ConfigProviderBlock<ProviderType extends string> = {
  type: ProviderType;
  model?: string;
  network_access?: boolean;
  sandbox?: {
    allow_unsandboxed_commands?: boolean;
    excluded_commands?: string[];
  };
};

export type ConfigProviderReference<ProviderType extends string> =
  | ProviderType
  | ConfigProviderBlock<ProviderType>
  | undefined;

export type NormalizedConfigProviderReference<ProviderType extends string> = {
  provider: ProviderType | undefined;
  model: string | undefined;
  providerOptions: StepProviderOptions | undefined;
  providerSpecified: boolean;
};

export function normalizeConfigProviderReferenceDetailed<ProviderType extends string>(
  provider: ConfigProviderReference<ProviderType>,
  model: string | undefined,
  providerOptions: Record<string, unknown> | undefined,
): NormalizedConfigProviderReference<ProviderType> {
  if (typeof provider === 'string' || provider === undefined) {
    return {
      provider,
      model,
      providerOptions: normalizeProviderOptions(providerOptions),
      providerSpecified: provider !== undefined,
    };
  }

  return {
    provider: provider.type,
    model: provider.model ?? model,
    providerOptions: mergeProviderOptions(
      normalizeProviderBlockOptions(provider),
      normalizeProviderOptions(providerOptions),
    ),
    providerSpecified: true,
  };
}

export function normalizeConfigProviderReference<ProviderType extends string>(
  provider: ConfigProviderReference<ProviderType>,
  model: string | undefined,
  providerOptions: Record<string, unknown> | undefined,
): {
  provider: ProviderType | undefined;
  model: string | undefined;
  providerOptions: StepProviderOptions | undefined;
} {
  const normalized = normalizeConfigProviderReferenceDetailed(provider, model, providerOptions);
  return {
    provider: normalized.provider,
    model: normalized.model,
    providerOptions: normalized.providerOptions,
  };
}
