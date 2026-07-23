import type {
  FindingContractFixCoverage,
  FindingContractTeamLeaderDecision,
  PartDefinition,
} from '../models/types.js';
import { ensureUniquePartIds, PartDefinitionValidationError } from './part-definition-validator.js';
import {
  collectFindingContractPartBatchValidationIssues,
  parseFindingContractPartDefinition,
} from './team-leader-finding-contract.js';
import type { FindingContractDecisionEvidenceSnapshot } from './team-leader-finding-contract-evidence.js';
import {
  FindingContractInputValidationError,
  requireBoundedString,
  requireExactKeys,
  requireNonEmptyString,
  requireObject,
  requireStringArray,
} from './team-leader-finding-contract-validation.js';
import {
  createFindingContractDecisionValidationIssue,
  createFindingContractTeamLeaderDecisionValidationError,
  type FindingContractDecisionValidationCategory,
  type FindingContractDecisionValidationIssue,
} from './team-leader-finding-contract-decision-validation.js';

export {
  FindingContractTeamLeaderDecisionValidationError,
  type FindingContractDecisionValidationIssue,
} from './team-leader-finding-contract-decision-validation.js';

interface ValidationIssueDescriptor {
  code: string;
  category: FindingContractDecisionValidationCategory;
  path: string;
  findingId?: string;
  partId?: string;
}

export interface FindingContractDecisionValidationContext {
  readonly targetFindingIds: readonly string[];
  readonly plannedParts: readonly PartDefinition[];
  readonly evidence: FindingContractDecisionEvidenceSnapshot;
}

function captureValidation<T>(
  issues: FindingContractDecisionValidationIssue[],
  descriptor: ValidationIssueDescriptor,
  operation: () => T,
): T | undefined {
  try {
    return operation();
  } catch (error) {
    if (
      !(error instanceof FindingContractInputValidationError)
      && !(error instanceof PartDefinitionValidationError)
    ) {
      throw error;
    }
    issues.push(createFindingContractDecisionValidationIssue({
      ...descriptor,
      message: error.message,
    }));
    return undefined;
  }
}

function addValidationIssue(
  issues: FindingContractDecisionValidationIssue[],
  descriptor: ValidationIssueDescriptor,
  message: string,
): void {
  issues.push(createFindingContractDecisionValidationIssue({
    ...descriptor,
    message,
  }));
}

