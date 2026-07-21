import { assembleManagerOutput, flattenManagerOutputToDecisions } from './decision-assembly.js';
import {
  checkFindingPrecondition,
  type CapturedFindingPrecondition,
} from './finding-preconditions.js';
import { collectLandedRawIds, computeDismissCandidates, computeInvalidLocationCandidates, describeManagerRejections } from './manager-utils.js';
import { provisionalSpecForRawKind, stalePreconditionSpec } from './manager-provisional.js';
import type { ProvisionalFindingSpec } from './reconciler.js';
import type {
  FindingLedger,
  FindingLedgerEntry,
  FindingManagerConflict,
  FindingManagerOutput,
  RawFinding,
  FindingActionRecovery,
} from './types.js';
import type { ManagerDecisionStageResult, RunFindingManagerForStepInput } from './manager-contracts.js';

export interface RevalidatedManagerPlan {
  output: FindingManagerOutput;
  provisionalSpecs: ProvisionalFindingSpec[];
  staleRejections: string[];
}

export function revalidateManagerPlan(input: {
  managerOutput: FindingManagerOutput;
  freshLedger: FindingLedger;
  cleanWire: RawFinding[];
  cleanWireById: ReadonlyMap<string, RawFinding>;
  cleanCanonicalById: ManagerDecisionStageResult['cleanCanonicalById'];
  capturedPreconditions: Map<string, CapturedFindingPrecondition>;
  runInput: RunFindingManagerForStepInput;
}): RevalidatedManagerPlan {
  const { decisions, carriedFindingOnlyConflicts } = flattenManagerOutputToDecisions(input.managerOutput);
  const freshAssembly = assembleManagerOutput({
    previousLedger: input.freshLedger,
    residualRawFindings: input.cleanWire,
    decisions,
    carriedFindingOnlyConflicts,
    priorStepResponseText: input.runInput.priorStepResponseText,
    invalidLocationCandidateFindingIds: new Set(
      computeInvalidLocationCandidates(input.runInput.cwd, input.freshLedger.findings).keys(),
    ),
    // fresh ledger に対して候補を再計算する: 初回判断と保存の間に clean 証拠で
    // settle された（open でなくなった）対象への dismiss は stale として不採用になる。
    dismissCandidateFindingIds: new Set(
      computeDismissCandidates(input.freshLedger).keys(),
    ),
  });
  const freshLandedRawIds = collectLandedRawIds(freshAssembly.output);
  const staleDecisionSpecs = freshAssembly.rejectedRawDecisions.flatMap((rejected) => {
    if (!('rawFindingId' in rejected)) {
      return [];
    }
    if (freshLandedRawIds.has(rejected.rawFindingId)) {
      return [];
    }
    const wire = input.cleanWireById.get(rejected.rawFindingId);
    const canonical = input.cleanCanonicalById.get(rejected.rawFindingId);
    if (wire === undefined || canonical === undefined || wire.relation === 'resolution_confirmation') {
      return [];
    }
    return [provisionalSpecForRawKind({
      wire,
      canonical,
      reason: `Decision (${rejected.decision}) became stale against the freshly reloaded ledger: ${rejected.reason}`,
    }, 'raw-adjudication-unresolved')];
  });
  const preconditions = applyPreconditionChecks({
    output: freshAssembly.output,
    captured: input.capturedPreconditions,
    freshLedger: input.freshLedger,
    workflowName: input.runInput.workflowName,
    callNamespace: input.runInput.callNamespace,
    parentStepName: input.runInput.parentStep.name,
  });
  return {
    output: preconditions.output,
    provisionalSpecs: [...staleDecisionSpecs, ...preconditions.provisionalSpecs],
    staleRejections: [...describeManagerRejections(freshAssembly), ...preconditions.staleDetails],
  };
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
    matches,
    newFindings: [...base.newFindings, ...extra.newFindings],
    conflicts: [...base.conflicts, ...extra.conflicts],
  };
}

