import type { FindingIntakeNormalizeConfig } from '../../models/config-types.js';
import type { FindingContractConfig } from '../../models/finding-types.js';
import {
  providerSupportsIsolatedStructuredExecution,
} from '../../../infra/providers/provider-capabilities.js';

export function resolveFindingIntakeNormalizeConfig(
  config: FindingIntakeNormalizeConfig | undefined,
  findingContract: FindingContractConfig | undefined,
): FindingIntakeNormalizeConfig | undefined {
  if (findingContract === undefined || config === undefined) {
    return undefined;
  }
  if (providerSupportsIsolatedStructuredExecution(config.provider) !== true) {
    throw new Error(
      `Configuration error: finding_contract.intake_normalize provider "${config.provider}" does not support `
      + 'isolated structured execution',
    );
  }
  return config;
}

export function findingIntakeNormalizerTargetsStep(
  config: FindingIntakeNormalizeConfig | undefined,
  reviewer: {
    readonly provider: FindingIntakeNormalizeConfig['provider'] | undefined;
    readonly model: string | undefined;
  },
): boolean {
  if (config === undefined) {
    return false;
  }
  if (config.targets === undefined) {
    return true;
  }
  return config.targets.some((target) =>
    target.provider === reviewer.provider
    && target.model === reviewer.model
  );
}
