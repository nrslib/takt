import type { FindingLedger } from './types.js';
import type { ReviewerIntakeResult } from './manager-admission.js';
import type {
  PreAdmissionEntityBinding,
  PreAdmissionEntityProvisionalMutation,
} from './pre-admission-entity-binding-types.js';
import {
  collectEntityBindingComponents,
  componentForEntityBindingGroup,
  entityBindingDigest,
  uniqueExactSemanticFinding,
  type BindingCandidate,
  type EntityBindingComponent,
} from './pre-admission-entity-binding-identity.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';

export interface EntityBindingAuditAttachment {
  rawFindingId: string;
  targetFindingId: string;
  reason: string;
}

export interface ResolvedPreAdmissionEntityBindings {
  mutations: PreAdmissionEntityProvisionalMutation[];
  auditAttachments: EntityBindingAuditAttachment[];
}

function bindingCandidates(
  intake: ReviewerIntakeResult,
  rawFindingIds: readonly string[],
): BindingCandidate[] {
  const itemByRawId = new Map(
    intake.items.map((item) => [item.wire.rawFindingId, item]),
  );
  return rawFindingIds.map((rawFindingId) => {
    const item = itemByRawId.get(rawFindingId);
    if (item === undefined) {
      throw new Error(
        `Pre-admission entity group references missing raw finding "${rawFindingId}"`,
      );
    }
    return { item, target: item.canonical.target };
  });
}

function claimMutation(input: {
  binding: Pick<
    Extract<PreAdmissionEntityBinding, { kind: 'entity_group' }>,
    'creationRequestKey' | 'reason'
  >;
  candidates: readonly BindingCandidate[];
  provisionalKind: Extract<
    PreAdmissionEntityProvisionalMutation,
    { operation: 'create_new' }
  >['provisionalKind'];
  creationRequestKey?: string;
}): PreAdmissionEntityProvisionalMutation {
  const ordered = [...input.candidates].sort((left, right) => compareBinaryStrings(
    left.item.wire.rawFindingId,
    right.item.wire.rawFindingId,
  ));
  const representative = [...input.candidates].sort((left, right) => {
    const semanticOrder = compareBinaryStrings(
      canonicalJson({
        target: left.item.wire.target,
        title: left.item.wire.title,
        severity: left.item.wire.severity,
        description: left.item.wire.description,
        suggestion: left.item.wire.suggestion,
        claimIdentityHash: left.item.wire.claimIdentityHash,
        semanticClaimIdentityHash: left.item.wire.semanticClaimIdentityHash,
      }),
      canonicalJson({
        target: right.item.wire.target,
        title: right.item.wire.title,
        severity: right.item.wire.severity,
        description: right.item.wire.description,
        suggestion: right.item.wire.suggestion,
        claimIdentityHash: right.item.wire.claimIdentityHash,
        semanticClaimIdentityHash: right.item.wire.semanticClaimIdentityHash,
      }),
    );
    return semanticOrder !== 0
      ? semanticOrder
      : compareBinaryStrings(
        left.item.wire.rawFindingId,
        right.item.wire.rawFindingId,
      );
  }).at(-1);
  if (representative === undefined) {
    throw new Error('Pre-admission entity creation requires at least one raw finding');
  }
  return {
    operation: 'create_new',
    creationRequestKey: input.creationRequestKey ?? input.binding.creationRequestKey,
    provisionalKind: input.provisionalKind,
    sourceRawFindingIds: ordered.map((candidate) => candidate.item.wire.rawFindingId),
    reason: input.binding.reason,
    title: representative.item.wire.title,
    severity: representative.item.wire.severity,
    ...(representative.item.wire.description !== null
      ? { description: representative.item.wire.description }
      : {}),
    ...(representative.item.wire.suggestion !== null
      ? { suggestion: representative.item.wire.suggestion }
      : {}),
    reviewers: [...new Set(ordered.map((candidate) => candidate.item.wire.reviewer))],
    target: representative.item.wire.target,
    targetIdentityHash: representative.item.wire.targetIdentityHash,
    claimIdentityHash: representative.item.wire.claimIdentityHash,
    semanticClaimIdentityHash: representative.item.wire.semanticClaimIdentityHash,
  };
}

function attachMutation(input: {
  component: EntityBindingComponent;
  candidates: readonly BindingCandidate[];
  reason: string;
}): PreAdmissionEntityProvisionalMutation | undefined {
  const canonical = [...input.component.openAmbiguityEpisodes]
    .sort((left, right) => compareBinaryStrings(left.id, right.id))[0];
  if (canonical?.provisional === undefined) {
    return undefined;
  }
  return {
    operation: 'attach_existing',
    findingId: canonical.id,
    expectedKind: 'raw-meaning-ambiguous',
    expectedStableKey: canonical.provisional.stableKey,
    expectedLineageKey: canonical.provisional.lineageKey,
    sourceRawFindingIds: input.candidates
      .map((candidate) => candidate.item.wire.rawFindingId)
      .sort(compareBinaryStrings),
    reviewers: [...new Set(input.candidates.map(
      (candidate) => candidate.item.wire.reviewer,
    ))],
    reason: input.reason,
  };
}

