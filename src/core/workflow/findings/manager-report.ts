import type {
  FindingManagerValidationAttemptReport,
  InterpretationStatsReport,
  ProvisionalLandingReport,
  RawAdmissionRejectionReport,
  RawNormalizationAuditRecord,
  ReviewerAnomalyLandingReport,
  ReviewerOutputOverflowReport,
  UnsupportedRawFindingReport,
} from './store.js';
import type {
  FindingManagerOutput,
  FindingManagerTaskAudit,
  FindingManagerValidationReport,
  InterpretationRecoveryOriginSettlement,
  FindingRawObservationSettlementSummary,
} from './types.js';

interface ManagerCommitReportInput {
  runId: string;
  stepName: string;
  managerOutput: FindingManagerOutput;
  invalidAttempts: FindingManagerValidationAttemptReport[];
  staleRejections: string[];
  admissionRejections: RawAdmissionRejectionReport[];
  unsupportedRawFindingReports: UnsupportedRawFindingReport[];
  overflowReports: ReviewerOutputOverflowReport[];
  provisionalLandings: ProvisionalLandingReport[];
  reviewerAnomalyLandings: ReviewerAnomalyLandingReport[];
  rawNormalizations: RawNormalizationAuditRecord[];
  clarifications: Array<{ reviewer: string; flaggedRawFindingIds: string[] }>;
  interpretationStats: InterpretationStatsReport;
  interpretationRecoverySettlements: InterpretationRecoveryOriginSettlement[];
  managerTaskAudits: FindingManagerTaskAudit[];
  settlement: FindingRawObservationSettlementSummary;
}

export function buildManagerCommitReport(
  input: ManagerCommitReportInput,
): FindingManagerValidationReport {
  return {
    version: 1,
    runId: input.runId,
    stepName: input.stepName,
    retryCount: 0,
    ledgerUpdated: true,
    finalErrors: [],
    ...(input.admissionRejections.length > 0 ? { rawAdmissionRejections: input.admissionRejections } : {}),
    ...(input.unsupportedRawFindingReports.length > 0
      ? { unsupportedRawFindings: input.unsupportedRawFindingReports }
      : {}),
    ...(input.overflowReports.length > 0 ? { reviewerOutputOverflows: input.overflowReports } : {}),
    ...(input.provisionalLandings.length > 0 ? { provisionalLandings: input.provisionalLandings } : {}),
    ...(input.reviewerAnomalyLandings.length > 0
      ? { reviewerAnomalyLandings: input.reviewerAnomalyLandings }
      : {}),
    ...(input.rawNormalizations.length > 0 ? { rawNormalizations: input.rawNormalizations } : {}),
    ...(input.clarifications.length > 0 ? { relationClarifications: input.clarifications } : {}),
    ...(input.interpretationRecoverySettlements.length > 0
      ? { interpretationRecoverySettlements: input.interpretationRecoverySettlements }
      : {}),
    ...(input.managerTaskAudits.length > 0
      ? { managerTaskAudits: input.managerTaskAudits }
      : {}),
    settlement: input.settlement,
    interpretationStats: input.interpretationStats,
    attempts: input.staleRejections.length > 0
      ? [
        ...input.invalidAttempts,
        {
          attempt: input.invalidAttempts.length + 1,
          managerOutput: input.managerOutput,
          validationErrors: input.staleRejections,
        },
      ]
      : input.invalidAttempts,
  };
}
