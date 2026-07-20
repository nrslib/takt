import type { ProvisionalFindingSpec } from './reconciler.js';
import type {
  CanonicalRawFinding,
  FindingActionRecovery,
  FindingProvisionalKind,
  RawFinding,
} from './types.js';
import {
  computeLineageKey,
  computeProvisionalStableKey,
  computeReviewerStableKey,
} from './raw-canonicalization.js';

interface RawProvisionalSpecInput {
  wire: RawFinding;
  canonical: Pick<CanonicalRawFinding, 'reviewerStableKey' | 'lineageKey'>;
  reason: string;
}

function actionRecoveryLineageTag(action: FindingActionRecovery): string {
  switch (action.action) {
    case 'invalidate':
    case 'waive':
    case 'dismiss':
      return `${action.action}:${action.findingId}`;
    case 'duplicate':
      return [
        action.action,
        action.canonicalFindingId,
        ...[...action.duplicateFindingIds].sort(),
      ].join(':');
  }
}

export function provisionalSpecForRaw(input: RawProvisionalSpecInput): ProvisionalFindingSpec {
  return provisionalSpecForRawKind(input, 'raw-meaning-ambiguous');
}

export function provisionalSpecForRawKind(
  input: RawProvisionalSpecInput,
  kind: FindingProvisionalKind,
): ProvisionalFindingSpec {
  return {
    kind,
    stableKey: computeProvisionalStableKey({
      reviewerStableKey: input.canonical.reviewerStableKey,
      lineageKey: input.canonical.lineageKey,
      provisionalKind: kind,
    }),
    lineageKey: input.canonical.lineageKey,
    sourceRawFindingIds: [input.wire.rawFindingId],
    reason: input.reason,
    title: input.wire.title,
    severity: input.wire.severity,
    ...(input.wire.location !== undefined ? { location: input.wire.location } : {}),
    description: input.wire.description,
    ...(input.wire.suggestion !== undefined ? { suggestion: input.wire.suggestion } : {}),
    reviewers: [input.wire.reviewer],
    recoveryReviewerStableKey: input.canonical.reviewerStableKey,
  };
}

export function stalePreconditionSpec(input: {
  workflowName: string;
  callNamespace: string;
  parentStepName: string;
  targetFindingId: string;
  targetTitle: string;
  targetLocation?: string;
  sourceRawFindingIds: string[];
  reason: string;
  actionRecovery?: FindingActionRecovery;
}): ProvisionalFindingSpec {
  const reviewerStableKey = computeReviewerStableKey({
    workflowName: input.workflowName,
    callNamespace: input.callNamespace,
    parentStepName: input.parentStepName,
    reviewerPersonaKey: 'findings-manager',
  });
  const lineageKey = computeLineageKey({
    targetFindingId: input.targetFindingId,
    ...(input.targetLocation !== undefined ? { location: input.targetLocation } : {}),
    title: input.targetTitle,
    ...(input.actionRecovery !== undefined
      ? { familyTag: actionRecoveryLineageTag(input.actionRecovery) }
      : {}),
  });
  return {
    kind: 'stale-precondition',
    stableKey: computeProvisionalStableKey({ reviewerStableKey, lineageKey, provisionalKind: 'stale-precondition' }),
    lineageKey,
    sourceRawFindingIds: input.sourceRawFindingIds,
    reason: input.reason,
    title: `Stale precondition on finding ${input.targetFindingId}`,
    severity: 'high',
    description: input.reason,
    reviewers: ['findings-manager'],
    recoveryReviewerStableKey: reviewerStableKey,
    ...(input.actionRecovery !== undefined ? { actionRecovery: input.actionRecovery } : {}),
  };
}
