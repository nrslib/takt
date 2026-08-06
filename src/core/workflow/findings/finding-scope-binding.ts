import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import {
  binarySortedUnique,
  computeFindingScopeBindingId,
  findingContentAddress,
} from '../../models/finding-contract-identity.js';
import type { FindingScopeBinding } from '../../models/finding-contract-types.js';
import {
  expectedFindingScopeBindingDependencies,
  FINDING_SCOPE_VERIFIER_ID,
  FINDING_SCOPE_VERIFIER_VERSION,
} from '../../models/finding-scope-binding-dependencies.js';
import { findingScopePredicateResult } from '../../models/finding-scope-predicate.js';
import type { FindingContractConfig } from '../../models/finding-types.js';
import type { ReviewScopeProofSnapshot } from './snapshot.js';
import type { FindingLedgerEntry, FindingObservation } from './types.js';
import { computeWorkflowTaskDigest } from './task-scope-adjudication.js';

function issue(input: {
  source: FindingScopeBinding['source'];
  finding: FindingLedgerEntry;
  expectedHead: NonNullable<FindingScopeBinding['expectedHead']>;
  workflowTaskDigest: string;
  findingContractDigest: string;
  predicate: FindingScopeBinding['predicate'];
  dependencyDigests: string[];
  issuedAt: FindingObservation;
}): FindingScopeBinding | undefined {
  if (findingScopePredicateResult({ predicate: input.predicate, finding: input.finding }) !== 'outside') {
    return undefined;
  }
  const content = {
    source: input.source,
    findingId: input.finding.id,
    expectedHead: structuredClone(input.expectedHead),
    workflowTaskDigest: input.workflowTaskDigest,
    findingContractDigest: input.findingContractDigest,
    predicate: structuredClone(input.predicate),
    result: 'outside' as const,
    verifierId: FINDING_SCOPE_VERIFIER_ID,
    verifierVersion: FINDING_SCOPE_VERIFIER_VERSION,
    dependencyDigests: binarySortedUnique(input.dependencyDigests),
  };
  return {
    bindingId: computeFindingScopeBindingId(content),
    ...content,
    issuedAt: structuredClone(input.issuedAt),
  };
}

export function issueFindingScopeBindings(input: {
  finding: FindingLedgerEntry;
  expectedHead: NonNullable<FindingScopeBinding['expectedHead']>;
  workflowTask: string;
  contract: FindingContractConfig;
  reviewScopeSnapshot: ReviewScopeProofSnapshot;
  issuedAt: FindingObservation;
}): FindingScopeBinding[] {
  const workflowTaskDigest = computeWorkflowTaskDigest(input.workflowTask);
  const findingContractDigest = findingContentAddress('finding-contract-config', input.contract);
  const bindings: FindingScopeBinding[] = [];
  // changedPaths は base コミット以降のコミット済み変更も含む（review-scope.ts）。
  // そのため作業ツリー差分が空になる構成でも allowedRoots が空にならず、
  // タスク範囲外の finding に対する dismissal 根拠が成立し得る。判定が緩む方向では
  // なく締まる方向に動くのは意図した挙動である。
  const allowedRoots = input.reviewScopeSnapshot.changedPaths === undefined
    ? []
    : binarySortedUnique(input.reviewScopeSnapshot.changedPaths);
  if (allowedRoots.length > 0) {
    const binding = issue({
      source: 'workflow_task_scope',
      finding: input.finding,
      expectedHead: input.expectedHead,
      workflowTaskDigest,
      findingContractDigest,
      predicate: { kind: 'target_path_roots', allowedRoots },
      dependencyDigests: expectedFindingScopeBindingDependencies({
        source: 'workflow_task_scope',
        workflowTaskDigest,
        findingContractDigest,
        reviewScopeSnapshotId: input.reviewScopeSnapshot.reviewScopeSnapshotId,
      }),
      issuedAt: input.issuedAt,
    });
    if (binding !== undefined) {
      bindings.push(binding);
    }
  }
  const contractBinding = issue({
    source: 'finding_contract_scope',
    finding: input.finding,
    expectedHead: input.expectedHead,
    workflowTaskDigest,
    findingContractDigest,
    predicate: {
      kind: 'target_kind_set',
      allowedKinds: ['code', 'structure', 'absence'],
    },
    dependencyDigests: expectedFindingScopeBindingDependencies({
      source: 'finding_contract_scope',
      workflowTaskDigest,
      findingContractDigest,
      reviewScopeSnapshotId: input.reviewScopeSnapshot.reviewScopeSnapshotId,
    }),
    issuedAt: input.issuedAt,
  });
  if (contractBinding !== undefined) {
    bindings.push(contractBinding);
  }
  return bindings.sort((left, right) => compareBinaryStrings(left.bindingId, right.bindingId));
}