function applyPreconditionChecks(input: {
  output: FindingManagerOutput;
  captured: Map<string, CapturedFindingPrecondition>;
  freshLedger: FindingLedger;
  workflowName: string;
  callNamespace: string;
  parentStepName: string;
}): { output: FindingManagerOutput; provisionalSpecs: ProvisionalFindingSpec[]; staleDetails: string[] } {
  let provisionalSpecs: ProvisionalFindingSpec[] = [];
  let staleDetails: string[] = [];
  let extraConflicts: FindingManagerConflict[] = [];

  const specFor = (
    findingId: string,
    sourceRawFindingIds: string[],
    reason: string,
    actionRecovery?: FindingActionRecovery,
  ): void => {
    const fresh = input.freshLedger.findings.find((finding) => finding.id === findingId);
    provisionalSpecs = [...provisionalSpecs, stalePreconditionSpec({
      workflowName: input.workflowName,
      callNamespace: input.callNamespace,
      parentStepName: input.parentStepName,
      targetFindingId: findingId,
      targetTitle: fresh?.title ?? findingId,
      ...(fresh?.location !== undefined ? { targetLocation: fresh.location } : {}),
      sourceRawFindingIds,
      reason,
      ...(actionRecovery !== undefined ? { actionRecovery } : {}),
    })];
    staleDetails = [...staleDetails, reason];
  };

  const resolvedFindings = input.output.resolvedFindings.filter((resolved) => {
    const captured = input.captured.get(resolved.findingId);
    if (captured === undefined) {
      // prompt 時に存在しなかった finding への確認は成立し得ない（stale 扱い）。
      specFor(resolved.findingId, [...resolved.rawFindingIds], `Confirmation targets finding "${resolved.findingId}" that did not exist when the prompt snapshot was taken`);
      return false;
    }
    const check = checkFindingPrecondition({
      captured,
      freshLedger: input.freshLedger,
      expectedStatuses: ['open'],
      idempotentResolvedEvidence: resolved.evidence,
    });
    switch (check.outcome) {
      case 'ok':
        return true;
      case 'idempotent-resolved':
        // 既に同じ evidence で resolved 済み → 冪等成功として黙って外す。
        return false;
      case 'post-prompt-persists':
        // prompt 後の persists 観測: target は open のまま、confirmation と
        // persists を参照する active conflict + provisional。
        extraConflicts = [...extraConflicts, {
          findingIds: [resolved.findingId],
          rawFindingIds: [...resolved.rawFindingIds],
          description: `Resolution confirmation for "${resolved.findingId}" conflicts with a persists observation saved after the confirmation was prompted`,
        }];
        specFor(resolved.findingId, [...resolved.rawFindingIds], `Confirmation for "${resolved.findingId}" was not applied: ${check.detail}`);
        return false;
      case 'stale':
        specFor(resolved.findingId, [...resolved.rawFindingIds], `Confirmation for "${resolved.findingId}" was not applied (stale precondition): ${check.detail}`);
        return false;
    }
  });

  const checkClosingDecision = (
    findingId: string,
    sourceRawFindingIds: string[],
    expectedStatuses: ReadonlyArray<FindingLedgerEntry['status']>,
    action: string,
    actionRecovery?: FindingActionRecovery,
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
  // 判断のままでは却下しない（stale として不採用 → 次ラウンドで再裁定）。
  const dismissedFindings = input.output.dismissedFindings.filter((dismissed) => (
    checkClosingDecision(dismissed.findingId, [], ['open'], 'Dismiss', {
      action: 'dismiss',
      findingId: dismissed.findingId,
      basis: dismissed.basis,
      reason: dismissed.reason,
    })
  ));

  return {
    output: {
      ...input.output,
      resolvedFindings,
      reopenedFindings,
      invalidatedFindings,
      waivedFindings,
      duplicateFindings,
      dismissedFindings,
      conflicts: [...input.output.conflicts, ...extraConflicts],
    },
    provisionalSpecs,
    staleDetails,
  };
}
