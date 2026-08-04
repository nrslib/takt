import { createHash } from 'node:crypto';
import type { CandidateSourceBinding, FindingLedger, FindingLedgerEntry } from './types.js';
import {
  assertCanonicalFindingReviewPublication,
  type CanonicalFindingReviewPublication,
} from './review-publication.js';
import {
  bindReviewerReportExcerpt,
  extractLenientRawFields,
} from './raw-canonicalization.js';
import type {
  MainManagerControlReportExcerpt,
} from './manager-task-contracts.js';

export function computeWorkflowTaskDigest(workflowTask: string): string {
  return createHash('sha256').update(workflowTask, 'utf8').digest('hex');
}

export function isByteExactWorkflowTaskQuote(
  workflowTask: string,
  taskQuote: string,
): boolean {
  const taskBytes = Buffer.from(workflowTask, 'utf8');
  const quoteBytes = Buffer.from(taskQuote, 'utf8');
  return quoteBytes.length > 0 && taskBytes.indexOf(quoteBytes) >= 0;
}

function sourceBindingKey(binding: CandidateSourceBinding): string {
  return [
    binding.reportDigest,
    binding.startByte,
    binding.endByte,
    binding.excerptDigest,
  ].join(':');
}

function relatedRawExcerpts(
  publication: CanonicalFindingReviewPublication,
  finding: FindingLedgerEntry,
  ledgerRawFindings: FindingLedger['rawFindings'],
): string[] {
  const rawFindingIds = new Set([
    ...finding.rawFindingIds,
    ...(finding.provisional?.sourceRawFindingIds ?? []),
  ]);
  const sourceBindingKeys = new Set(
    ledgerRawFindings
      .filter((rawFinding) => rawFindingIds.has(rawFinding.rawFindingId))
      .map((rawFinding) => sourceBindingKey(rawFinding.sourceBinding)),
  );
  return publication.rawFindings.flatMap((rawFinding) => {
    const fields = extractLenientRawFields(rawFinding);
    if (fields.rawExcerpt === undefined) {
      return [];
    }
    const binding = bindReviewerReportExcerpt(
      publication.reportContent,
      fields.rawExcerpt,
    );
    return (
      fields.targetFindingIds?.includes(finding.id) === true
      || sourceBindingKeys.has(sourceBindingKey(binding))
    )
      ? [fields.rawExcerpt]
      : [];
  });
}

export function collectTaskScopeReportExcerpts(input: {
  finding: FindingLedgerEntry;
  ledgerRawFindings: FindingLedger['rawFindings'];
  publications: readonly CanonicalFindingReviewPublication[];
}): MainManagerControlReportExcerpt[] {
  return input.publications.flatMap((publication) => {
    assertCanonicalFindingReviewPublication(publication);
    const rawExcerpts = [...new Set(
      relatedRawExcerpts(
        publication,
        input.finding,
        input.ledgerRawFindings,
      ),
    )];
    if (rawExcerpts.length === 0) {
      return [];
    }
    const excerpt = rawExcerpts.join('\n\n');
    return [{
      publicationId: publication.publicationId,
      reportDigest: publication.reportDigest,
      excerpt,
      excerptDigest: computeWorkflowTaskDigest(excerpt),
    }];
  });
}
