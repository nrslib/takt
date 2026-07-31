import { assembleManagerOutput, flattenManagerOutputToDecisions } from './decision-assembly.js';
import {
  captureFindingMutationPrecondition,
  checkFindingPrecondition,
  sameFindingMutationPrecondition,
  type CapturedFindingPrecondition,
} from './finding-preconditions.js';
import { collectLandedRawIds, computeDismissCandidates, computeInvalidLocationCandidates, describeManagerRejections } from './manager-utils.js';
import { provisionalSpecForRawKind, stalePreconditionSpec } from './manager-provisional.js';
import type { ProvisionalFindingSpec } from './reconciler.js';
import type {
  FindingLedger,
  FindingLedgerEntry,
  FindingManagerOutput,
  RawFinding,
  FindingActionRecovery,
  FindingActionProposal,
} from './types.js';
import type { ManagerDecisionStageResult, RunFindingManagerForStepInput } from './manager-contracts.js';
import {
  mergeResolutionRenotificationTransitions,
  type ResolutionRenotificationTransition,
} from './resolution-renotification.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';
import { computeConflictEvidenceHash } from './adjudication-evidence.js';
import type { UnsupportedRawFindingReport } from './store.js';
import {
  hasLifecycleProductTransitionCapability,
  hasLifecycleTransitionIntent,
} from './raw-relation-capabilities.js';
import { computeWorkflowTaskDigest } from './task-scope-adjudication.js';

export interface RevalidatedManagerPlan {
  output: FindingManagerOutput;
  provisionalSpecs: ProvisionalFindingSpec[];
  unsupportedRawFindingReports: UnsupportedRawFindingReport[];
  staleRejections: string[];
  resolutionRenotifications: ResolutionRenotificationTransition[];
}

function unsupportedLifecycleReport(input: {
  wire: RawFinding;
  freshLedger: FindingLedger;
  reason: string;
  workflowTask: string;
}): UnsupportedRawFindingReport | undefined {
  if (!hasLifecycleTransitionIntent({
    relation: input.wire.relation,
    targetFindingId: input.wire.targetFindingId,
  })) {
    return undefined;
  }
  const targetFindingId = input.wire.targetFindingId;
  const target = targetFindingId === null
    ? undefined
    : input.freshLedger.findings.find((finding) => finding.id === targetFindingId);
  const hasTransitionCapability = input.wire.relation !== null
    && input.wire.relation !== 'new'
    && hasLifecycleProductTransitionCapability({
      relation: input.wire.relation,
      target,
      workflowTaskDigest: computeWorkflowTaskDigest(input.workflowTask),
    });
  return {
    rawFindingId: input.wire.rawFindingId,
    targetFindingId: targetFindingId ?? '(none)',
    evidence: `${input.reason}; lifecycle transition is audit-only at commit (fresh target status: ${target?.status ?? 'missing'}, transition capability: ${hasTransitionCapability ? 'available but stale' : 'unavailable'})`,
  };
}

