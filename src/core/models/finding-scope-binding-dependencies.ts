import { compareBinaryStrings } from '../../shared/utils/binary-string-comparator.js';
import type { FindingScopeBinding } from './finding-contract-types.js';

export const FINDING_SCOPE_VERIFIER_ID = 'takt.finding-scope';
export const FINDING_SCOPE_VERIFIER_VERSION = '1';

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareBinaryStrings);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function expectedFindingScopeBindingDependencies(input: {
  source: FindingScopeBinding['source'];
  workflowTaskDigest: string;
  findingContractDigest: string;
  reviewScopeSnapshotId: string;
}): string[] {
  const dependencies = [input.workflowTaskDigest, input.findingContractDigest];
  if (input.source === 'workflow_task_scope') {
    dependencies.push(input.reviewScopeSnapshotId);
  }
  return sortedUnique(dependencies);
}

export function findingScopeBindingDependencyViolation(
  binding: FindingScopeBinding,
): string | undefined {
  if (
    binding.verifierId !== FINDING_SCOPE_VERIFIER_ID
    || binding.verifierVersion !== FINDING_SCOPE_VERIFIER_VERSION
  ) {
    return `Finding scope binding "${binding.bindingId}" has an unsupported verifier`;
  }
  const required = sortedUnique([
    binding.workflowTaskDigest,
    binding.findingContractDigest,
  ]);
  if (binding.source === 'finding_contract_scope') {
    return sameSet(binding.dependencyDigests, required)
      ? undefined
      : `Finding scope binding "${binding.bindingId}" has mismatched dependencies`;
  }
  const reviewScopeDependencies = binding.dependencyDigests.filter(
    (digest) => !required.includes(digest),
  );
  return binding.dependencyDigests.length === required.length + 1
    && reviewScopeDependencies.length === 1
    ? undefined
    : `Finding scope binding "${binding.bindingId}" has mismatched dependencies`;
}

export function findingScopeBindingMatchesCurrentDependencies(input: {
  binding: FindingScopeBinding;
  workflowTaskDigest: string;
  findingContractDigest: string;
  reviewScopeSnapshotId: string;
}): boolean {
  return findingScopeBindingDependencyViolation(input.binding) === undefined
    && input.binding.workflowTaskDigest === input.workflowTaskDigest
    && input.binding.findingContractDigest === input.findingContractDigest
    && sameSet(
      input.binding.dependencyDigests,
      expectedFindingScopeBindingDependencies({
        source: input.binding.source,
        workflowTaskDigest: input.workflowTaskDigest,
        findingContractDigest: input.findingContractDigest,
        reviewScopeSnapshotId: input.reviewScopeSnapshotId,
      }),
    );
}
