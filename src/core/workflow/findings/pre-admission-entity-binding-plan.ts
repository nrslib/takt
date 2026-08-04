import type { FindingLedger } from './types.js';
import type { FindingEntityBindingTaskOutput } from './manager-task-contracts.js';
import type { PreAdmissionEntityBinding } from './pre-admission-entity-binding-types.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import {
  entityCreationRequestKey,
  sharesTargetLocus,
  type BindingCandidate,
  type EntityBindingComponent,
} from './pre-admission-entity-binding-identity.js';

interface NormalizedEntityGroup {
  decision: 'new_entity' | 'ambiguous';
  candidates: BindingCandidate[];
  reason: string;
  component: EntityBindingComponent;
  sortKey: string;
}

function componentByRawFindingId(
  components: readonly EntityBindingComponent[],
): Map<string, EntityBindingComponent> {
  return new Map(components.flatMap((component) => (
    component.candidates.map((candidate) => [
      candidate.item.wire.rawFindingId,
      component,
    ] as const)
  )));
}

function normalizeGroups(input: {
  decisions: readonly FindingEntityBindingTaskOutput['decisions'][number][];
  candidates: readonly BindingCandidate[];
  components: readonly EntityBindingComponent[];
}): NormalizedEntityGroup[] {
  const candidateByRawId = new Map(
    input.candidates.map((candidate) => [candidate.item.wire.rawFindingId, candidate]),
  );
  const componentByRawId = componentByRawFindingId(input.components);
  const decisionsByGroup = new Map<string, FindingEntityBindingTaskOutput['decisions']>();
  for (const decision of input.decisions) {
    if (decision.decision === 'bind_existing') {
      continue;
    }
    decisionsByGroup.set(
      decision.groupRawFindingId,
      [...(decisionsByGroup.get(decision.groupRawFindingId) ?? []), decision],
    );
  }
  return [...decisionsByGroup.entries()].map(([groupRawFindingId, decisions]) => {
    const candidates = decisions.map((decision) => {
      const candidate = candidateByRawId.get(decision.rawFindingId);
      if (candidate === undefined) {
        throw new Error('Entity binding group references an unknown raw finding');
      }
      return candidate;
    });
    const component = componentByRawId.get(groupRawFindingId);
    const firstDecision = decisions[0];
    if (component === undefined || firstDecision === undefined) {
      throw new Error('Entity binding group has no connected component');
    }
    if (candidates.some((candidate) => (
      componentByRawId.get(candidate.item.wire.rawFindingId) !== component
    ))) {
      throw new Error('Entity binding task grouped disjoint target components');
    }
    const decision = firstDecision.decision;
    const semanticMembers = candidates.map((candidate) => ({
      semanticClaimIdentityHash: candidate.item.wire.semanticClaimIdentityHash,
      claimIdentityHash: candidate.item.wire.claimIdentityHash,
      targetIdentityHash: candidate.item.wire.targetIdentityHash,
    })).sort((left, right) => compareBinaryStrings(
      canonicalJson(left),
      canonicalJson(right),
    ));
    return {
      decision: decision as 'new_entity' | 'ambiguous',
      candidates,
      component,
      reason: decisions.map((item) => item.reason).join('; '),
      sortKey: canonicalJson({
        componentKey: component.componentKey,
        decision,
        semanticMembers,
      }),
    };
  }).sort((left, right) => compareBinaryStrings(left.sortKey, right.sortKey));
}

export function validateEntityBindingDecisions(input: {
  taskId: string;
  output: FindingEntityBindingTaskOutput;
  candidates: readonly BindingCandidate[];
  ledger: FindingLedger;
  components: readonly EntityBindingComponent[];
  allowedFindingIds: ReadonlySet<string>;
}): FindingEntityBindingTaskOutput['decisions'] {
  if (input.output.taskId !== input.taskId) {
    throw new Error(
      `Entity binding task "${input.taskId}" returned mismatched taskId "${input.output.taskId}"`,
    );
  }
  const candidateByRawId = new Map(
    input.candidates.map((candidate) => [candidate.item.wire.rawFindingId, candidate]),
  );
  const decisionByRawId = new Map<string, FindingEntityBindingTaskOutput['decisions'][number]>();
  for (const decision of input.output.decisions) {
    const candidate = candidateByRawId.get(decision.rawFindingId);
    if (candidate === undefined || decisionByRawId.has(decision.rawFindingId)) {
      throw new Error(`Entity binding task "${input.taskId}" returned an invalid raw id set`);
    }
    if (decision.decision === 'bind_existing') {
      const finding = input.ledger.findings.find((entry) => entry.id === decision.findingId);
      if (
        finding?.target === null
        || finding?.target === undefined
        || !input.allowedFindingIds.has(decision.findingId)
        || decision.groupRawFindingId !== ''
        || !sharesTargetLocus(candidate.target, finding.target)
      ) {
        throw new Error(`Entity binding task "${input.taskId}" returned an invalid existing binding`);
      }
    } else if (
      decision.findingId !== ''
      || !candidateByRawId.has(decision.groupRawFindingId)
    ) {
      throw new Error(`Entity binding task "${input.taskId}" returned an invalid entity group`);
    }
    decisionByRawId.set(decision.rawFindingId, decision);
  }
  if (decisionByRawId.size !== input.candidates.length) {
    throw new Error(`Entity binding task "${input.taskId}" omitted owned raw findings`);
  }
  for (const decision of decisionByRawId.values()) {
    if (decision.decision === 'bind_existing') {
      continue;
    }
    const leader = decisionByRawId.get(decision.groupRawFindingId);
    if (
      leader?.decision !== decision.decision
      || leader.groupRawFindingId !== leader.rawFindingId
    ) {
      throw new Error(`Entity binding task "${input.taskId}" returned an inconsistent entity group`);
    }
  }
  normalizeGroups({
    decisions: [...decisionByRawId.values()],
    candidates: input.candidates,
    components: input.components,
  });
  return [...decisionByRawId.values()];
}