export function revalidateManagerPlan(input: {
  managerOutput: FindingManagerOutput;
  freshLedger: FindingLedger;
  cleanWire: RawFinding[];
  cleanWireById: ReadonlyMap<string, RawFinding>;
  cleanCanonicalById: ManagerDecisionStageResult['cleanCanonicalById'];
  capturedPreconditions: Map<string, CapturedFindingPrecondition>;
  capturedConflictHeads?: ManagerDecisionStageResult['conflictTargetHeads'];
  reviewScopeSnapshotId: string;
  runInput: RunFindingManagerForStepInput;
}): RevalidatedManagerPlan {
  const { decisions, carriedFindingOnlyConflicts } = flattenManagerOutputToDecisions(
    input.managerOutput,
  );
  const staleConflictRejections: string[] = [];
  const conflictDecisions = decisions.conflictDecisions.filter((decision) => {
    if (
      decision.decision !== 'resolve'
      || !input.capturedConflictHeads?.has(decision.conflictId)
    ) {
      return true;
    }
    const captured = input.capturedConflictHeads.get(decision.conflictId)!;
    const freshLifecycleHead = captureFindingLifecycleHead(
      input.freshLedger,
      'conflict',
      decision.conflictId,
    ) ?? null;
    const freshConflict = input.freshLedger.conflicts.find(
      (conflict) => conflict.id === decision.conflictId,
    );
    const freshEvidenceSetHash = freshConflict === undefined
      ? null
      : computeConflictEvidenceHash(
          freshConflict,
          input.freshLedger,
          input.reviewScopeSnapshotId,
        );
    if (
      captured.reviewScopeSnapshotId === input.reviewScopeSnapshotId
      && canonicalJson(captured.lifecycleHead) === canonicalJson(freshLifecycleHead)
      && captured.evidenceSetHash === freshEvidenceSetHash
    ) {
      return true;
    }
    staleConflictRejections.push(
      `conflictDecisions: conflict "${decision.conflictId}" (resolve) rejected at commit: captured lifecycle head no longer matches the fresh ledger`,
    );
    return false;
  });
  const freshAssembly = assembleManagerOutput({
    previousLedger: input.freshLedger,
    residualRawFindings: input.cleanWire,
    decisions: { ...decisions, conflictDecisions },
    carriedFindingOnlyConflicts,
    priorStepResponseText: input.runInput.priorStepResponseText,
    invalidLocationCandidateFindingIds: new Set(
      computeInvalidLocationCandidates(input.runInput.cwd, input.freshLedger).keys(),
    ),
    // fresh ledger に対して候補を再計算する: 初回判断と保存の間に clean 証拠で
    // settle された（open でなくなった）対象への dismiss は stale として不採用になる。
    dismissCandidateFindingIds: new Set(
      computeDismissCandidates(input.freshLedger).keys(),
    ),
    managerAuthority: input.runInput.managerAuthority,
  });
  const freshLandedRawIds = collectLandedRawIds(freshAssembly.output);
  const rejectedRenotifications = collectRejectedRenotifications({
    rejectedRawDecisions: freshAssembly.rejectedRawDecisions,
    freshLedger: input.freshLedger,
    cleanWireById: input.cleanWireById,
    capturedPreconditions: input.capturedPreconditions,
  });
  const renotificationRawFindingIds = new Set(
    rejectedRenotifications.flatMap(
      (transition) => transition.renotificationRawFindingIds,
    ),
  );
  const staleDecisionPlan = freshAssembly.rejectedRawDecisions.reduce<{
    provisionalSpecs: ProvisionalFindingSpec[];
    unsupportedRawFindingReports: UnsupportedRawFindingReport[];
  }>((plan, rejected) => {
    if (!('rawFindingId' in rejected)) {
      return plan;
    }
    if (renotificationRawFindingIds.has(rejected.rawFindingId)) {
      return plan;
    }
    if (freshLandedRawIds.has(rejected.rawFindingId)) {
      return plan;
    }
    const wire = input.cleanWireById.get(rejected.rawFindingId);
    const canonical = input.cleanCanonicalById.get(rejected.rawFindingId);
    if (wire === undefined || canonical === undefined || wire.relation === 'resolution_confirmation') {
      return plan;
    }
    const reason = `Decision (${rejected.decision}) became stale against the freshly reloaded ledger: ${rejected.reason}`;
    const unsupported = unsupportedLifecycleReport({
      wire,
      freshLedger: input.freshLedger,
      reason,
      workflowTask: input.runInput.workflowTask,
    });
    return unsupported === undefined
      ? {
          ...plan,
          provisionalSpecs: [...plan.provisionalSpecs, provisionalSpecForRawKind({
            wire,
            canonical,
            reason,
          }, 'raw-adjudication-unresolved')],
        }
      : {
          ...plan,
          unsupportedRawFindingReports: [...plan.unsupportedRawFindingReports, unsupported],
        };
  }, { provisionalSpecs: [], unsupportedRawFindingReports: [] });
  const preconditions = applyPreconditionChecks({
    output: freshAssembly.output,
    captured: input.capturedPreconditions,
    freshLedger: input.freshLedger,
    workflowName: input.runInput.workflowName,
    callNamespace: input.runInput.callNamespace,
    parentStepName: input.runInput.parentStep.name,
    cleanWireById: input.cleanWireById,
    workflowTask: input.runInput.workflowTask,
  });
  return {
    output: preconditions.output,
    provisionalSpecs: [...staleDecisionPlan.provisionalSpecs, ...preconditions.provisionalSpecs],
    unsupportedRawFindingReports: [
      ...staleDecisionPlan.unsupportedRawFindingReports,
      ...preconditions.unsupportedRawFindingReports,
    ],
    staleRejections: [
      ...describeManagerRejections({
        ...freshAssembly,
        rejectedRawDecisions: freshAssembly.rejectedRawDecisions.filter((rejected) => (
          !('rawFindingId' in rejected)
          || !renotificationRawFindingIds.has(rejected.rawFindingId)
        )),
      }),
      ...preconditions.staleDetails,
      ...staleConflictRejections,
    ],
    resolutionRenotifications: mergeResolutionRenotificationTransitions([
      ...rejectedRenotifications,
      ...preconditions.resolutionRenotifications,
    ]),
  };
}

