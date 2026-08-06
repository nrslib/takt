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
  // binding は述語が outside と判定した finding にだけ発行され、それが
  // 「タスク範囲外」を根拠とする dismissal の材料になる。したがって
  // コミット済み変更が加わることの効果は2方向ある。
  // - allowedRoots が空だった構成（作業ツリー差分が空）では binding がそもそも
  //   発行されなかった。非空になることで範囲外 finding への dismissal 根拠が
  //   新たに成立する。
  // - allowedRoots に path が増えることは、その path 上の finding を outside 判定
  //   から外し、その finding の dismissal 根拠を成立させなくする。
  // どちらもレビュー範囲と証拠検証範囲を揃えた結果であり、意図した挙動である。
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