function parseFixCoverage(
  raw: unknown,
  targetFindingIds: readonly string[],
  existingIds: readonly string[],
  plannedParts: readonly PartDefinition[],
  issues: FindingContractDecisionValidationIssue[],
): FindingContractFixCoverage[] {
  if (!Array.isArray(raw)) {
    addValidationIssue(
      issues,
      { code: 'shape.fix_coverage_array', category: 'shape', path: 'fixCoverage' },
      'Finding Contract fixCoverage must be an array',
    );
    return [];
  }
  const targetIds = new Set(targetFindingIds);
  const partIds = new Set(existingIds);
  const plannedPartsById = new Map(plannedParts.map((part) => [part.id, part]));
  const seen = new Set<string>();
  const coverage: FindingContractFixCoverage[] = [];

  for (const [index, entry] of raw.entries()) {
    const item = captureValidation(
      issues,
      { code: 'shape.fix_coverage_entry', category: 'shape', path: `fixCoverage[${index}]` },
      () => requireObject(entry, `fixCoverage[${index}]`),
    );
    if (item === undefined) continue;
    captureValidation(
      issues,
      { code: 'shape.fix_coverage_keys', category: 'shape', path: `fixCoverage[${index}]` },
      () => requireExactKeys(item, `fixCoverage[${index}]`, [
        'findingId', 'disposition', 'supportingPartIds', 'verificationPartIds',
      ]),
    );
    const findingId = captureValidation(
      issues,
      { code: 'shape.finding_id', category: 'shape', path: `fixCoverage[${index}].findingId` },
      () => requireNonEmptyString(item.findingId, `fixCoverage[${index}].findingId`),
    );
    const disposition = captureValidation(
      issues,
      {
        code: 'decision_contract.disposition',
        category: 'decision_contract',
        path: `fixCoverage[${index}].disposition`,
        ...(findingId === undefined ? {} : { findingId }),
      },
      () => requireNonEmptyString(item.disposition, `fixCoverage[${index}].disposition`),
    );
    const supportingPartIds = captureValidation(
      issues,
      {
        code: 'shape.supporting_part_ids',
        category: 'shape',
        path: `fixCoverage[${index}].supportingPartIds`,
        ...(findingId === undefined ? {} : { findingId }),
      },
      () => requireStringArray(
        item.supportingPartIds,
        `fixCoverage[${index}].supportingPartIds`,
        { nonEmpty: true },
      ),
    );
    const verificationPartIds = captureValidation(
      issues,
      {
        code: 'shape.verification_part_ids',
        category: 'shape',
        path: `fixCoverage[${index}].verificationPartIds`,
        ...(findingId === undefined ? {} : { findingId }),
      },
      () => requireStringArray(
        item.verificationPartIds,
        `fixCoverage[${index}].verificationPartIds`,
      ),
    );

    if (findingId !== undefined) {
      if (!targetIds.has(findingId)) {
        addValidationIssue(
          issues,
          {
            code: 'reference.unknown_finding',
            category: 'reference',
            path: `fixCoverage.finding:${findingId}`,
            findingId,
          },
          `fixCoverage references unknown finding "${findingId}"`,
        );
      } else if (seen.has(findingId)) {
        addValidationIssue(
          issues,
          {
            code: 'decision_contract.duplicate_finding',
            category: 'decision_contract',
            path: `fixCoverage.finding:${findingId}`,
            findingId,
          },
          `fixCoverage contains duplicate finding "${findingId}"`,
        );
      }
      seen.add(findingId);
    }
    if (disposition !== undefined && disposition !== 'addressed' && disposition !== 'disputed') {
      addValidationIssue(
        issues,
        {
          code: 'decision_contract.invalid_disposition',
          category: 'decision_contract',
          path: `fixCoverage.disposition:${findingId ?? index}`,
          ...(findingId === undefined ? {} : { findingId }),
        },
        `fixCoverage[${index}].disposition is invalid: ${disposition}`,
      );
    }
    if (findingId !== undefined) {
      for (const partId of [...(supportingPartIds ?? []), ...(verificationPartIds ?? [])]) {
        if (!partIds.has(partId)) {
          addValidationIssue(
            issues,
            {
              code: 'reference.unknown_part',
              category: 'reference',
              path: `fixCoverage.finding:${findingId}.part:${partId}`,
              findingId,
              partId,
            },
            `fixCoverage references unknown part "${partId}"`,
          );
          continue;
        }
        const assignment = plannedPartsById.get(partId)?.findingContract;
        if (assignment === undefined || !assignment.findingIds.includes(findingId)) {
          addValidationIssue(
            issues,
            {
              code: 'reference.cross_assigned_part',
              category: 'reference',
              path: `fixCoverage.finding:${findingId}.part:${partId}`,
              findingId,
              partId,
            },
            `fixCoverage part "${partId}" is not assigned to finding "${findingId}"`,
          );
        }
      }
    }
    if (
      findingId !== undefined
      && targetIds.has(findingId)
      && (disposition === 'addressed' || disposition === 'disputed')
      && supportingPartIds !== undefined
      && verificationPartIds !== undefined
    ) {
      coverage.push({
        findingId,
        disposition,
        supportingPartIds,
        verificationPartIds,
      });
    }
  }
  for (const findingId of targetIds) {
    if (!seen.has(findingId)) {
      addValidationIssue(
        issues,
        {
          code: 'decision_contract.missing_finding_coverage',
          category: 'decision_contract',
          path: `fixCoverage.finding:${findingId}`,
          findingId,
        },
        `fixCoverage does not cover actionable finding "${findingId}"`,
      );
    }
  }
  return coverage;
}

