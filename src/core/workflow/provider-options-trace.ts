export type ProviderOptionsSource = 'env' | 'project' | 'global' | 'default';
export type ProviderOptionsTraceOrigin = 'env' | 'cli' | 'local' | 'global' | 'default';
export type ProviderOptionsOriginResolver = (path: string) => ProviderOptionsTraceOrigin;

/**
 * Source layer of a resolved provider/model value.
 *
 * Resolution priority (highest first):
 *   cli/env > promotion > step > workflow_call > provider_routing.steps >
 *   provider_routing.tags > provider_routing.personas > persona_providers >
 *   auto.rules/auto.ai/auto.default > workflow > project > global > default
 *
 * - `promotion`: step promotion override selected for the current execution
 * - `cli`: --provider / --model CLI flag
 * - `persona_providers`: workflow YAML's `persona_providers` map
 * - `step`: workflow YAML step's `provider` / `model` field
 * - `workflow`: workflow YAML's `workflow_config.provider` / `workflow_config.model`
 * - `project`: project `.takt/config.yaml`
 * - `global`: `~/.takt/config.yaml`
 * - `default`: provider's built-in default (no explicit configuration)
 */
export type ProviderResolutionSource =
  | 'env'
  | 'promotion'
  | 'auto.rules'
  | 'auto.ai'
  | 'auto.default'
  | 'cli'
  | 'persona_providers'
  | 'provider_routing.personas'
  | 'provider_routing.tags'
  | 'provider_routing.steps'
  | 'step'
  | 'workflow_call'
  | 'workflow'
  | 'project'
  | 'global'
  | 'default';
