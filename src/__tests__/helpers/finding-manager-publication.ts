import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';
import type {
  FindingLedger,
  FindingManagerReportPublication,
  FindingManagerValidationReport,
} from '../../core/workflow/findings/types.js';
import {
  finalizeReportPublication,
  publishReportFile,
} from '../../core/workflow/report-writer.js';
import type {
  FindingArtifactWriter,
  FindingManagerCommitFinalizer,
  FindingManagerCommitRebinder,
  FindingManagerCommitFinalization,
  FindingManagerCommitStager,
  FindingManagerLedgerCommit,
  FindingLedgerMutation,
  FindingLedgerPublicationDecision,
  FindingLedgerStore,
} from '../../core/workflow/findings/store.js';
import type { ReportPublicationReceipt } from '../../core/workflow/report-publication.js';
import { finalizePendingManagerCommit } from '../../core/workflow/findings/manager-pending-commit.js';
import {
  assertFindingManagerLedgerCommit,
  cloneFindingLedgerMutation,
  normalizeFindingLedger,
  normalizeFindingLedgerMutation,
  normalizePendingManagerCommitRebind,
  normalizePendingManagerCommitStage,
} from '../../core/workflow/findings/ledger-mutation.js';
import {
  computeFindingManagerReportPublicationId,
  findingManagerValidationReportFileName,
  serializeFindingManagerValidationReport,
} from '../../core/workflow/findings/manager-report-content.js';
import { authorizeFindingLedgerFixture } from './finding-lifecycle-fixture.js';

type PublicationMethods = FindingManagerCommitRebinder
  & FindingManagerCommitFinalizer
  & FindingManagerCommitStager
  & Pick<
    FindingArtifactWriter,
    | 'planManagerValidationPublication'
    | 'bindManagerValidationPublication'
    | 'publishManagerValidationPublication'
  >;

export class RevisionedFindingLedgerTestRepository {
  readonly publicationDomainId = sha256(randomUUID());
  private ledger: FindingLedger;
  private revision = 0;
  private queue: Promise<void> = Promise.resolve();
  private nextExclusiveMutation:
    | ((current: FindingLedger) => FindingLedger)
    | undefined;

  constructor(initialLedger: FindingLedger) {
    const completeProjection = {
      ...initialLedger,
      evidenceBindings: initialLedger.evidenceBindings ?? [],
      lifecycleReservations: initialLedger.lifecycleReservations ?? [],
      lifecycleEvents: initialLedger.lifecycleEvents ?? [],
      rawRecoveryAttempts: initialLedger.rawRecoveryAttempts ?? [],
      rawRecoveryResults: initialLedger.rawRecoveryResults ?? [],
    };
    const authorized = completeProjection.lifecycleEvents.length > 0
      || (completeProjection.findings.length === 0
        && completeProjection.conflicts.length === 0)
      ? completeProjection
      : authorizeFindingLedgerFixture(completeProjection);
    this.ledger = structuredClone(
      normalizeFindingLedger(authorized, initialLedger.workflowName),
    );
  }

  loadLedger(): FindingLedger {
    return structuredClone(
      normalizeFindingLedger(this.ledger, this.ledger.workflowName),
    );
  }

  updateLedger<Result>(
    mutator: (current: FindingLedger) => FindingLedgerMutation<Result>,
    revalidateBeforeSave?: (
      current: FindingLedger,
      mutation: FindingLedgerMutation<Result>,
    ) => FindingLedgerPublicationDecision<Result>,
  ): Promise<FindingLedgerMutation<Result>> {
    return this.withLedgerExclusive(
      mutator,
      (current, mutation) => {
        const prepared = normalizeFindingLedgerMutation(
          current,
          mutation,
          current.workflowName,
        );
        if (revalidateBeforeSave === undefined) {
          return prepared;
        }
        const decision = revalidateBeforeSave(
          structuredClone(current),
          cloneFindingLedgerMutation(prepared),
        );
        return normalizeFindingLedgerMutation(
          current,
          decision.mutation,
          current.workflowName,
        );
      },
    );
  }

