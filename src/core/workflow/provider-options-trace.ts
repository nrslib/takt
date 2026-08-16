export type ProviderOptionsSource = 'env' | 'project' | 'global' | 'default';
export type ProviderOptionsTraceOrigin = 'env' | 'cli' | 'local' | 'global' | 'default';
export type ProviderOptionsOriginResolver = (path: string) => ProviderOptionsTraceOrigin;

/**
 * Source layer of a resolved provider/model value.
 *
 * Resolution priority (highest first):
 *   cli/env > promotion > step > provider_routing.steps >
 *   provider_routing.tags > provider_routing.personas > persona_providers >
 *   auto.rules/auto.dynamic/auto.fallback > project/global/runtime-v1 > default
 *
 * - `promotion`: step promotion override selected for the current execution
 * - `cli`: --provider / --model CLI flag
 * - `persona_providers`: legacy config's `persona_providers` map
 * - `step`: engine-synthesized step provider/model fields
 * - `project`: project `.takt/config.yaml`
 * - `global`: `~/.takt/config.yaml`
 * - `runtime-v1`: runtime.yaml `provider.defaults` (issue #1136 runtime-v1 mode)
 * - `default`: provider's built-in default (no explicit configuration)
 */
export type ProviderResolutionSource =
  | 'env'
  | 'promotion'
  | 'auto.rules'
  | 'auto.dynamic'
  | 'auto.fallback'
  | 'cli'
  | 'persona_providers'
  | 'provider_routing.personas'
  | 'provider_routing.tags'
  | 'provider_routing.steps'
  | 'step'
  | 'capabilities'
  | 'project'
  | 'global'
  | 'runtime-v1'
  | 'default';
