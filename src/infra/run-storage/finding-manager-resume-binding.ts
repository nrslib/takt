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
  assertResumePublicationProvenance,
} from './finding-manager-adapter-contract.js';
import {
  readImportedFindingLedger,
  type TrustedFindingResumeSource,
} from './finding-resume-source.js';

interface FindingManagerResumeBindingOptions {
  readonly findings: FindingRepository;
  readonly runId: string;
  readonly scopeId: string;
  readonly workflowName: string;
  readonly publicationDomainId: string;
  readonly trustedResumeSource?: TrustedFindingResumeSource;
}

export function createFindingManagerResumeBinding(
  options: FindingManagerResumeBindingOptions,
) {
  const loadLedger = (context: RunReadContext): FindingLedger => (
    normalizeFindingLedger(
      options.findings.loadLedger(context, {
        runId: options.runId,
        scopeId: options.scopeId,
      }).ledger,
      options.workflowName,
    )
  );

  const deriveBoundPublication = (
    context: RunReadContext,
    current: FindingLedger,
  ): FindingManagerReportPublication => {
    const pending = current.pendingManagerCommit;
    if (pending === undefined) {
      throw new Error('Finding manager resume binding requires a pending publication');
    }
    assertPublicationIntent(pending.publication, pending.roundMarker);
    if (pending.publication.destinationRunId === options.runId) {
      return pending.publication;
    }
    const trusted = options.trustedResumeSource;
    if (trusted === undefined) {
      throw new Error(
        `Finding manager publication "${pending.publication.publicationId}" has no trusted direct resume source`,
      );
    }
    const imported = readImportedFindingLedger(
      context,
      options.runId,
      options.scopeId,
      trusted,
    );
    const importedPending = imported.pendingManagerCommit;
    const ancestry = context.all<{ readonly ancestorRunId: string }>(`
      SELECT ancestor_run_id AS ancestorRunId
      FROM run_ancestry
      WHERE run_id = ?
    `, options.runId);
    assertResumePublicationProvenance(
      pending.publication,
      pending.roundMarker,
      {
        directSourceRunId: trusted.sourceRunId,
        originRunIds: new Set(
          ancestry.map(({ ancestorRunId }) => ancestorRunId),
        ),
        originScopeId: trusted.sourceScopeId,
        workflowName: options.workflowName,
      },
    );
    if (
      importedPending === undefined
      || importedPending.roundMarker !== pending.roundMarker
      || importedPending.publication.destinationRunId !== trusted.sourceRunId
      || !sameManagerPublication(importedPending.publication, pending.publication)
    ) {
      throw new Error(
        `Finding manager publication "${pending.publication.publicationId}" does not match the direct parent snapshot`,
      );
    }
    return {
      ...importedPending.publication,
      destinationRunId: options.runId,
    };
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
        || !sameManagerPublication(pending.publication, publication)
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