export function planManagerEntityBindings(input: {
  taskId: string;
  roundMarker: string;
  decisions: readonly FindingEntityBindingTaskOutput['decisions'][number][];
  candidates: readonly BindingCandidate[];
  components: readonly EntityBindingComponent[];
  ledger: FindingLedger;
}): Map<string, PreAdmissionEntityBinding> {
  const bindings = new Map<string, PreAdmissionEntityBinding>();
  const groups = normalizeGroups(input);
  groups.forEach((group, groupOrdinal) => {
    const groupRawFindingIds = group.candidates
      .map((candidate) => candidate.item.wire.rawFindingId)
      .sort(compareBinaryStrings);
    const binding: PreAdmissionEntityBinding = {
      kind: 'entity_group',
      decision: group.decision,
      creationRequestKey: entityCreationRequestKey({
        roundMarker: input.roundMarker,
        taskId: input.taskId,
        groupOrdinal,
      }),
      commitOrderKey: group.sortKey,
      capturedLocusHeadDigest: group.component.locusHeadDigest,
      groupRawFindingIds,
      reason: group.reason,
    };
    for (const rawFindingId of groupRawFindingIds) {
      bindings.set(rawFindingId, binding);
    }
  });
  for (const decision of input.decisions) {
    if (decision.decision !== 'bind_existing') {
      continue;
    }
    const candidate = input.candidates.find(
      (item) => item.item.wire.rawFindingId === decision.rawFindingId,
    );
    if (candidate === undefined) {
      throw new Error('Entity binding decision lost its raw finding');
    }
    const component = input.components.find(
      (item) => item.candidates.includes(candidate),
    );
    const finding = input.ledger.findings.find((entry) => entry.id === decision.findingId);
    if (
      component === undefined
      || finding?.targetIdentityHash === null
      || finding?.targetIdentityHash === undefined
    ) {
      throw new Error('Entity binding decision lost its ledger entity');
    }
    bindings.set(decision.rawFindingId, {
      kind: 'bind_existing',
      targetFindingId: finding.id,
      expectedTargetIdentityHash: finding.targetIdentityHash,
      fallbackCreationRequestKey: entityCreationRequestKey({
        roundMarker: input.roundMarker,
        taskId: input.taskId,
        groupOrdinal: groups.length + input.candidates.indexOf(candidate),
      }),
      capturedLocusHeadDigest: component.locusHeadDigest,
      reason: decision.reason,
    });
  }
  return bindings;
}

export function planFallbackEntityBindings(input: {
  taskId: string;
  roundMarker: string;
  components: readonly EntityBindingComponent[];
  reason: string;
}): Map<string, PreAdmissionEntityBinding> {
  const bindings = new Map<string, PreAdmissionEntityBinding>();
  input.components.forEach((component, groupOrdinal) => {
    const groupRawFindingIds = component.candidates
      .map((candidate) => candidate.item.wire.rawFindingId)
      .sort(compareBinaryStrings);
    const binding: PreAdmissionEntityBinding = {
      kind: 'entity_group',
      decision: 'ambiguous',
      creationRequestKey: entityCreationRequestKey({
        roundMarker: input.roundMarker,
        taskId: input.taskId,
        groupOrdinal,
      }),
      commitOrderKey: component.componentKey,
      capturedLocusHeadDigest: component.locusHeadDigest,
      groupRawFindingIds,
      reason: input.reason,
    };
    for (const rawFindingId of groupRawFindingIds) {
      bindings.set(rawFindingId, binding);
    }
  });
  return bindings;
}
