import type { WorkflowStep } from '../../models/types.js';

export function findingContractFormatRef(step: Pick<WorkflowStep, 'outputContracts'>): string | undefined {
  return step.outputContracts?.find((contract) => contract.formatRef?.endsWith('-finding-contract') === true)?.formatRef;
}

export function hasFindingContractFormat(step: Pick<WorkflowStep, 'outputContracts'>): boolean {
  return findingContractFormatRef(step) !== undefined;
}