  commitManagerLedger<Result>(
    operation: (current: FindingLedger) => FindingManagerLedgerCommit<Result>,
    planPublication: (
      roundMarker: string,
      report: FindingManagerValidationReport,
    ) => FindingManagerReportPublication,
  ): Promise<FindingLedgerMutation<Result>> {
    return this.withLedgerExclusive(
      (current) => {
        const commit = operation(structuredClone(current));
        assertFindingManagerLedgerCommit(commit);
        const stagedCandidate = commit.ledger.pendingManagerCommit;
        const requestedStage = commit.publication ?? (
          stagedCandidate === undefined
            ? undefined
            : {
                roundMarker: stagedCandidate.roundMarker,
                report: stagedCandidate.publication.report,
              }
        );
        const completedLedger = stagedCandidate === undefined
          ? commit.ledger
          : {
              workflowName: current.workflowName,
              ...stagedCandidate.completed,
            };
        const completed = normalizeFindingLedgerMutation(
          current,
          { ledger: completedLedger, result: commit.result },
          current.workflowName,
        );
        if (requestedStage === undefined) {
          return completed;
        }
        const publication = planPublication(
          requestedStage.roundMarker,
          requestedStage.report,
        );
        const stagedLedger = normalizePendingManagerCommitStage(
          current,
          completed.ledger,
          requestedStage.roundMarker,
          publication,
          current.workflowName,
        );
        if (
          stagedCandidate !== undefined
          && (
            !samePublication(stagedCandidate.publication, publication)
            || JSON.stringify(normalizeFindingLedger(
              commit.ledger,
              current.workflowName,
            )) !== JSON.stringify(stagedLedger)
          )
        ) {
          throw new Error('Finding manager commit contains a forged publication stage');
        }
        return {
          ledger: stagedLedger,
          result: completed.result,
        };
      },
      (current, mutation) => ({
        ...mutation,
        ledger: normalizeFindingLedger(mutation.ledger, current.workflowName),
      }),
    );
  }

  corruptStateForFixture(corruptLedger: FindingLedger): void {
    this.ledger = structuredClone(corruptLedger);
  }

  commitBeforeNextExclusiveMutation(
    mutation: (current: FindingLedger) => FindingLedger,
  ): void {
    if (this.nextExclusiveMutation !== undefined) {
      throw new Error('A concurrent test ledger mutation is already scheduled');
    }
    this.nextExclusiveMutation = mutation;
  }

  private async withLedgerExclusive<Result>(
    operation: (current: FindingLedger) => FindingLedgerMutation<Result>,
    normalizeMutation: (
      current: FindingLedger,
      mutation: FindingLedgerMutation<Result>,
    ) => FindingLedgerMutation<Result>,
  ): Promise<FindingLedgerMutation<Result>> {
    const preceding = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    const concurrentMutation = this.nextExclusiveMutation;
    this.nextExclusiveMutation = undefined;
    if (concurrentMutation !== undefined) {
      this.ledger = structuredClone(normalizeFindingLedger(
        authorizeFindingLedgerFixture(
          concurrentMutation(structuredClone(this.ledger)),
        ),
        this.ledger.workflowName,
      ));
      this.revision += 1;
    }
    const expectedRevision = this.revision;
    try {
      const current = normalizeFindingLedger(this.ledger, this.ledger.workflowName);
      const mutation = normalizeMutation(current, operation(structuredClone(current)));
      if (this.revision !== expectedRevision) {
        throw new Error(`Test finding ledger CAS mismatch at revision ${expectedRevision}`);
      }
      this.ledger = structuredClone(mutation.ledger);
      this.revision = expectedRevision + 1;
      return {
        ledger: structuredClone(this.ledger),
        result: mutation.result,
      };
    } finally {
      release();
    }
  }

  finalizeManagerCommit(
    operation: (current: FindingLedger) => FindingManagerCommitFinalization,
  ): Promise<FindingManagerCommitFinalization> {
    return this.withLedgerExclusive(
      (current) => {
        const finalization = operation(current);
        return {
          ledger: finalization.ledger,
          result: finalization,
        };
      },
      (current, mutation) => ({
        ...mutation,
        ledger: normalizeFindingLedger(mutation.ledger, current.workflowName),
      }),
    ).then((mutation) => mutation.result);
  }

  rebindManagerCommit(
    publication: FindingManagerReportPublication,
  ): Promise<FindingLedger> {
    return this.withLedgerExclusive(
      (current) => ({
        ledger: normalizePendingManagerCommitRebind(
          current,
          publication,
          current.workflowName,
        ),
        result: undefined,
      }),
      (current, mutation) => ({
        ...mutation,
        ledger: normalizeFindingLedger(mutation.ledger, current.workflowName),
      }),
    ).then((mutation) => mutation.ledger);
  }
}

