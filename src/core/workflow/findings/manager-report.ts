import type {
  FindingManagerStore,
  FindingManagerValidationAttemptReport,
  InterpretationStatsReport,
  ProvisionalLandingReport,
  RawAdmissionRejectionReport,
  RawNormalizationAuditRecord,
  ReviewerAnomalyLandingReport,
  ReviewerOutputOverflowReport,
  UnsupportedRawFindingReport,
} from './store.js';
import type { FindingManagerOutput } from './types.js';

export function saveManagerCommitReport(input: {
  ledgerStore: FindingManagerStore;
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
}): void {
  const reportNeeded = input.invalidAttempts.length > 0
    || input.staleRejections.length > 0
    || input.admissionRejections.length > 0
    || input.unsupportedRawFindingReports.length > 0
    || input.overflowReports.length > 0
    || input.provisionalLandings.length > 0
    || input.reviewerAnomalyLandings.length > 0
    || input.clarifications.length > 0
    || input.rawNormalizations.length > 0;
  if (!reportNeeded) {
    return;
  }

  input.ledgerStore.saveManagerValidationReport({
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
  });
}
