export type ProviderOptionsSource = 'env' | 'project' | 'global' | 'default';
export type ProviderOptionsTraceOrigin = 'env' | 'cli' | 'local' | 'global' | 'default';
export type ProviderOptionsOriginResolver = (path: string) => ProviderOptionsTraceOrigin;

/**
 * Source layer of a resolved provider/model value.
 *
 * Resolution priority (highest first):
 *   promotion > step > persona_providers > cli > project > global > default
 *
 * - `promotion`: step promotion override selected for the current execution
 * - `cli`: --provider / --model CLI flag
 * - `persona_providers`: workflow YAML's `persona_providers` map
 * - `step`: workflow YAML step's `provider` / `model` field
 * - `project`: project `.takt/config.yaml`
 * - `global`: `~/.takt/config.yaml`
 * - `default`: provider's built-in default (no explicit configuration)
 */
export type ProviderResolutionSource =
  | 'env'
  | 'promotion'
  | 'cli'
  | 'persona_providers'
  | 'step'
  | 'project'
  | 'global'
  | 'default';
