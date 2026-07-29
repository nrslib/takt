import type { FindingIntakeNormalizeConfig } from '../../models/config-types.js';
import type { FindingContractConfig } from '../../models/finding-types.js';

export function resolveFindingIntakeNormalizeConfig(
  config: FindingIntakeNormalizeConfig | undefined,
  workflowName: string,
  findingContract: FindingContractConfig | undefined,
): FindingIntakeNormalizeConfig | undefined {
  if (config === undefined || findingContract === undefined) {
    return undefined;
  }
  if (config.targets !== undefined && !config.targets.includes(workflowName)) {
    return undefined;
  }
  return config;
}
