import type { FindingManagerValidationAttemptReport, UnsupportedRawFindingReport } from './store.js';
import type { FindingLedger, FindingManagerDecisions, FindingManagerOutput } from './types.js';
import type { ProvisionalFindingSpec } from './reconciler.js';
import type { RawAdmissionEvaluation } from './manager-admission.js';
import type { classifyRawFindingsMechanically } from './mechanical-classification.js';
import { assembleManagerOutput } from './decision-assembly.js';
import { provisionalSpecForRaw } from './manager-provisional.js';
import {
  collectLandedRawIds,
  describeManagerRejections,
} from './manager-utils.js';
import { createEmptyManagerOutput } from './manager-output.js';
import { validateFindingManagerOutput } from './manager-output-validation.js';

export interface CleanManagerDecisionResult {
  managerOutput: FindingManagerOutput;
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
  priorStepResponseText: string | undefined;
}): CleanManagerDecisionResult {
  const cleanWireById = new Map(input.admission.cleanWire.map((wire) => [wire.rawFindingId, wire]));
  const cleanCanonicalById = new Map(input.admission.cleanAdmitted.map(
    (item) => [item.wire.rawFindingId, item.canonical],
  ));
  let invalidAttempts = [...input.initialInvalidAttempts];
  let cleanProvisionalSpecs: ProvisionalFindingSpec[] = [];
  let unsupportedRawFindingReports: UnsupportedRawFindingReport[] = [];

  const landRawAsProvisional = (rawFindingId: string, reason: string): void => {
    const wire = cleanWireById.get(rawFindingId);
    const canonical = cleanCanonicalById.get(rawFindingId);
    if (wire === undefined || canonical === undefined || wire.kind === 'resolution_confirmation') {
      return;
    }
    cleanProvisionalSpecs = [
      ...cleanProvisionalSpecs,
      provisionalSpecForRaw({ wire, canonical, reason }),
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
        );
      }
    }
    for (const unsupported of assembly.unsupportedRawDecisions) {
      unsupportedRawFindingReports = [...unsupportedRawFindingReports, unsupported];
      landRawAsProvisional(
        unsupported.rawFindingId,
        `Manager decided "unsupported" against finding "${unsupported.targetFindingId}": ${unsupported.evidence}`,
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

  const finalValidation = validateFindingManagerOutput({
    previousLedger: input.previousLedger,
    rawFindings: input.admission.cleanWire,
    managerOutput,
    priorStepResponseText: input.priorStepResponseText,
  });
  if (!finalValidation.ok) {
    invalidAttempts = [...invalidAttempts, {
      attempt: invalidAttempts.length + 1,
      managerOutput,
      validationErrors: finalValidation.errors,
    }];
    for (const wire of input.admission.cleanWire) {
      landRawAsProvisional(
        wire.rawFindingId,
        'Manager output violated ledger invariants and was discarded; raw finding kept provisional',
      );
    }
    managerOutput = createEmptyManagerOutput();
  }

  return {
    managerOutput,
    invalidAttempts,
    cleanProvisionalSpecs,
    unsupportedRawFindingReports,
    cleanWireById,
    cleanCanonicalById,
  };
}
