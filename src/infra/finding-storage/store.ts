import type { FindingLedger } from '../../core/workflow/findings/types.js';
import type {
  FindingLedgerMutation,
  FindingLedgerPublicationDecision,
  FindingLedgerStore,
  FindingManagerCommitFinalization,
  FindingManagerLedgerCommit,
} from '../../core/workflow/findings/store.js';
import {
  assertFindingManagerLedgerCommit,
  normalizeFindingLedgerMutation,
  normalizePendingManagerCommitFinalization,
  normalizePendingManagerCommitRebind,
  normalizePendingManagerCommitStage,
} from '../../core/workflow/findings/ledger-mutation.js';
import { processInterpretationLiveClaims } from '../../core/workflow/findings/interpretation-live-claims.js';
import type {
  FindingManagerReportPublication,
  FindingManagerPendingCommit,
  FindingManagerValidationReport,
} from '../../core/workflow/findings/types.js';
import type { ReportPublicationReceipt } from '../../core/workflow/report-publication.js';
import {
  FindingArtifactStore,
  sameManagerPublication,
  validateManagerPublication,
} from './artifacts.js';
import { FindingAuthorityRepository } from './repository.js';

function normalizeManagerCommit<Result>(input: {
  readonly current: FindingLedger;
  readonly commit: FindingManagerLedgerCommit<Result>;
  readonly workflowName: string;
  readonly planPublication: (
    roundMarker: string,
    report: FindingManagerValidationReport,
  ) => FindingManagerReportPublication;
}): FindingLedgerMutation<Result> {
  assertFindingManagerLedgerCommit(input.commit);
  const stagedCandidate = input.commit.ledger.pendingManagerCommit;
  const requestedStage = input.commit.publication ?? (
    stagedCandidate === undefined
      ? undefined
      : {
          roundMarker: stagedCandidate.roundMarker,
          report: stagedCandidate.publication.report,
        }
  );
  const completedLedger = stagedCandidate === undefined
    ? input.commit.ledger
    : {
        workflowName: input.current.workflowName,
        ...stagedCandidate.completed,
      };
  const completed = normalizeFindingLedgerMutation(
    input.current,
    { ledger: completedLedger, result: input.commit.result },
    input.workflowName,
  );
  if (requestedStage === undefined) {
    return completed;
  }

  const publication = input.planPublication(
    requestedStage.roundMarker,
    requestedStage.report,
  );
  const stagedLedger = normalizePendingManagerCommitStage(
    input.current,
    completed.ledger,
    requestedStage.roundMarker,
    publication,
    input.workflowName,
  );
  if (stagedCandidate !== undefined && (
    !sameManagerPublication(stagedCandidate.publication, publication)
    || JSON.stringify(input.commit.ledger) !== JSON.stringify(stagedLedger)
  )) {
    throw new Error('Finding manager commit contains a forged publication stage');
  }
  return { ledger: stagedLedger, result: completed.result };
}

export class SqliteFindingLedgerStore implements FindingLedgerStore {
  readonly runId: string;
  readonly ledgerIdentity: string;
  readonly interpretationLiveClaims = processInterpretationLiveClaims;
  workflowName: string;
  readonly #authorityKey: string;
  readonly #repository: FindingAuthorityRepository;
  readonly #artifacts: FindingArtifactStore;

  constructor(input: {
    readonly runId: string;
    readonly databaseInstanceId: string;
    readonly authorityKey: string;
    readonly workflowName: string;
    readonly repository: FindingAuthorityRepository;
    readonly artifacts: FindingArtifactStore;
  }) {
    this.runId = input.runId;
    this.ledgerIdentity = [
      'finding-storage',
      input.databaseInstanceId,
      input.authorityKey,
    ].join(':');
    this.#authorityKey = input.authorityKey;
    this.workflowName = input.workflowName;
    this.#repository = input.repository;
    this.#artifacts = input.artifacts;
  }

  loadLedger(): FindingLedger {
    return this.#repository.load(this.#authorityKey, this.workflowName).ledger;
  }