function resolveUncertainty(input: {
  binding: Pick<
    Extract<PreAdmissionEntityBinding, { kind: 'entity_group' }>,
    'creationRequestKey' | 'reason'
  >;
  candidates: readonly BindingCandidate[];
  ledger: FindingLedger;
}): PreAdmissionEntityProvisionalMutation[] {
  const components = collectEntityBindingComponents(input.ledger, input.candidates);
  return components.map((component, componentOrdinal) => {
    const attach = attachMutation({
      component,
      candidates: component.candidates,
      reason: input.binding.reason,
    });
    if (attach !== undefined) {
      return attach;
    }
    return claimMutation({
      binding: input.binding,
      candidates: component.candidates,
      provisionalKind: 'raw-meaning-ambiguous',
      creationRequestKey: componentOrdinal === 0
        ? input.binding.creationRequestKey
        : entityBindingDigest('finding-provisional-split-creation-request-v1', {
            creationRequestKey: input.binding.creationRequestKey,
            componentOrdinal,
          }),
    });
  });
}

function groupedBindings(
  intake: ReviewerIntakeResult,
): Array<Extract<PreAdmissionEntityBinding, { kind: 'entity_group' }>> {
  const byCreationRequest = new Map<string, Extract<
    PreAdmissionEntityBinding,
    { kind: 'entity_group' }
  >>();
  for (const binding of intake.entityBindings.values()) {
    if (binding.kind === 'entity_group') {
      byCreationRequest.set(binding.creationRequestKey, binding);
    }
  }
  return [...byCreationRequest.values()].sort((left, right) => compareBinaryStrings(
    left.commitOrderKey,
    right.commitOrderKey,
  ));
}

export function resolvePreAdmissionEntityBindings(input: {
  ledger: FindingLedger;
  intake: ReviewerIntakeResult;
}): ResolvedPreAdmissionEntityBindings {
  const mutations: PreAdmissionEntityProvisionalMutation[] = [];
  const auditAttachments: EntityBindingAuditAttachment[] = [];
  const boundRawIds = new Set<string>();

  for (const binding of groupedBindings(input.intake)) {
    const candidates = bindingCandidates(input.intake, binding.groupRawFindingIds);
    for (const candidate of candidates) {
      boundRawIds.add(candidate.item.wire.rawFindingId);
    }
    const component = componentForEntityBindingGroup(input.ledger, candidates);
    const exact = binding.decision === 'new_entity'
      ? uniqueExactSemanticFinding(candidates, input.ledger)
      : undefined;
    if (exact !== undefined) {
      auditAttachments.push(...candidates.map((candidate) => ({
        rawFindingId: candidate.item.wire.rawFindingId,
        targetFindingId: exact.id,
        reason: `${binding.reason}; a unique exact semantic entity appeared before commit`,
      })));
      continue;
    }
    if (
      binding.decision === 'new_entity'
      && component !== undefined
      && component.locusHeadDigest === binding.capturedLocusHeadDigest
    ) {
      mutations.push(claimMutation({
        binding,
        candidates,
        provisionalKind: 'raw-adjudication-unresolved',
      }));
      continue;
    }
    mutations.push(...resolveUncertainty({
      binding,
      candidates,
      ledger: input.ledger,
    }));
  }

  for (const [rawFindingId, binding] of input.intake.entityBindings) {
    if (binding.kind !== 'bind_existing' || boundRawIds.has(rawFindingId)) {
      continue;
    }
    const target = input.ledger.findings.find(
      (finding) => finding.id === binding.targetFindingId,
    );
    if (
      target?.targetIdentityHash !== null
      && target?.targetIdentityHash === binding.expectedTargetIdentityHash
    ) {
      auditAttachments.push({
        rawFindingId,
        targetFindingId: target.id,
        reason: binding.reason,
      });
      continue;
    }
    const candidates = bindingCandidates(input.intake, [rawFindingId]);
    const fallbackBinding = {
      creationRequestKey: binding.fallbackCreationRequestKey,
      reason: `${binding.reason}; target identity changed before commit`,
    };
    mutations.push(...resolveUncertainty({
      binding: fallbackBinding,
      candidates,
      ledger: input.ledger,
    }));
  }

  return { mutations, auditAttachments };
}