function collectCanonicalRawFindingDelta(input: {
  freshLedger: FindingLedger;
  captured: CapturedFindingPrecondition;
  findingId: string;
  relations: ReadonlySet<RawFinding['relation']>;
  observed: RawFinding['targetPrecondition'];
}): string[] {
  if (input.observed === undefined) {
    return [];
  }
  const observed = input.observed;
  const finding = input.freshLedger.findings.find(
    (candidate) => candidate.id === input.findingId,
  );
  if (finding === undefined) {
    return [];
  }
  const rawById = new Map(
    input.freshLedger.rawFindings.map((raw) => [raw.rawFindingId, raw]),
  );
  return finding.rawFindingIds
    .filter((rawFindingId) => !input.captured.capturedRawFindingIds.has(rawFindingId))
    .filter((rawFindingId) => {
      const raw = rawById.get(rawFindingId);
      return raw !== undefined
        && raw.targetFindingId === input.findingId
        && input.relations.has(raw.relation)
        && raw.targetPrecondition !== undefined
        && sameFindingMutationPrecondition(raw.targetPrecondition, observed);
    })
    .sort(compareBinaryStrings);
}

function collectRejectedRenotifications(input: {
  rejectedRawDecisions: ReturnType<typeof assembleManagerOutput>['rejectedRawDecisions'];
  freshLedger: FindingLedger;
  cleanWireById: ReadonlyMap<string, RawFinding>;
  capturedPreconditions: ReadonlyMap<string, CapturedFindingPrecondition>;
}): ResolutionRenotificationTransition[] {
  return input.rejectedRawDecisions.flatMap((rejected) => {
    if (!('rawFindingId' in rejected) || rejected.decision !== 'same') {
      return [];
    }
    const raw = input.cleanWireById.get(rejected.rawFindingId);
    if (raw?.relation !== 'persists' || raw.targetFindingId === null) {
      return [];
    }
    const captured = input.capturedPreconditions.get(raw.targetFindingId);
    const fresh = input.freshLedger.findings.find(
      (finding) => finding.id === raw.targetFindingId,
    );
    if (
      captured === undefined
      || captured.precondition.targetStatus !== 'open'
      || fresh?.status !== 'resolved'
      || raw.targetPrecondition === undefined
      || !sameFindingMutationPrecondition(
        raw.targetPrecondition,
        captured.precondition,
      )
    ) {
      return [];
    }
    const expectedTarget = captureFindingMutationPrecondition(
      input.freshLedger,
      raw.targetFindingId,
    );
    if (
      expectedTarget === undefined
      || expectedTarget.targetRevision !== raw.targetPrecondition.targetRevision + 1
    ) {
      return [];
    }
    const resolutionRawFindingIds = collectCanonicalRawFindingDelta({
      freshLedger: input.freshLedger,
      captured,
      findingId: raw.targetFindingId,
      relations: new Set(['resolution_confirmation']),
      observed: raw.targetPrecondition,
    });
    if (resolutionRawFindingIds.length === 0) {
      return [];
    }
    return [{
      findingId: raw.targetFindingId,
      observed: raw.targetPrecondition,
      expectedTarget,
      resolutionRawFindingIds,
      renotificationRawFindingIds: [raw.rawFindingId],
    }];
  });
}

