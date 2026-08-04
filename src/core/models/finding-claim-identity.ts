import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/utils/canonical-json.js';
import { compareBinaryStrings } from '../../shared/utils/binary-string-comparator.js';
import type {
  CandidateSourceBinding,
  FindingClaimPayload,
  FindingTarget,
} from './finding-types.js';

export function normalizeFindingText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function assertBinarySortedUnique(values: readonly string[], field: string): void {
  const canonical = [...new Set(values)].sort(compareBinaryStrings);
  if (
    canonical.length !== values.length
    || canonical.some((value, index) => value !== values[index])
  ) {
    throw new Error(`${field} must be a binary-sorted unique string set`);
  }
}

/** identity 計算前に FindingTarget の canonical set 制約を強制する。 */
export function assertCanonicalFindingTarget(target: FindingTarget): void {
  switch (target.kind) {
    case 'review_scope':
      return;
    case 'code':
      assertBinarySortedUnique(target.paths, 'FindingTarget.code.paths');
      return;
    case 'structure':
      assertBinarySortedUnique(target.scope.roots, 'FindingTarget.structure.scope.roots');
      assertBinarySortedUnique(target.manifestTargets, 'FindingTarget.structure.manifestTargets');
      return;
    case 'absence':
      if (target.predicate.kind === 'exact_literal_search') {
        assertBinarySortedUnique(
          target.predicate.roots,
          'FindingTarget.absence.predicate.roots',
        );
      }
      return;
  }
}

/** target だけを表す content address。claim 文言や証拠を含めない。 */
export function computeTargetIdentityHash(target: FindingTarget): string {
  assertCanonicalFindingTarget(target);
  return createHash('sha256').update(canonicalJson({
    domain: 'finding-target-identity',
    version: 1,
    target,
  })).digest('hex');
}

/**
 * target + exact claim payload の content address。
 * relation/targetFindingId/proof/snapshot/run/source binding は意図的に含めない。
 */
export function computeClaimIdentityHash(
  input: { target: FindingTarget } & FindingClaimPayload,
): string {
  assertCanonicalFindingTarget(input.target);
  return createHash('sha256').update(canonicalJson({
    domain: 'finding-claim-identity',
    version: 1,
    target: input.target,
    familyTag: input.familyTag,
    severity: input.severity,
    title: input.title,
    description: input.description,
    suggestion: input.suggestion,
  })).digest('hex');
}

/**
 * 重複・同一欠陥判定用の semantic content address。
 * 証拠へ束縛する exact claim identity とは分離し、分類・優先度・提案文は含めない。
 */
export function computeSemanticClaimIdentityHash(
  input: {
    target: FindingTarget;
    title: string | null;
    description: string | null;
  },
): string {
  assertCanonicalFindingTarget(input.target);
  return createHash('sha256').update(canonicalJson({
    domain: 'finding-semantic-claim-identity',
    version: 1,
    target: input.target,
    title: input.title,
    description: input.description,
  })).digest('hex');
}

/** engine が検証した review report source binding を claim identity へ束縛する。 */
export function computeCandidateIdentityHash(input: {
  claimIdentityHash: string;
  sourceBinding: CandidateSourceBinding;
}): string {
  return createHash('sha256').update(canonicalJson({
    domain: 'finding-candidate-identity',
    version: 1,
    claimIdentityHash: input.claimIdentityHash,
    sourceBinding: input.sourceBinding,
  })).digest('hex');
}