export function parseFindingContractTeamLeaderDecision(
  raw: unknown,
  context: FindingContractDecisionValidationContext,
): FindingContractTeamLeaderDecision {
  const targetFindingIds = context.targetFindingIds;
  const previouslyPlannedParts = context.plannedParts;
  const existingIds = previouslyPlannedParts.map((part) => part.id);
  const issues: FindingContractDecisionValidationIssue[] = [];
  const payload = captureValidation(
    issues,
    { code: 'shape.root', category: 'shape', path: '$' },
    () => requireObject(raw, 'Finding Contract Team Leader feedback'),
  );
  if (payload === undefined) {
    throw createFindingContractTeamLeaderDecisionValidationError(raw, issues);
  }
  captureValidation(
    issues,
    { code: 'shape.root_keys', category: 'shape', path: '$' },
    () => requireExactKeys(payload, 'Finding Contract Team Leader feedback', [
      'decision', 'reasoning', 'parts', 'fixCoverage', 'blockers',
    ]),
  );
  const decision = captureValidation(
    issues,
    { code: 'shape.decision', category: 'shape', path: 'decision' },
    () => requireNonEmptyString(payload.decision, 'Finding Contract Team Leader decision'),
  );
  const reasoning = captureValidation(
    issues,
    { code: 'shape.reasoning', category: 'shape', path: 'reasoning' },
    () => requireBoundedString(payload.reasoning, 'Finding Contract Team Leader reasoning', 4000),
  );
  const rawParts = Array.isArray(payload.parts) ? payload.parts : undefined;
  if (rawParts === undefined) {
    addValidationIssue(
      issues,
      { code: 'shape.parts_array', category: 'shape', path: 'parts' },
      'Finding Contract Team Leader parts must be an array',
    );
  }
  const rawFixCoverage = Array.isArray(payload.fixCoverage) ? payload.fixCoverage : undefined;
  if (rawFixCoverage === undefined) {
    addValidationIssue(
      issues,
      { code: 'shape.fix_coverage_array', category: 'shape', path: 'fixCoverage' },
      'Finding Contract Team Leader fixCoverage must be an array',
    );
  }
  const parts = (rawParts ?? []).flatMap((entry, index) => {
    const part = captureValidation(
      issues,
      { code: 'shape.part', category: 'shape', path: `parts[${index}]` },
      () => parseFindingContractPartDefinition(entry, index),
    );
    return part === undefined ? [] : [part];
  });
  if (parts.length === (rawParts?.length ?? 0)) {
    captureValidation(
      issues,
      { code: 'decision_contract.duplicate_part_id', category: 'decision_contract', path: 'parts' },
      () => ensureUniquePartIds(parts),
    );
  }
  const blockers = captureValidation(
    issues,
    { code: 'shape.blockers', category: 'shape', path: 'blockers' },
    () => requireStringArray(
      payload.blockers,
      'Finding Contract Team Leader blockers',
      { maxItems: 20, maxItemLength: 1000 },
    ),
  );

  let fixCoverage: FindingContractFixCoverage[] = [];
  if (decision === 'continue') {
    if (parts.length === 0 && rawParts !== undefined) {
      addValidationIssue(
        issues,
        { code: 'decision_contract.continue_parts', category: 'decision_contract', path: 'parts' },
        'Finding Contract Team Leader continue decision requires at least one part',
      );
    }
    if ((blockers?.length ?? 0) > 0) {
      addValidationIssue(
        issues,
        { code: 'decision_contract.continue_blockers', category: 'decision_contract', path: 'blockers' },
        'Finding Contract Team Leader continue decision must not include blockers',
      );
    }
    if ((rawFixCoverage?.length ?? 0) > 0) {
      addValidationIssue(
        issues,
        { code: 'decision_contract.continue_fix_coverage', category: 'decision_contract', path: 'fixCoverage' },
        'Finding Contract Team Leader continue decision must not include fixCoverage',
      );
    }
    if (parts.length === (rawParts?.length ?? 0)) {
      for (const issue of collectFindingContractPartBatchValidationIssues(parts, targetFindingIds)) {
        addValidationIssue(
          issues,
          {
            code: issue.code === 'unknown_finding'
              ? 'reference.unknown_finding'
              : `decision_contract.part_batch.${issue.code}`,
            category: issue.code === 'unknown_finding' ? 'reference' : 'decision_contract',
            path: issue.partId === undefined ? 'parts' : `parts.id:${issue.partId}`,
            ...(issue.findingId === undefined ? {} : { findingId: issue.findingId }),
            ...(issue.partId === undefined ? {} : { partId: issue.partId }),
          },
          issue.message,
        );
      }
      for (const reusedPart of parts.filter((part) => existingIds.includes(part.id))) {
        addValidationIssue(
          issues,
          {
            code: 'reference.reused_part_id',
            category: 'reference',
            path: `parts.id:${reusedPart.id}`,
            partId: reusedPart.id,
          },
          `Finding Contract Team Leader continue decision reuses existing part ID "${reusedPart.id}"`,
        );
      }
    }
  } else if (decision === 'complete') {
    if (parts.length > 0) {
      addValidationIssue(
        issues,
        { code: 'decision_contract.complete_parts', category: 'decision_contract', path: 'parts' },
        'Finding Contract Team Leader complete decision must not include parts',
      );
    }
    if ((blockers?.length ?? 0) > 0) {
      addValidationIssue(
        issues,
        { code: 'decision_contract.complete_blockers', category: 'decision_contract', path: 'blockers' },
        'Finding Contract Team Leader complete decision must not include blockers',
      );
    }
    fixCoverage = rawFixCoverage === undefined
      ? []
      : parseFixCoverage(
          rawFixCoverage,
          targetFindingIds,
          existingIds,
          previouslyPlannedParts,
          issues,
        );
    collectCompletionEvidenceIssues(fixCoverage, context.evidence, issues);
  } else if (decision === 'replan') {
    if (parts.length > 0) {
      addValidationIssue(
        issues,
        { code: 'decision_contract.replan_parts', category: 'decision_contract', path: 'parts' },
        'Finding Contract Team Leader replan decision must not include parts',
      );
    }
    if (blockers !== undefined && blockers.length === 0) {
      addValidationIssue(
        issues,
        { code: 'decision_contract.replan_blockers', category: 'decision_contract', path: 'blockers' },
        'Finding Contract Team Leader replan decision requires blockers',
      );
    }
    if ((rawFixCoverage?.length ?? 0) > 0) {
      addValidationIssue(
        issues,
        { code: 'decision_contract.replan_fix_coverage', category: 'decision_contract', path: 'fixCoverage' },
        'Finding Contract Team Leader replan decision must not include fixCoverage',
      );
    }
  } else if (decision !== undefined) {
    addValidationIssue(
      issues,
      { code: 'decision_contract.invalid_decision', category: 'decision_contract', path: 'decision' },
      `Finding Contract Team Leader decision is invalid: ${decision}`,
    );
  }

  if (issues.length > 0) {
    throw createFindingContractTeamLeaderDecisionValidationError(raw, issues);
  }
  if (decision === undefined || reasoning === undefined || blockers === undefined) {
    throw new Error('Finding Contract Team Leader decision validation completed without required values');
  }
  if (decision === 'continue') {
    return { decision, reasoning, parts };
  }
  if (decision === 'complete') {
    return { decision, reasoning, parts: [], fixCoverage };
  }
  if (decision === 'replan') {
    return { decision, reasoning, parts: [], blockers };
  }
  throw new Error(`Unsupported Finding Contract Team Leader decision after validation: ${decision}`);
}