  async updateLedger<Result>(
    mutator: (current: FindingLedger) => FindingLedgerMutation<Result>,
    revalidateBeforeSave?: (
      current: FindingLedger,
      mutation: FindingLedgerMutation<Result>,
    ) => FindingLedgerPublicationDecision<Result>,
  ): Promise<FindingLedgerMutation<Result>> {
    return this.#repository.update({
      authorityKey: this.#authorityKey,
      workflowName: this.workflowName,
      mutator,
      ...(revalidateBeforeSave === undefined ? {} : { revalidateBeforeSave }),
    });
  }

  async commitManagerLedger<Result>(
    mutator: (current: FindingLedger) => FindingManagerLedgerCommit<Result>,
  ): Promise<FindingLedgerMutation<Result>> {
    return this.#repository.updatePrepared({
      authorityKey: this.#authorityKey,
      workflowName: this.workflowName,
      prepare: (current) => normalizeManagerCommit({
        current,
        commit: mutator(structuredClone(current)),
        workflowName: this.workflowName,
        planPublication: (roundMarker, report) => (
          this.#artifacts.planManagerValidationPublication(roundMarker, report)
        ),
      }),
    });
  }

  saveLedgerSnapshot(): void {
    this.#artifacts.saveLedgerSnapshot(JSON.stringify(this.loadLedger(), null, 2));
  }

  saveRawFindings(...args: Parameters<FindingLedgerStore['saveRawFindings']>): void {
    this.#artifacts.saveRawFindings(...args);
  }

  saveManagerValidationReport(
    report: FindingManagerValidationReport,
  ): void {
    this.#artifacts.saveManagerValidationReport(report);
  }

  planManagerValidationPublication(
    roundMarker: string,
    report: FindingManagerValidationReport,
  ): FindingManagerReportPublication {
    return this.#artifacts.planManagerValidationPublication(roundMarker, report);
  }

  bindManagerValidationPublication(
    roundMarker: string,
    publication: FindingManagerReportPublication,
  ): FindingManagerReportPublication {
    validateManagerPublication(roundMarker, publication);
    if (publication.destinationRunId !== this.runId) {
      throw new Error(
        `Finding manager publication "${publication.publicationId}" is not bound to this run`,
      );
    }
    const planned = publication.originRunId === this.runId
      ? this.#artifacts.planManagerValidationPublication(roundMarker, publication.report)
      : undefined;
    if (planned !== undefined && sameManagerPublication(planned, publication)) {
      return publication;
    }
    const pending = this.loadLedger().pendingManagerCommit;
    if (pending?.roundMarker !== roundMarker
      || !sameManagerPublication(pending.publication, publication)) {
      throw new Error(
        `Finding manager publication "${publication.publicationId}" is not authorized by this authority`,
      );
    }
    return publication;
  }

  async rebindPendingManagerValidationPublication(
    publication: FindingManagerReportPublication,
  ): Promise<FindingLedger> {
    const mutation = this.#repository.updatePrepared({
      authorityKey: this.#authorityKey,
      workflowName: this.workflowName,
      prepare: (current) => {
        const pending = current.pendingManagerCommit;
        if (pending === undefined) {
          throw new Error(
            `Pending manager commit CAS failed for publication "${publication.publicationId}"`,
          );
        }
        validateManagerPublication(pending.roundMarker, publication);
        const expected = {
          ...pending.publication,
          destinationRunId: this.runId,
        };
        if (publication.destinationRunId !== this.runId
          || !sameManagerPublication(expected, publication)) {
          throw new Error(
            `Finding manager publication "${publication.publicationId}" is not authorized for pending rebind`,
          );
        }
        const ledger = normalizePendingManagerCommitRebind(
          current,
          publication,
          this.workflowName,
        );
        return { ledger, result: ledger };
      },
    });
    return mutation.ledger;
  }

  publishManagerValidationPublication(
    publication: FindingManagerReportPublication,
  ): ReportPublicationReceipt {
    this.#assertPendingPublication(this.loadLedger(), publication);
    return this.#artifacts.publishManagerValidationPublication(publication);
  }

  async finalizeManagerValidationPublication(
    publication: FindingManagerReportPublication,
    receipt: ReportPublicationReceipt,
  ): Promise<FindingManagerCommitFinalization> {
    this.#assertPendingPublication(this.loadLedger(), publication);
    this.#artifacts.validatePublicationReceipt(publication, receipt);
    return this.#artifacts.finalizeManagerValidationPublication(
      publication,
      receipt,
      () => {
        const mutation = this.#repository.updatePrepared({
          authorityKey: this.#authorityKey,
          workflowName: this.workflowName,
          prepare: (current) => {
            const pending = this.#assertPendingPublication(current, publication);
            this.#artifacts.validatePublicationReceipt(publication, receipt);
            const ledger = normalizePendingManagerCommitFinalization(
              current,
              publication.publicationId,
              this.workflowName,
            );
            return {
              ledger,
              result: {
                ledger,
                completedRoundMarker: pending.roundMarker,
              },
            };
          },
        });
        return mutation.result;
      },
    );
  }

  #assertPendingPublication(
    ledger: FindingLedger,
    publication: FindingManagerReportPublication,
  ): FindingManagerPendingCommit {
    const pending = ledger.pendingManagerCommit;
    if (pending === undefined
      || publication.destinationRunId !== this.runId
      || !sameManagerPublication(pending.publication, publication)) {
      throw new Error(
        `Finding manager publication "${publication.publicationId}" is not pending for this authority`,
      );
    }
    validateManagerPublication(pending.roundMarker, publication);
    return pending;
  }
}
