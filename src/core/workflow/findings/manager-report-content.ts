import { createHash } from 'node:crypto';
import type { FindingManagerValidationReport } from './store.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import {
  canonicalJson,
  compareCanonicalJsonValues,
} from '../../../shared/utils/canonical-json.js';

function sortStrings(values: readonly string[]): string[] {
  return [...values].sort(compareBinaryStrings);
}

function canonicalizeReport(
  report: FindingManagerValidationReport,
): FindingManagerValidationReport {
  const attempts = report.attempts
    .map((attempt) => ({
      ...attempt,
      managerOutput: attempt.managerOutput,
      validationErrors: [...attempt.validationErrors],
    }));
  const relationClarifications = report.relationClarifications
    ?.map((clarification) => ({
      ...clarification,
      flaggedRawFindingIds: sortStrings(clarification.flaggedRawFindingIds),
    }));
  const rawNormalizations = report.rawNormalizations
    ?.map((normalization) => ({
      ...normalization,
      ambiguityCodes: sortStrings(normalization.ambiguityCodes),
      normalizations: [...normalization.normalizations].sort(compareBinaryStrings),
    }));
  const provisionalLandings = report.provisionalLandings
    ?.map((landing) => ({
      ...landing,
      sourceRawFindingIds: sortStrings(landing.sourceRawFindingIds),
    }))
    .sort(compareCanonicalJsonValues);
  const reviewerAnomalyLandings = report.reviewerAnomalyLandings
    ?.map((landing) => ({
      ...landing,
      sourceRawFindingIds: sortStrings(landing.sourceRawFindingIds),
    }))
    .sort(compareCanonicalJsonValues);
  const managerTaskAudits = report.managerTaskAudits
    ?.map((audit) => ({
      ...audit,
      ownedIds: sortStrings(audit.ownedIds),
    }))
    .sort((left, right) => (
      compareBinaryStrings(left.taskId, right.taskId)
      || compareCanonicalJsonValues(left, right)
    ));
  return {
    ...report,
    finalErrors: [...report.finalErrors],
    attempts,
    ...(report.rawAdmissionRejections === undefined
      ? {}
      : { rawAdmissionRejections: [...report.rawAdmissionRejections] }),
    ...(report.unsupportedRawFindings === undefined
      ? {}
      : { unsupportedRawFindings: [...report.unsupportedRawFindings] }),
    ...(report.reviewerOutputOverflows === undefined
      ? {}
      : { reviewerOutputOverflows: [...report.reviewerOutputOverflows] }),
    ...(provisionalLandings === undefined ? {} : { provisionalLandings }),
    ...(reviewerAnomalyLandings === undefined ? {} : { reviewerAnomalyLandings }),
    ...(rawNormalizations === undefined ? {} : { rawNormalizations }),
    ...(relationClarifications === undefined ? {} : { relationClarifications }),
    ...(report.rawFindingDispositions === undefined
      ? {}
      : {
          rawFindingDispositions: [...report.rawFindingDispositions].sort((left, right) => (
            compareBinaryStrings(left.rawFindingId, right.rawFindingId)
            || compareCanonicalJsonValues(left, right)
          )),
        }),
    ...(report.interpretationRecoverySettlements === undefined
      ? {}
      : {
          interpretationRecoverySettlements: [
            ...report.interpretationRecoverySettlements,
          ].sort((left, right) => (
            compareBinaryStrings(left.provisionalFindingId, right.provisionalFindingId)
            || compareCanonicalJsonValues(left, right)
          )),
        }),
    ...(managerTaskAudits === undefined ? {} : { managerTaskAudits }),
  };
}

function prettyCanonicalJson(value: unknown): string {
  return canonicalJson(value, 2);
}

export function serializeFindingManagerValidationReport(
  report: FindingManagerValidationReport,
): string {
  return prettyCanonicalJson(canonicalizeReport(report));
}

export function findingManagerValidationReportFileName(
  report: FindingManagerValidationReport,
): string {
  const stepName = report.stepName
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (stepName.length === 0) {
    throw new Error(`Invalid Finding manager report step name: ${report.stepName}`);
  }
  return `findings-manager-validation.${stepName}.json`;
}

export function computeFindingManagerReportPublicationId(input: {
  roundMarker: string;
  originRunId: string;
  fileName: string;
  contentSha256: string;
}): string {
  return createHash('sha256').update([
    input.roundMarker,
    input.originRunId,
    input.fileName,
    input.contentSha256,
  ].join('\0')).digest('hex');
}
