import type {
  FindingLedger,
  FindingManagerReportPublication,
  FindingManagerValidationReport,
  RawFinding,
} from './types.js';
import type {
  InterpretationLiveClaimRegistry,
} from './interpretation-live-claims.js';
import type { ReportPublicationReceipt } from '../report-publication.js';

export interface LedgerRepository {
  readonly runId: string;
  readonly ledgerIdentity: string;
  readonly interpretationLiveClaims: InterpretationLiveClaimRegistry;
  readonly workflowName: string;
  loadLedger: () => FindingLedger;
  updateLedger: <Result>(
    mutator: (current: FindingLedger) => FindingLedgerMutation<Result>,
    revalidateBeforeSave?: (
      current: FindingLedger,
      mutation: FindingLedgerMutation<Result>,
    ) => FindingLedgerPublicationDecision<Result>,
  ) => Promise<FindingLedgerMutation<Result>>;
}

export interface FindingManagerLedgerCommit<Result> {
  readonly ledger: FindingLedger;
  readonly result: Result;
  readonly publication?: {
    readonly roundMarker: string;
    readonly report: FindingManagerValidationReport;
  };
}

export interface FindingManagerCommitStager {
  commitManagerLedger: <Result>(
    mutator: (current: FindingLedger) => FindingManagerLedgerCommit<Result>,
  ) => Promise<FindingLedgerMutation<Result>>;
}

export interface FindingArtifactWriter {
  saveLedgerSnapshot: () => void;
  saveRawFindings: (
    runId: string,
    stepName: string,
    rawFindings: RawFinding[],
  ) => void;
  saveManagerValidationReport: (
    report: FindingManagerValidationReport,
  ) => void;
  planManagerValidationPublication: (
    roundMarker: string,
    report: FindingManagerValidationReport,
  ) => FindingManagerReportPublication;
  bindManagerValidationPublication: (
    roundMarker: string,
    publication: FindingManagerReportPublication,
  ) => FindingManagerReportPublication;
  publishManagerValidationPublication: (
    publication: FindingManagerReportPublication,
  ) => ReportPublicationReceipt;
}

export interface FindingManagerCommitRebinder {
  rebindPendingManagerValidationPublication: (
    publication: FindingManagerReportPublication,
  ) => Promise<FindingLedger>;
}

export interface FindingManagerCommitFinalizer {
  finalizeManagerValidationPublication: (
    publication: FindingManagerReportPublication,
    receipt: ReportPublicationReceipt,
  ) => Promise<FindingManagerCommitFinalization>;
}

export interface FindingLedgerStore
  extends
    LedgerRepository,
    FindingManagerCommitStager,
    FindingArtifactWriter,
    FindingManagerCommitRebinder,
    FindingManagerCommitFinalizer {}

export type FindingManagerStore = LedgerRepository
  & FindingManagerCommitStager
  & FindingManagerCommitRebinder
  & FindingManagerCommitFinalizer
  & Pick<
    FindingArtifactWriter,
    | 'saveLedgerSnapshot'
    | 'saveRawFindings'
    | 'saveManagerValidationReport'
    | 'planManagerValidationPublication'
    | 'bindManagerValidationPublication'
    | 'publishManagerValidationPublication'
  >;

export type FindingAdjudicationStore = LedgerRepository;

export interface FindingLedgerMutation<Result> {
  ledger: FindingLedger;
  result: Result;
}

export interface FindingManagerCommitFinalization {
  ledger: FindingLedger;
  completedRoundMarker: string;
}

export interface FindingLedgerPublicationDecision<Result> {
  mutation: FindingLedgerMutation<Result>;
  publish: boolean;
}

export type {
  FindingManagerValidationAttemptReport,
  FindingManagerValidationReport,
  FindingRawObservationFailure,
  FindingRawObservationSettlement,
  FindingRawObservationSettlementDestinationKind,
  FindingRawObservationSettlementSummary,
  InterpretationStatsReport,
  ProvisionalLandingReport,
  RawAdmissionRejectionReport,
  RawNormalizationAuditRecord,
  ReviewerAnomalyLandingReport,
  ReviewerOutputOverflowReport,
  UnsupportedRawFindingReport,
} from './types.js';
