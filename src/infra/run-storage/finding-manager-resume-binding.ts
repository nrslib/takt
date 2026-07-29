import type {
  FindingLedger,
  FindingManagerReportPublication,
} from '../../core/workflow/findings/types.js';
import {
  serializeFindingManagerValidationReport,
} from '../../core/workflow/findings/manager-report-content.js';
import { normalizeFindingLedger } from '../../core/workflow/findings/ledger-mutation.js';
import type { RunReadContext } from './context.js';
import type { FindingRepository } from './findings.js';
import {
  assertNativePublicationContent,
  assertPublication,
  assertPublicationIntent,
} from './finding-manager-adapter-contract.js';

interface FindingManagerResumeBindingOptions {
  readonly findings: FindingRepository;
  readonly runId: string;
  readonly scopeId: string;
  readonly workflowName: string;
  readonly publicationDomainId: string;
}

export function createFindingManagerResumeBinding(
  options: FindingManagerResumeBindingOptions,
) {
  const loadLedger = (context: RunReadContext): FindingLedger => (
    normalizeFindingLedger(
      options.findings.loadLedger(context, {
        runId: options.runId,
        scopeId: options.scopeId,
        workflowName: options.workflowName,
      }).ledger,
      options.workflowName,
    )
  );

  const deriveBoundPublication = (
    _context: RunReadContext,
    current: FindingLedger,
  ): FindingManagerReportPublication => {
    const pending = current.pendingManagerCommit;
    if (pending === undefined) {
      throw new Error('Finding manager resume binding requires a pending publication');
    }
    assertPublicationIntent(pending.publication, pending.roundMarker);
    if (pending.publication.destinationRunId !== options.runId) {
      throw new Error(
        `Finding manager publication "${pending.publication.publicationId}" is not bound to this run`,
      );
    }
    return pending.publication;
  };

  return {
    bind(
      context: RunReadContext,
      roundMarker: string,
      publication: FindingManagerReportPublication,
    ): FindingManagerReportPublication {
      const current = loadLedger(context);
      const pending = current.pendingManagerCommit;
      if (
        pending === undefined
        || pending.roundMarker !== roundMarker
        || !sameManagerPublicationIntent(pending.publication, publication)
      ) {
        assertPublication(
          publication,
          roundMarker,
          options.publicationDomainId,
          options.runId,
        );
        return publication;
      }
      return deriveBoundPublication(context, current);
    },
    deriveBoundPublication,
    assertPublishable(
      context: RunReadContext,
      publication: FindingManagerReportPublication,
    ): void {
      const pending = loadLedger(context).pendingManagerCommit;
      if (
        pending === undefined
        || !sameManagerPublication(pending.publication, publication)
      ) {
        assertNativePublicationContent(
          publication,
          options.publicationDomainId,
          options.runId,
        );
        return;
      }
      assertPublicationIntent(publication, pending.roundMarker);
      if (publication.destinationRunId !== options.runId) {
        throw new Error(
          `Finding manager publication "${publication.publicationId}" is not bound to this run`,
        );
      }
    },
  };
}

function sameManagerPublicationIntent(
  left: FindingManagerReportPublication,
  right: FindingManagerReportPublication,
): boolean {
  return left.publicationId === right.publicationId
    && left.domainId === right.domainId
    && left.originRunId === right.originRunId
    && left.fileName === right.fileName
    && left.contentSha256 === right.contentSha256
    && serializeFindingManagerValidationReport(left.report)
      === serializeFindingManagerValidationReport(right.report);
}

export function sameManagerPublication(
  left: FindingManagerReportPublication,
  right: FindingManagerReportPublication,
): boolean {
  return left.publicationId === right.publicationId
    && left.domainId === right.domainId
    && left.originRunId === right.originRunId
    && left.destinationRunId === right.destinationRunId
    && left.fileName === right.fileName
    && left.contentSha256 === right.contentSha256
    && serializeFindingManagerValidationReport(left.report)
      === serializeFindingManagerValidationReport(right.report);
}
