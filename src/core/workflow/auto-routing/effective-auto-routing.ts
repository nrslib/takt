import type { AutoRoutingConfig } from '../../models/config-types.js';
import type { WorkflowConfig } from '../../models/types.js';

export function resolveEffectiveAutoRouting(
  workflowConfig: Pick<WorkflowConfig, 'autoRouting'>,
  inheritedAutoRouting: AutoRoutingConfig | undefined,
): AutoRoutingConfig | undefined {
  return workflowConfig.autoRouting ?? inheritedAutoRouting;
}