export function mergeOutputs(base: FindingManagerOutput, extra: FindingManagerOutput): FindingManagerOutput {
  const matches = extra.matches.reduce<FindingManagerOutput['matches']>((current, match) => {
    const existing = current.find((candidate) => candidate.findingId === match.findingId);
    if (existing === undefined) {
      return [...current, { ...match, rawFindingIds: [...match.rawFindingIds] }];
    }
    const rawFindingIds = [...new Set([...existing.rawFindingIds, ...match.rawFindingIds])];
    return current.map((candidate) => (
      candidate.findingId === match.findingId
        ? { ...candidate, rawFindingIds }
        : candidate
    ));
  }, base.matches.map((match) => ({ ...match, rawFindingIds: [...match.rawFindingIds] })));
  return {
    ...base,
    anchorAdjudications: [
      ...base.anchorAdjudications,
      ...extra.anchorAdjudications,
    ],
    matches,
    newFindings: [...base.newFindings, ...extra.newFindings],
    conflicts: [...base.conflicts, ...extra.conflicts],
  };
}

function actionTargetFindingIds(action: FindingActionProposal): string[] {
  switch (action.action) {
    case 'invalidate':
    case 'waive':
    case 'dismiss':
      return [action.findingId];
    case 'duplicate':
      return [action.canonicalFindingId, ...action.duplicateFindingIds];
  }
}

function issueActionRecovery(
  action: FindingActionProposal,
  captured: ReadonlyMap<string, CapturedFindingPrecondition>,
): FindingActionRecovery | undefined {
  const targetPreconditions = actionTargetFindingIds(action).map(
    (findingId) => captured.get(findingId)?.precondition,
  );
  if (targetPreconditions.some((precondition) => precondition === undefined)) {
    return undefined;
  }
  return {
    ...action,
    targetPreconditions: targetPreconditions as FindingActionRecovery['targetPreconditions'],
  };
}

