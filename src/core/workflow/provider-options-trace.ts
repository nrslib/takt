export type ProviderOptionsSource = 'env' | 'project' | 'global' | 'default';
export type ProviderOptionsTraceOrigin = 'env' | 'cli' | 'local' | 'global' | 'default';
export type ProviderOptionsOriginResolver = (path: string) => ProviderOptionsTraceOrigin;

/**
 * Source layer of a resolved provider/model value.
 *
 * Resolution priority (highest first):
 *   promotion > step > provider_routing.* > persona_providers > workflow > cli > project > global > default
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
  | 'cli'
  | 'persona_providers'
  | 'provider_routing.personas'
  | 'provider_routing.tags'
  | 'provider_routing.steps'
  | 'step'
  | 'workflow'
  | 'project'
  | 'global'
  | 'default';
