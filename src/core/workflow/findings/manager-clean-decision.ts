import type { FindingManagerValidationAttemptReport, UnsupportedRawFindingReport } from './store.js';
import type { FindingLedger, FindingManagerDecisions, FindingManagerOutput } from './types.js';
import type { ProvisionalFindingSpec } from './reconciler.js';
import type { RawAdmissionEvaluation } from './manager-admission.js';
import type { classifyRawFindingsMechanically } from './mechanical-classification.js';
import type { FindingProvisionalKind } from './types.js';
import { assembleManagerOutput } from './decision-assembly.js';
import { transferSupersededMatches } from './manager-plan-normalization.js';
import { provisionalSpecForRawKind } from './manager-provisional.js';
import {
  collectLandedRawIds,
  describeManagerRejections,
} from './manager-utils.js';
import { validateFindingManagerOutput } from './manager-output-validation.js';

export interface CleanManagerDecisionResult {
  managerOutput: FindingManagerOutput;
  wholeOutputDiscarded: boolean;
  invalidAttempts: FindingManagerValidationAttemptReport[];
  cleanProvisionalSpecs: ProvisionalFindingSpec[];
  unsupportedRawFindingReports: UnsupportedRawFindingReport[];
  cleanWireById: Map<string, RawAdmissionEvaluation['cleanWire'][number]>;
  cleanCanonicalById: Map<string, RawAdmissionEvaluation['cleanAdmitted'][number]['canonical']>;
}

export function assembleCleanManagerDecision(input: {
  previousLedger: FindingLedger;
  admission: RawAdmissionEvaluation;
  mechanical: ReturnType<typeof classifyRawFindingsMechanically>;
  decisions: FindingManagerDecisions | undefined;
  initialInvalidAttempts: FindingManagerValidationAttemptReport[];
  invalidLocationCandidateFindingIds: ReadonlySet<string>;
  dismissCandidateFindingIds: ReadonlySet<string>;
  priorStepResponseText: string | undefined;
}): CleanManagerDecisionResult {
  const cleanWireById = new Map(input.admission.cleanWire.map((wire) => [wire.rawFindingId, wire]));
  const cleanCanonicalById = new Map(input.admission.cleanAdmitted.map(
    (item) => [item.wire.rawFindingId, item.canonical],
  ));
  let invalidAttempts = [...input.initialInvalidAttempts];
  let cleanProvisionalSpecs: ProvisionalFindingSpec[] = [];
  let unsupportedRawFindingReports: UnsupportedRawFindingReport[] = [];
  let wholeOutputDiscarded = false;

  const landRawAsProvisional = (rawFindingId: string, reason: string, kind: FindingProvisionalKind): void => {
    const wire = cleanWireById.get(rawFindingId);
    const canonical = cleanCanonicalById.get(rawFindingId);
    if (wire === undefined || canonical === undefined || wire.relation === 'resolution_confirmation') {
      return;
    }
    cleanProvisionalSpecs = [
      ...cleanProvisionalSpecs,
      provisionalSpecForRawKind({ wire, canonical, reason }, kind),
    ];
  };

  let managerOutput = input.mechanical.output;
  if (input.decisions !== undefined) {
    const assembly = assembleManagerOutput({
      previousLedger: input.previousLedger,
      residualRawFindings: input.mechanical.residualRawFindings,
      decisions: input.decisions,
      priorStepResponseText: input.priorStepResponseText,
      checkMissingDecisions: true,
      mechanicalOutput: input.mechanical.output,
      invalidLocationCandidateFindingIds: input.invalidLocationCandidateFindingIds,
      dismissCandidateFindingIds: input.dismissCandidateFindingIds,
    });
    const landedRawIds = collectLandedRawIds(assembly.output);
    for (const rejected of assembly.rejectedRawDecisions) {
      if (!('rawFindingId' in rejected)) {
        continue;
      }
      if (!landedRawIds.has(rejected.rawFindingId)) {
        landRawAsProvisional(
          rejected.rawFindingId,
          `Manager decision (${rejected.decision}) was rejected: ${rejected.reason}`,
          'raw-adjudication-unresolved',
        );
      }
    }
    for (const unsupported of assembly.unsupportedRawDecisions) {
      unsupportedRawFindingReports = [...unsupportedRawFindingReports, unsupported];
      landRawAsProvisional(
        unsupported.rawFindingId,
        `Manager decided "unsupported" against finding "${unsupported.targetFindingId}": ${unsupported.evidence}`,
        'raw-adjudication-unresolved',
      );
    }
    const rejectionDescriptions = describeManagerRejections(assembly);
    if (rejectionDescriptions.length > 0) {
      invalidAttempts = [...invalidAttempts, {
        attempt: invalidAttempts.length + 1,
        managerOutput: input.decisions,
        validationErrors: rejectionDescriptions,
      }];
    }
    managerOutput = assembly.output;
  }

  // matches|supersededFindings は保存直前の転写（normalizeMergedManagerPlan）で
  // 解消される予定の併存なので、検証は転写後のビューに対して行う。保存される
  // 計画は未転写のまま — 後着 conflict で統合が覆ったとき match を元の finding に
  // 残すため（転写は保存直前の1回だけ）。
  const finalValidation = validateFindingManagerOutput({
    previousLedger: input.previousLedger,
    rawFindings: input.admission.cleanWire,
    managerOutput: transferSupersededMatches(managerOutput),
    priorStepResponseText: input.priorStepResponseText,
  });
  if (!finalValidation.ok) {
    wholeOutputDiscarded = true;
    invalidAttempts = [...invalidAttempts, {
      attempt: invalidAttempts.length + 1,
      managerOutput,
      validationErrors: finalValidation.errors,
    }];
    // empty へ落とすと機械分類の確定分（決定的 same / resolution confirmation）
    // まで消える。pristine な機械分類出力へ縮退し、失うのは LLM 判断だけに
    // 留める。LLM 由来の provisional spec / unsupported 報告は採用済み判断と
    // して残さない（invalid attempt の監査記録には残る）。
    const mechanicalValidation = validateFindingManagerOutput({
      previousLedger: input.previousLedger,
      rawFindings: input.admission.cleanWire,
      managerOutput: input.mechanical.output,
      priorStepResponseText: input.priorStepResponseText,
    });
    if (!mechanicalValidation.ok) {
      throw new Error(
        `Mechanical classification output violated ledger invariants; this is an engine bug: ${mechanicalValidation.errors.join('; ')}`,
      );
    }
    managerOutput = input.mechanical.output;
    cleanProvisionalSpecs = [];
    unsupportedRawFindingReports = [];
    const mechanicallyLandedRawIds = collectLandedRawIds(input.mechanical.output);
    for (const wire of input.admission.cleanWire) {
      if (mechanicallyLandedRawIds.has(wire.rawFindingId)) {
        continue;
      }
      landRawAsProvisional(
        wire.rawFindingId,
        'Manager output violated ledger invariants and was discarded; raw finding kept provisional',
        'manager-output-discarded',
      );
    }
  }

  return {
    managerOutput,
    wholeOutputDiscarded,
    invalidAttempts,
    cleanProvisionalSpecs,
    unsupportedRawFindingReports,
    cleanWireById,
    cleanCanonicalById,
  };
}
