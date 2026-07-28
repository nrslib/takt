import { randomUUID } from 'node:crypto';
import type {
  FindingLedger,
  FindingManagerReportPublication,
} from '../../core/workflow/findings/types.js';
import { parseRawFindings } from '../../core/workflow/findings/schemas.js';
import type {
  FindingLedgerMutation,
  FindingLedgerPublicationDecision,
  FindingLedgerStore,
  FindingConflictAdjudicationAuditReport,
  FindingManagerLedgerCommit,
} from '../../core/workflow/findings/store.js';
import {
  assertFindingManagerLedgerCommit,
  cloneFindingLedgerMutation,
  normalizeFindingLedger,
  normalizeFindingLedgerMutation,
  normalizePendingManagerCommitFinalization,
  normalizePendingManagerCommitRebind,
  normalizePendingManagerCommitStage,
} from '../../core/workflow/findings/ledger-mutation.js';
import type { ReportPublicationReceipt } from '../../core/workflow/report-publication.js';
import { canonicalJson, sha256 } from './canonical-json.js';
import {
  computeFindingManagerReportPublicationId,
  serializeFindingManagerValidationReport,
} from '../../core/workflow/findings/manager-report-content.js';
import {
  assertPublicationIntent,
  assertReportRun,
  findingManagerPublicationDomainId,
  managerReportName,
  normalizeDecision,
  sanitizeSegment,
} from './finding-manager-adapter-contract.js';
import { FindingRepository } from './findings.js';
import type { LeaseOwner } from './lease.js';
import { ReportRepository } from './reports.js';
import type { RunStorageExecutor } from './runtime-composition.js';
import type { RunReadContext } from './context.js';
import {
  createPublicReportStreamIdentity,
  type PublicReportStreamIdentity,
} from './report-stream-identity.js';
import {
  type TrustedFindingResumeSource,
} from './finding-resume-source.js';
import {
  createFindingManagerResumeBinding,
  sameManagerPublication,
} from './finding-manager-resume-binding.js';

const LEDGER_SNAPSHOT_STREAM = createPublicReportStreamIdentity(
  'findings-ledger.json',
);
const REPORT_REVISION_PATTERN = /^[1-9]\d*$/;

interface RunFindingManagerStoreOptions {
  readonly executor: RunStorageExecutor;
  readonly owner: LeaseOwner;
  readonly runId: string;
  readonly scopeId: string;
  readonly workflowName: string;
  readonly producerScopeId: string;
  readonly producerExecutionId: string;
  readonly trustedResumeSource?: TrustedFindingResumeSource;
}

