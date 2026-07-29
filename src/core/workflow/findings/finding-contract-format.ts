import type { WorkflowStep } from '../../models/types.js';

export interface FindingContractFormatReference {
  format: string;
  index: number;
}

export function findFindingContractFormat(
  step: Pick<WorkflowStep, 'outputContracts'>,
): FindingContractFormatReference | undefined {
  for (const [index, contract] of (step.outputContracts ?? []).entries()) {
    if (contract.formatRef?.endsWith('-finding-contract') === true) {
      return { format: contract.formatRef, index };
    }
  }
  return undefined;
}

export function hasFindingContractFormat(step: Pick<WorkflowStep, 'outputContracts'>): boolean {
  return findFindingContractFormat(step) !== undefined;
}
