import type { FindingIntakeNormalizeConfig } from '../../models/config-types.js';
import type { FindingContractConfig } from '../../models/finding-types.js';
import {
  providerSupportsIsolatedStructuredExecution,
} from '../../../infra/providers/provider-capabilities.js';

export function resolveFindingIntakeNormalizeConfig(
  config: FindingIntakeNormalizeConfig | undefined,
  workflowName: string,
  findingContract: FindingContractConfig | undefined,
): FindingIntakeNormalizeConfig | undefined {
  if (findingContract?.reviewerOutput !== 'plain_text_normalized') {
    return undefined;
  }
  if (config === undefined) {
    throw new Error(
      `Configuration error: workflow "${workflowName}" uses finding_contract.reviewer_output `
      + '"plain_text_normalized" but intake_normalize is not configured',
    );
  }
  if (config.targets !== undefined && !config.targets.includes(workflowName)) {
    throw new Error(
      `Configuration error: workflow "${workflowName}" uses finding_contract.reviewer_output `
      + '"plain_text_normalized" but is not included in intake_normalize.targets',
    );
  }
  if (providerSupportsIsolatedStructuredExecution(config.provider) !== true) {
    throw new Error(
      `Configuration error: intake_normalize provider "${config.provider}" does not support `
      + 'isolated structured execution',
    );
  }
  return config;
}