function collectCompletionEvidenceIssues(
  fixCoverage: readonly FindingContractFixCoverage[],
  evidence: FindingContractDecisionEvidenceSnapshot,
  issues: FindingContractDecisionValidationIssue[],
): void {
  for (const coverage of fixCoverage) {
    const evidencePartIds = [...new Set([
      ...coverage.supportingPartIds,
      ...coverage.verificationPartIds,
    ])];
    const evidenceEntries = evidencePartIds.flatMap((partId) => {
      const entry = evidence.entries.find((candidate) => (
        candidate.findingId === coverage.findingId && candidate.partId === partId
      ));
      return entry === undefined ? [] : [entry];
    });
    for (const entry of evidenceEntries.filter((candidate) => candidate.claimValidationError !== undefined)) {
      addValidationIssue(
        issues,
        {
          code: 'evidence.invalid_part_claim',
          category: 'evidence',
          path: `part:${entry.partId}.claim`,
          findingId: coverage.findingId,
          partId: entry.partId,
        },
        entry.claimValidationError ?? `Part "${entry.partId}" has an invalid completion claim`,
      );
    }
    const findingEvidence = evidence.findings.find((candidate) => candidate.findingId === coverage.findingId);
    const eligibleSupportingPartIds = findingEvidence?.eligibleSupportingPartIds[coverage.disposition] ?? [];
    for (const partId of coverage.supportingPartIds) {
      if (!eligibleSupportingPartIds.includes(partId)) {
        const entry = evidenceEntries.find((candidate) => candidate.partId === partId);
        addValidationIssue(
          issues,
          {
            code: 'evidence.unsupported_disposition',
            category: 'evidence',
            path: `fixCoverage.finding:${coverage.findingId}.support:${partId}`,
            findingId: coverage.findingId,
            partId,
          },
          `fixCoverage support part "${partId}" is not eligible for disposition `
            + `"${coverage.disposition}"${formatEvidenceReasons(entry?.supportIneligibleReasons)}`,
        );
      }
    }
    for (const partId of coverage.verificationPartIds) {
      if (findingEvidence?.eligibleVerificationPartIds.includes(partId) !== true) {
        const entry = evidenceEntries.find((candidate) => candidate.partId === partId);
        addValidationIssue(
          issues,
          {
            code: 'evidence.ineligible_verification',
            category: 'evidence',
            path: `fixCoverage.finding:${coverage.findingId}.verification:${partId}`,
            findingId: coverage.findingId,
            partId,
          },
          `fixCoverage verification part "${partId}" is not eligible`
            + formatEvidenceReasons(entry?.verificationIneligibleReasons),
        );
      }
    }
    for (const entry of evidenceEntries.filter((candidate) => candidate.failedChecks > 0)) {
      addValidationIssue(
        issues,
        {
          code: 'evidence.failed_check',
          category: 'evidence',
          path: `fixCoverage.finding:${coverage.findingId}.part:${entry.partId}`,
          findingId: coverage.findingId,
          partId: entry.partId,
        },
        `fixCoverage evidence part "${entry.partId}" contains a failed check`,
      );
    }
    const hasEligibleVerification = evidencePartIds.some((partId) => (
      findingEvidence?.eligibleVerificationPartIds.includes(partId) === true
    ));
    if (!hasEligibleVerification) {
      addValidationIssue(
        issues,
        {
          code: 'evidence.missing_passed_verification',
          category: 'evidence',
          path: `fixCoverage.finding:${coverage.findingId}.verification`,
          findingId: coverage.findingId,
        },
        `fixCoverage for finding "${coverage.findingId}" has no passed verification check`,
      );
    }
  }
}

function formatEvidenceReasons(reasons: readonly string[] | undefined): string {
  return reasons === undefined || reasons.length === 0 ? '' : ` (${reasons.join(', ')})`;
}
