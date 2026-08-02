import type {
  FindingArtifactWriter,
  FindingLedgerMutation,
  FindingLedgerStore,
  FindingManagerCommitStager,
  FindingManagerCommitFinalizer,
  FindingManagerCommitRebinder,
  FindingManagerCommitFinalization,
  FindingManagerValidationReport,
} from '../../core/workflow/findings/store.js';
import type {
  FindingLedger,
  FindingManagerReportPublication,
  RawFinding,
} from '../../core/workflow/findings/types.js';
import type { ReportPublicationReceipt } from '../../core/workflow/report-publication.js';
import {
  createFindingManagerPublicationDouble,
  RevisionedFindingLedgerTestRepository,
} from '../helpers/finding-manager-publication.js';

declare const writer: FindingArtifactWriter;
declare const ledgerStore: FindingLedgerStore;
declare const commitStager: FindingManagerCommitStager;
declare const rebinder: FindingManagerCommitRebinder;
declare const finalizer: FindingManagerCommitFinalizer;
declare const rawFindings: RawFinding[];
declare const managerReport: FindingManagerValidationReport;
declare const publication: FindingManagerReportPublication;
declare const receipt: ReportPublicationReceipt;

const ledgerSnapshotResult: void = writer.saveLedgerSnapshot();
const rawFindingsResult: void = writer.saveRawFindings('run-id', 'reviewers', rawFindings);
const managerReportResult: void = writer.saveManagerValidationReport(managerReport);
const plannedPublicationResult: FindingManagerReportPublication = (
  writer.planManagerValidationPublication('round-marker', managerReport)
);
const boundPublicationResult: FindingManagerReportPublication = (
  writer.bindManagerValidationPublication('round-marker', publication)
);
const publishedReceiptResult: ReportPublicationReceipt = (
  writer.publishManagerValidationPublication(publication)
);
const rebindResult: Promise<FindingLedger> = (
  rebinder.rebindPendingManagerValidationPublication(publication)
);
const finalizationResult: Promise<FindingManagerCommitFinalization> = (
  finalizer.finalizeManagerValidationPublication(publication, receipt)
);
const managerCommitResult: Promise<FindingLedgerMutation<void>> = (
  commitStager.commitManagerLedger((ledger) => ({
    ledger,
    result: undefined,
  }))
);

// @ts-expect-error Receipt verification is inseparable from pending-ledger finalization.
finalizer.assertManagerValidationPublication(publication, receipt);

// @ts-expect-error General ledger replacement is not part of the store contract.
ledgerStore.saveLedger(ledgerStore.loadLedger());

// @ts-expect-error Artifact writers cannot stage pending manager publications.
writer.commitManagerLedger(() => ({
  ledger: ledgerStore.loadLedger(),
  result: undefined,
}));

createFindingManagerPublicationDouble(
  () => '/tmp/findings-manager-validation.reviewers.json',
  new RevisionedFindingLedgerTestRepository(ledgerStore.loadLedger()),
);

void ledgerSnapshotResult;
void rawFindingsResult;
void managerReportResult;
void plannedPublicationResult;
void boundPublicationResult;
void publishedReceiptResult;
void rebindResult;
void finalizationResult;
void managerCommitResult;