function applyPreconditionChecks(input: {
  output: FindingManagerOutput;
  captured: Map<string, CapturedFindingPrecondition>;
  freshLedger: FindingLedger;
  workflowName: string;
  callNamespace: string;
  parentStepName: string;
  cleanWireById: ReadonlyMap<string, RawFinding>;
  workflowTask: string;
}): {
  output: FindingManagerOutput;
  provisionalSpecs: ProvisionalFindingSpec[];
  unsupportedRawFindingReports: UnsupportedRawFindingReport[];
  staleDetails: string[];
  resolutionRenotifications: ResolutionRenotificationTransition[];
} {
  let provisionalSpecs: ProvisionalFindingSpec[] = [];
  let unsupportedRawFindingReports: UnsupportedRawFindingReport[] = [];
  let staleDetails: string[] = [];
  let resolutionRenotifications: ResolutionRenotificationTransition[] = [];

  const specFor = (
    findingId: string,
    sourceRawFindingIds: string[],
    reason: string,
    actionRecovery?: FindingActionProposal,
  ): void => {
    const lifecycleReports = sourceRawFindingIds.flatMap((rawFindingId) => {
      const wire = input.cleanWireById.get(rawFindingId);
      if (wire === undefined) {
        return [];
      }
      const report = unsupportedLifecycleReport({
        wire,
        freshLedger: input.freshLedger,
        reason,
        workflowTask: input.workflowTask,
      });
      return report === undefined ? [] : [report];
    });
    const lifecycleRawFindingIds = new Set(
      lifecycleReports.map((report) => report.rawFindingId),
    );
    const provisionalSourceRawFindingIds = sourceRawFindingIds.filter(
      (rawFindingId) => !lifecycleRawFindingIds.has(rawFindingId),
    );
    unsupportedRawFindingReports = [
      ...unsupportedRawFindingReports,
      ...lifecycleReports,
    ];
    if (
      sourceRawFindingIds.length > 0
      && provisionalSourceRawFindingIds.length === 0
    ) {
      staleDetails = [...staleDetails, reason];
      return;
    }
    const fresh = input.freshLedger.findings.find((finding) => finding.id === findingId);
    const issuedActionRecovery = actionRecovery === undefined
      ? undefined
      : issueActionRecovery(actionRecovery, input.captured);
    provisionalSpecs = [...provisionalSpecs, stalePreconditionSpec({
      workflowName: input.workflowName,
      callNamespace: input.callNamespace,
      parentStepName: input.parentStepName,
      targetFindingId: findingId,
      targetTitle: fresh?.title ?? findingId,
      sourceRawFindingIds: provisionalSourceRawFindingIds,
      reason,
      ...(issuedActionRecovery !== undefined
        ? { actionRecovery: issuedActionRecovery }
        : {}),
    })];
    staleDetails = [...staleDetails, reason];
  };
  const rejectResolution = (reason: string): void => {
    staleDetails = [...staleDetails, reason];
  };

  const resolvedFindings = input.output.resolvedFindings.filter((resolved) => {
    const captured = input.captured.get(resolved.findingId);
    if (captured === undefined) {
      // prompt 時に存在しなかった finding への確認は成立し得ない（stale 扱い）。
      rejectResolution(`Confirmation targets finding "${resolved.findingId}" that did not exist when the prompt snapshot was taken`);
      return false;
    }
    const check = checkFindingPrecondition({
      captured,
      freshLedger: input.freshLedger,
      expectedStatuses: ['open'],
      idempotentResolvedEvidence: resolved.evidence,
    });
    const freshTarget = input.freshLedger.findings.find(
      (finding) => finding.id === resolved.findingId,
    );
    switch (check.outcome) {
      case 'ok':
        return true;
      case 'idempotent-resolved':
        // 既に同じ evidence で resolved 済み → 冪等成功として黙って外す。
        return false;
      case 'post-prompt-persists':
        {
          if (freshTarget === undefined) {
            rejectResolution(
              `Confirmation for "${resolved.findingId}" was not applied because the fresh target is missing`,
            );
            return false;
          }
          const resolutionRawFindings = resolved.rawFindingIds.map(
            (rawFindingId) => input.cleanWireById.get(rawFindingId),
          );
          const observed = resolutionRawFindings[0]?.targetPrecondition;
          if (
            observed === undefined
            || resolutionRawFindings.some((raw) => (
              raw === undefined
              || raw.relation !== 'resolution_confirmation'
              || raw.targetFindingId !== resolved.findingId
              || raw.targetPrecondition === undefined
              || !sameFindingMutationPrecondition(raw.targetPrecondition, observed)
            ))
            || !sameFindingMutationPrecondition(observed, captured.precondition)
          ) {
            rejectResolution(
              `Confirmation for "${resolved.findingId}" was not applied because its engine-issued precondition is invalid`,
            );
            return false;
          }
          const expectedTarget = captureFindingMutationPrecondition(
            input.freshLedger,
            resolved.findingId,
          );
          const renotificationRawFindingIds = collectCanonicalRawFindingDelta({
            freshLedger: input.freshLedger,
            captured,
            findingId: resolved.findingId,
            relations: new Set(['persists', 'reopened']),
            observed,
          });
          if (
            expectedTarget === undefined
            || expectedTarget.targetRevision !== observed.targetRevision + 1
            || renotificationRawFindingIds.length === 0
          ) {
            rejectResolution(
              `Confirmation for "${resolved.findingId}" was not applied: ${check.detail}`,
            );
            return false;
          }
          resolutionRenotifications = [
            ...resolutionRenotifications,
            {
              findingId: resolved.findingId,
              observed,
              expectedTarget,
              resolutionRawFindingIds: [...resolved.rawFindingIds],
              renotificationRawFindingIds,
            },
          ];
        }
        return false;
      case 'stale':
        rejectResolution(`Confirmation for "${resolved.findingId}" was not applied (stale precondition): ${check.detail}`);
        return false;
    }
  });

  const checkClosingDecision = (
    findingId: string,
    sourceRawFindingIds: string[],
    expectedStatuses: ReadonlyArray<FindingLedgerEntry['status']>,
    action: string,
    actionRecovery?: FindingActionProposal,
  ): boolean => {
    const captured = input.captured.get(findingId);
    if (captured === undefined) {
      specFor(
        findingId,
        sourceRawFindingIds,
        `${action} targets finding "${findingId}" that did not exist when the prompt snapshot was taken`,
        actionRecovery,
      );
      return false;
    }
    const check = checkFindingPrecondition({ captured, freshLedger: input.freshLedger, expectedStatuses });
    if (check.outcome === 'ok') {
      return true;
    }
    if (check.outcome === 'idempotent-resolved') {
      return false;
    }
    specFor(
      findingId,
      sourceRawFindingIds,
      `${action} for "${findingId}" was not applied (${check.outcome}): ${check.detail}`,
      actionRecovery,
    );
    return false;
  };

  const reopenedFindings = input.output.reopenedFindings.filter((reopened) => (
    checkClosingDecision(reopened.findingId, [...reopened.rawFindingIds], ['resolved', 'waived', 'dismissed'], 'Reopen')
  ));
  const invalidatedFindings = input.output.invalidatedFindings.filter((invalidated) => (
    checkClosingDecision(invalidated.findingId, [], ['open'], 'Invalidate', {
      action: 'invalidate',
      findingId: invalidated.findingId,
      evidence: invalidated.evidence,
    })
  ));
  const waivedFindings = input.output.waivedFindings.filter((waived) => (
    checkClosingDecision(waived.findingId, [], ['open'], 'Waive', {
      action: 'waive',
      findingId: waived.findingId,
      reason: waived.reason,
      evidence: waived.evidence,
    })
  ));
  const duplicateFindings = input.output.duplicateFindings.filter((duplicate) => {
    const allIds = [duplicate.canonicalFindingId, ...duplicate.duplicateFindingIds];
    const failures = allIds.flatMap((findingId) => {
      const captured = input.captured.get(findingId);
      if (captured === undefined) {
        return [`Supersede targets finding "${findingId}" that did not exist when the prompt snapshot was taken`];
      }
      const check = checkFindingPrecondition({
        captured,
        freshLedger: input.freshLedger,
        expectedStatuses: ['open'],
      });
      if (check.outcome === 'ok') {
        return [];
      }
      return check.outcome === 'idempotent-resolved'
        ? [`Supersede for "${findingId}" was not applied because it was already resolved`]
        : [`Supersede for "${findingId}" was not applied (${check.outcome}): ${check.detail}`];
    });
    if (failures.length === 0) {
      return true;
    }
    specFor(duplicate.canonicalFindingId, [], failures.join('; '), {
      action: 'duplicate',
      canonicalFindingId: duplicate.canonicalFindingId,
      duplicateFindingIds: [...duplicate.duplicateFindingIds],
      evidence: duplicate.evidence,
    });
    return false;
  });
  // dismiss も他の終端遷移と同水準の楽観的前提条件を通す: manager 判断中に
  // 同じ provisional へ新しい観測が積まれて revision が進んでいたら、古い
  // 判断のままでは適用しない（stale として不採用 → 次ラウンドで再裁定）。
  const dismissedFindings = input.output.dismissedFindings.filter((dismissed) => (
    checkClosingDecision(dismissed.findingId, [], ['open'], 'Dismiss', {
      action: 'dismiss',
      findingId: dismissed.findingId,
      basis: dismissed.basis,
      reason: dismissed.reason,
      ...(dismissed.evidence !== undefined ? { evidence: dismissed.evidence } : {}),
      ...(dismissed.taskQuote !== undefined ? { taskQuote: dismissed.taskQuote } : {}),
      ...(dismissed.workflowTaskDigest !== undefined
        ? { workflowTaskDigest: dismissed.workflowTaskDigest }
        : {}),
      ...(dismissed.adjudicationTaskId !== undefined
        ? { adjudicationTaskId: dismissed.adjudicationTaskId }
        : {}),
      authority: dismissed.authority,
    })
  ));

  const output = {
    ...input.output,
    resolvedFindings,
    reopenedFindings,
    invalidatedFindings,
    waivedFindings,
    duplicateFindings,
    dismissedFindings,
  };
  const landedRawFindingIds = collectLandedRawIds(output);
  return {
    output: {
      ...output,
      anchorAdjudications: output.anchorAdjudications.filter((adjudication) => (
        landedRawFindingIds.has(adjudication.rawFindingId)
      )),
    },
    provisionalSpecs,
    unsupportedRawFindingReports,
    staleDetails,
    resolutionRenotifications,
  };
}