export function createRunFindingManagerStore(
  options: RunFindingManagerStoreOptions,
): FindingLedgerStore {
  const access = options.executor;
  const findings = new FindingRepository();
  const reports = new ReportRepository();
  const ledgerIdentity = sha256([
    'finding-ledger',
    options.runId,
    options.scopeId,
  ].join('\0'));
  const publicationDomainId = findingManagerPublicationDomainId({
    runId: options.runId,
    scopeId: options.scopeId,
    workflowName: options.workflowName,
  });
  const resumeBinding = createFindingManagerResumeBinding({
    findings,
    runId: options.runId,
    scopeId: options.scopeId,
    workflowName: options.workflowName,
    publicationDomainId,
    ...(options.trustedResumeSource === undefined
      ? {}
      : { trustedResumeSource: options.trustedResumeSource }),
  });

  const loadLedger = (): FindingLedger => access.read((context) => {
    const record = findings.loadLedger(context, {
      runId: options.runId,
      scopeId: options.scopeId,
    });
    return normalizeFindingLedger(record.ledger, options.workflowName);
  });

  const appendReport = (
    publicationKey: string,
    stream: PublicReportStreamIdentity,
    content: string,
  ): ReportPublicationReceipt => (
    access.write(options.owner, (context, now) => {
      const latest = reports.latest(context, {
        runId: options.runId,
        ownerScopeId: options.scopeId,
        stream,
      });
      const revision = reports.append(context, {
        runId: options.runId,
        ownerScopeId: options.scopeId,
        publicationKey,
        stream,
        expectedRevision: latest?.revision ?? 0,
        codecName: 'json-v1',
        content,
        producerScopeId: options.producerScopeId,
        producerExecutionId: options.producerExecutionId,
        createdAt: now,
      });
      return {
        publicationId: publicationKey,
        streamId: revision.streamId,
        revision: String(revision.revision),
        contentSha256: revision.digest,
      };
    })
  );

  const reportRevision = (receipt: ReportPublicationReceipt): number => {
    if (!REPORT_REVISION_PATTERN.test(receipt.revision)) {
      throw new Error(
        `Finding manager publication "${receipt.publicationId}" receipt mismatch`,
      );
    }
    const revision = Number(receipt.revision);
    if (!Number.isSafeInteger(revision)) {
      throw new Error(
        `Finding manager publication "${receipt.publicationId}" receipt mismatch`,
      );
    }
    return revision;
  };

  const assertStoredManagerPublication = (
    context: RunReadContext,
    publication: FindingManagerReportPublication,
    receipt: ReportPublicationReceipt,
  ): void => {
    const stream = createPublicReportStreamIdentity(publication.fileName);
    const stored = reports.revision(context, {
      runId: options.runId,
      ownerScopeId: options.scopeId,
      stream,
      revision: reportRevision(receipt),
    });
    if (stored === undefined
      || stored.streamName !== publication.fileName
      || stored.publicationKey !== publication.publicationId
      || receipt.publicationId !== publication.publicationId
      || receipt.streamId !== stored.streamId
      || receipt.revision !== String(stored.revision)
      || receipt.contentSha256 !== publication.contentSha256
      || receipt.contentSha256 !== stored.digest
      || stored.digest !== publication.contentSha256) {
      throw new Error(
        `Finding manager publication "${publication.publicationId}" receipt mismatch`,
      );
    }
  };

  const bindManagerValidationPublication = (
    roundMarker: string,
    publication: FindingManagerReportPublication,
  ): FindingManagerReportPublication => {
    return access.read((context) => (
      resumeBinding.bind(context, roundMarker, publication)
    ));
  };
  const planManagerValidationPublication = (
    roundMarker: string,
    report: FindingManagerReportPublication['report'],
  ): FindingManagerReportPublication => {
    assertReportRun(report, options.runId);
    const fileName = managerReportName(report);
    const contentSha256 = sha256(serializeFindingManagerValidationReport(report));
    return {
      publicationId: computeFindingManagerReportPublicationId({
        roundMarker,
        originRunId: options.runId,
        fileName,
        contentSha256,
      }),
      domainId: publicationDomainId,
      originRunId: options.runId,
      destinationRunId: options.runId,
      fileName,
      contentSha256,
      report,
    };
  };
  const normalizeManagerCommit = <Result>(
    context: RunReadContext,
    current: FindingLedger,
    commit: FindingManagerLedgerCommit<Result>,
  ): FindingLedgerMutation<Result> => {
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
      options.workflowName,
    );
    if (requestedStage === undefined) {
      return completed;
    }
    const publication = resumeBinding.bind(
      context,
      requestedStage.roundMarker,
      planManagerValidationPublication(
        requestedStage.roundMarker,
        requestedStage.report,
      ),
    );
    const stagedLedger = normalizePendingManagerCommitStage(
      current,
      completed.ledger,
      requestedStage.roundMarker,
      publication,
      options.workflowName,
    );
    if (
      stagedCandidate !== undefined
      && (
        !sameManagerPublication(stagedCandidate.publication, publication)
        || JSON.stringify(normalizeFindingLedger(
          commit.ledger,
          options.workflowName,
        )) !== JSON.stringify(stagedLedger)
      )
    ) {
      throw new Error('Finding manager commit contains a forged publication stage');
    }
    return {
      ledger: stagedLedger,
      result: completed.result,
    };
  };

  return {
    runId: options.runId,
    ledgerIdentity,
    workflowName: options.workflowName,
    loadLedger,
    updateLedger: <Result>(
      mutator: (current: FindingLedger) => FindingLedgerMutation<Result>,
      revalidateBeforeSave?: (
        current: FindingLedger,
        mutation: FindingLedgerMutation<Result>,
      ) => FindingLedgerPublicationDecision<Result>,
    ): Promise<FindingLedgerMutation<Result>> => {
      const committed = access.write(options.owner, (context, now) => {
        const record = findings.loadLedger(context, {
          runId: options.runId,
          scopeId: options.scopeId,
        });
        const current = normalizeFindingLedger(record.ledger, options.workflowName);
        const mutation = normalizeFindingLedgerMutation(
          current,
          mutator(structuredClone(current)),
          options.workflowName,
        );
        const decision = revalidateBeforeSave === undefined
          ? { mutation, publish: true }
          : normalizeDecision(
              current,
              revalidateBeforeSave(
                structuredClone(current),
                cloneFindingLedgerMutation(mutation),
              ),
              options.workflowName,
            );
        if (
          current.pendingManagerCommit !== undefined
          && canonicalJson(decision.mutation.ledger) === canonicalJson(current)
        ) {
          return {
            ledger: current,
            result: decision.mutation.result,
          };
        }
        const stored = findings.replaceLedger(context, {
          runId: options.runId,
          scopeId: options.scopeId,
          workflowName: options.workflowName,
          expectedRevision: record.revision,
          ledger: decision.mutation.ledger,
          updatedAt: now,
        });
        return {
          ledger: stored.ledger,
          result: decision.mutation.result,
        };
      });
      return Promise.resolve(committed);
    },
    commitManagerLedger: <Result>(
      mutator: (current: FindingLedger) => FindingManagerLedgerCommit<Result>,
    ): Promise<FindingLedgerMutation<Result>> => {
      const committed = access.write(options.owner, (context, now) => {
        const record = findings.loadLedger(context, {
          runId: options.runId,
          scopeId: options.scopeId,
        });
        const current = normalizeFindingLedger(record.ledger, options.workflowName);
        const mutation = normalizeManagerCommit(
          context,
          current,
          mutator(structuredClone(current)),
        );
        const stored = findings.replaceLedger(context, {
          runId: options.runId,
          scopeId: options.scopeId,
          workflowName: options.workflowName,
          expectedRevision: record.revision,
          ledger: mutation.ledger,
          updatedAt: now,
        });
        return {
          ledger: stored.ledger,
          result: mutation.result,
        };
      });
      return Promise.resolve(committed);
    },
    claimAdjudicationReservation: (reservationToken) => (
      access.write(options.owner, (context, now) => (
        findings.claimAdjudicationReservation(context, {
          runId: options.runId,
          scopeId: options.scopeId,
          reservationToken,
          claimedAt: now,
        })
      ))
    ),
    releaseAdjudicationReservation: (reservationToken) => {
      access.write(options.owner, (context) => {
        findings.releaseAdjudicationReservation(context, {
          runId: options.runId,
          scopeId: options.scopeId,
          reservationToken,
        });
      });
    },
    saveLedgerSnapshot: () => {
      access.write(options.owner, (context, now) => {
        const ledger = findings.loadLedger(context, {
          runId: options.runId,
          scopeId: options.scopeId,
        });
        const content = canonicalJson(
          normalizeFindingLedger(ledger.ledger, options.workflowName),
        );
        const digest = sha256(content);
        const latest = reports.latest(context, {
          runId: options.runId,
          ownerScopeId: options.scopeId,
          stream: LEDGER_SNAPSHOT_STREAM,
        });
        if (latest?.digest === digest) {
          return;
        }
        const publicationKey = sha256([
          'finding-ledger-snapshot',
          ledgerIdentity,
          latest?.streamId ?? LEDGER_SNAPSHOT_STREAM.portableIdentity,
          String(latest?.revision ?? 0),
          latest?.digest ?? '',
          digest,
        ].join('\0'));
        reports.append(context, {
          runId: options.runId,
          ownerScopeId: options.scopeId,
          publicationKey,
          stream: LEDGER_SNAPSHOT_STREAM,
          expectedRevision: latest?.revision ?? 0,
          codecName: 'json-v1',
          content,
          producerScopeId: options.producerScopeId,
          producerExecutionId: options.producerExecutionId,
          createdAt: now,
        });
      });
    },
    saveRawFindings: (runId, stepName, rawFindings) => {
      if (runId !== options.runId) {
        throw new Error(
          `Raw Finding run "${runId}" does not match "${options.runId}"`,
        );
      }
      const parsed = parseRawFindings(rawFindings);
      appendReport(
        randomUUID(),
        createPublicReportStreamIdentity(
          `raw-findings.${sanitizeSegment(stepName)}.json`,
        ),
        canonicalJson(parsed),
      );
    },
    saveManagerValidationReport: (report) => {
      const fileName = managerReportName(report);
      const content = serializeFindingManagerValidationReport(report);
      const contentSha256 = sha256(content);
      appendReport(
        sha256(['manager-validation', fileName, contentSha256].join('\0')),
        createPublicReportStreamIdentity(fileName),
        content,
      );
    },
    planManagerValidationPublication,
    bindManagerValidationPublication,
    rebindPendingManagerValidationPublication: async (publication) => {
      const rebound = access.write(options.owner, (context, now) => {
        const record = findings.loadLedger(context, {
          runId: options.runId,
          scopeId: options.scopeId,
        });
        const current = normalizeFindingLedger(record.ledger, options.workflowName);
        const pending = current.pendingManagerCommit;
        if (pending === undefined) {
          throw new Error(
            `Pending manager commit CAS failed for publication "${publication.publicationId}"`,
          );
        }
        if (pending.publication.destinationRunId === options.runId) {
          throw new Error(
            `Finding manager publication "${publication.publicationId}" was already rebound`,
          );
        }
        const authorized = resumeBinding.deriveBoundPublication(context, current);
        if (!sameManagerPublication(authorized, publication)) {
          throw new Error(
            `Finding manager publication "${publication.publicationId}" is not authorized for pending rebind`,
          );
        }
        const reboundLedger = normalizePendingManagerCommitRebind(
          current,
          publication,
          options.workflowName,
        );
        const stored = findings.replaceLedger(context, {
          runId: options.runId,
          scopeId: options.scopeId,
          workflowName: options.workflowName,
          expectedRevision: record.revision,
          ledger: reboundLedger,
          updatedAt: now,
        });
        return stored.ledger;
      });
      return rebound;
    },
    publishManagerValidationPublication: (publication) => {
      access.read((context) => {
        resumeBinding.assertPublishable(context, publication);
      });
      return appendReport(
        publication.publicationId,
        createPublicReportStreamIdentity(publication.fileName),
        serializeFindingManagerValidationReport(publication.report),
      );
    },
    finalizeManagerValidationPublication: (publication, receipt) => {
      const finalized = access.write(options.owner, (context, now) => {
        const record = findings.loadLedger(context, {
          runId: options.runId,
          scopeId: options.scopeId,
        });
        const current = normalizeFindingLedger(record.ledger, options.workflowName);
        const pending = current.pendingManagerCommit;
        if (pending === undefined) {
          throw new Error(
            `Pending manager commit CAS failed for publication "${publication.publicationId}"`,
          );
        }
        assertPublicationIntent(publication, pending.roundMarker);
        if (
          publication.destinationRunId !== options.runId
          || !sameManagerPublication(pending.publication, publication)
        ) {
          throw new Error(
            `Finding manager publication "${publication.publicationId}" failed integrity validation`,
          );
        }
        assertStoredManagerPublication(context, publication, receipt);
        const finalizedLedger = normalizePendingManagerCommitFinalization(
          current,
          publication.publicationId,
          options.workflowName,
        );
        const stored = findings.replaceLedger(context, {
          runId: options.runId,
          scopeId: options.scopeId,
          workflowName: options.workflowName,
          expectedRevision: record.revision,
          ledger: finalizedLedger,
          updatedAt: now,
        });
        return {
          ledger: stored.ledger,
          completedRoundMarker: pending.roundMarker,
        };
      });
      return Promise.resolve(finalized);
    },
    saveConflictAdjudicationReport: (report) => {
      appendReport(
        randomUUID(),
        createPublicReportStreamIdentity(
          `findings-adjudication.${sanitizeSegment(report.conflictId)}.json`,
        ),
        canonicalJson(report satisfies FindingConflictAdjudicationAuditReport),
      );
    },
  };
}