export function observeFindingLedgerMutations(
  repository: RevisionedFindingLedgerTestRepository,
  managerCommitStager: FindingManagerCommitStager,
  observer: (ledger: FindingLedger) => void | Promise<void>,
): Pick<FindingLedgerStore, 'updateLedger' | 'commitManagerLedger'> {
  const observe = async <Result>(
    mutation: Promise<FindingLedgerMutation<Result>>,
  ): Promise<FindingLedgerMutation<Result>> => {
    const committed = await mutation;
    await observer(committed.ledger);
    return committed;
  };
  return {
    updateLedger: <Result>(
      mutator: (current: FindingLedger) => FindingLedgerMutation<Result>,
      revalidateBeforeSave?: (
        current: FindingLedger,
        mutation: FindingLedgerMutation<Result>,
      ) => FindingLedgerPublicationDecision<Result>,
    ) => observe(repository.updateLedger(mutator, revalidateBeforeSave)),
    commitManagerLedger: <Result>(
      mutator: (current: FindingLedger) => FindingManagerLedgerCommit<Result>,
    ) => observe(managerCommitStager.commitManagerLedger(mutator)),
  };
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function reportContent(report: FindingManagerValidationReport): string {
  return serializeFindingManagerValidationReport(report);
}

function publicationId(
  roundMarker: string,
  report: FindingManagerValidationReport,
  fileName: string,
  contentSha256: string,
): string {
  return computeFindingManagerReportPublicationId({
    roundMarker,
    originRunId: report.runId,
    fileName,
    contentSha256,
  });
}

function samePublication(
  left: FindingManagerReportPublication,
  right: FindingManagerReportPublication,
): boolean {
  return left.publicationId === right.publicationId
    && left.domainId === right.domainId
    && left.originRunId === right.originRunId
    && left.destinationRunId === right.destinationRunId
    && left.fileName === right.fileName
    && left.contentSha256 === right.contentSha256
    && reportContent(left.report) === reportContent(right.report);
}

export function createFindingManagerPublicationDouble(
  saveReport: (report: FindingManagerValidationReport) => string,
  ledgerRepository: RevisionedFindingLedgerTestRepository,
): PublicationMethods {
  const domainId = ledgerRepository.publicationDomainId;
  const targets = new Map<string, string>();
  const assertPublicationContent = (
    publication: FindingManagerReportPublication,
  ): void => {
    if (publication.domainId !== domainId
      || publication.report.runId !== publication.originRunId
      || publication.destinationRunId !== publication.originRunId
      || publication.fileName
        !== findingManagerValidationReportFileName(publication.report)
      || publication.contentSha256 !== sha256(reportContent(publication.report))) {
      throw new Error(`Invalid test manager publication "${publication.publicationId}"`);
    }
  };
  const assertPublication = (
    roundMarker: string,
    publication: FindingManagerReportPublication,
  ): void => {
    assertPublicationContent(publication);
    if (publication.publicationId !== publicationId(
      roundMarker,
      publication.report,
      publication.fileName,
      publication.contentSha256,
    )) {
      throw new Error(`Invalid test manager publication "${publication.publicationId}"`);
    }
  };
  const planManagerValidationPublication = (
    roundMarker: string,
    report: FindingManagerValidationReport,
  ): FindingManagerReportPublication => {
    const contentSha256 = sha256(reportContent(report));
    const fileName = findingManagerValidationReportFileName(report);
    return {
      publicationId: publicationId(
        roundMarker,
        report,
        fileName,
        contentSha256,
      ),
      domainId,
      originRunId: report.runId,
      destinationRunId: report.runId,
      fileName,
      contentSha256,
      report,
    };
  };
  return {
    commitManagerLedger: (mutator) => ledgerRepository.commitManagerLedger(
      mutator,
      planManagerValidationPublication,
    ),
    planManagerValidationPublication,
    bindManagerValidationPublication: (roundMarker, publication) => {
      assertPublication(roundMarker, publication);
      return publication;
    },
    rebindPendingManagerValidationPublication: async (publication) => {
      const pending = ledgerRepository.loadLedger().pendingManagerCommit;
      if (pending === undefined) {
        throw new Error(
          `Pending manager commit CAS failed for publication "${publication.publicationId}"`,
        );
      }
      assertPublication(pending.roundMarker, publication);
      if (!samePublication(pending.publication, publication)) {
        throw new Error(
          `Invalid pending test manager publication "${publication.publicationId}"`,
        );
      }
      return ledgerRepository.rebindManagerCommit(publication);
    },
    publishManagerValidationPublication: (publication) => {
      assertPublicationContent(publication);
      const targetPath = saveReport(publication.report);
      if (basename(targetPath) !== publication.fileName) {
        throw new Error(
          `Test manager publication target "${targetPath}" does not match "${publication.fileName}"`,
        );
      }
      const receipt = publishReportFile({
        reportDir: dirname(targetPath),
        fileName: publication.fileName,
        publicationId: publication.publicationId,
        content: reportContent(publication.report),
        contentSha256: publication.contentSha256,
      });
      targets.set(publication.publicationId, targetPath);
      return receipt;
    },
    finalizeManagerValidationPublication: async (publication, receipt) => {
      const targetPath = targets.get(publication.publicationId);
      if (targetPath === undefined) {
        throw new Error(`Invalid test manager publication receipt "${receipt.publicationId}"`);
      }
      return ledgerRepository.finalizeManagerCommit((current) => {
        return finalizeReportPublication(receipt, {
          reportDir: dirname(targetPath),
          targetPath,
          publicationId: publication.publicationId,
          contentSha256: publication.contentSha256,
        }, () => {
          const pending = current.pendingManagerCommit;
          if (pending === undefined) {
            throw new Error(
              `Pending manager commit CAS failed for publication "${publication.publicationId}"`,
            );
          }
          assertPublication(pending.roundMarker, publication);
          if (!samePublication(pending.publication, publication)) {
            throw new Error(
              `Invalid pending test manager publication "${publication.publicationId}"`,
            );
          }
          return {
            ledger: finalizePendingManagerCommit(
              current,
              publication.publicationId,
            ),
            completedRoundMarker: pending.roundMarker,
          };
        });
      });
    },
  };
}
