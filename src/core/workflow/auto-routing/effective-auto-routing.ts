import type { AutoRoutingConfig } from '../../models/config-types.js';

export function resolveEffectiveAutoRouting(
  inheritedAutoRouting: AutoRoutingConfig | undefined,
): AutoRoutingConfig | undefined {
  return inheritedAutoRouting;
}
