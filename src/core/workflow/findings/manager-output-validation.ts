import type {
  FindingLedger,
  FindingLedgerConflict,
  FindingManagerOutput,
  FindingRecord,
  RawFinding,
} from './types.js';

export type FindingManagerValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

interface ValidateFindingManagerOutputInput {
  previousLedger: FindingLedger;
  rawFindings: RawFinding[];
  managerOutput: FindingManagerOutput;
}

interface ValidationContext {
  previousFindingsById: ReadonlyMap<string, FindingRecord>;
  previousConflictsById: ReadonlyMap<string, FindingLedgerConflict>;
  currentRawFindingIds: ReadonlySet<string>;
  currentRawFindingsById: ReadonlyMap<string, RawFinding>;
  previousRawFindingsById: ReadonlyMap<string, RawFinding>;
}

interface RawFindingDecisionRef {
  decision: string;
  rawFindingId: string;
}

interface FindingDecisionRef {
  decision: string;
  findingId: string;
}

export function validateFindingManagerOutput(
  input: ValidateFindingManagerOutputInput,
): FindingManagerValidationResult {
  const context: ValidationContext = {
    previousFindingsById: new Map(input.previousLedger.findings.map((finding) => [finding.id, finding])),
    previousConflictsById: new Map(input.previousLedger.conflicts.map((conflict) => [conflict.id, conflict])),
    currentRawFindingIds: new Set(input.rawFindings.map((finding) => finding.rawFindingId)),
    currentRawFindingsById: new Map(input.rawFindings.map((finding) => [finding.rawFindingId, finding])),
    previousRawFindingsById: new Map(input.previousLedger.rawFindings.map((finding) => [finding.rawFindingId, finding])),
  };
  const errors = [
    ...validateRawFindingDecisionRefs(input.managerOutput, context),
    ...validateFindingDecisionRefs(input.managerOutput, context),
    ...validateResolvedConflicts(input.managerOutput, context),
  ];

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateRawFindingDecisionRefs(
  managerOutput: FindingManagerOutput,
  context: ValidationContext,
): string[] {
  const decisionRefs = collectRawFindingDecisionRefs(managerOutput);
  const matchErrors = managerOutput.matches.flatMap((match, index) => {
    const decision = `matches[${index}]`;
    const finding = context.previousFindingsById.get(match.findingId);
    return [
      ...validateCurrentRawFindingIds(match.rawFindingIds, decision, context),
      ...(finding === undefined ? [] : validateFindingFamilyTagCompatible(finding, match.rawFindingIds, 'match', decision, context)),
    ];
  });
  const newFindingErrors = managerOutput.newFindings.flatMap((finding, index) => {
    const decision = `newFindings[${index}]`;
    return [
      ...validateCurrentRawFindingIds(finding.rawFindingIds, decision, context),
      ...validateCurrentRawFindingFamilyTags(finding.rawFindingIds, 'create a new finding from', decision, context),
    ];
  });
  const reopenedErrors = managerOutput.reopenedFindings.flatMap((reopened, index) => {
    const decision = `reopenedFindings[${index}]`;
    const finding = context.previousFindingsById.get(reopened.findingId);
    return [
      ...validateCurrentRawFindingIds(reopened.rawFindingIds, decision, context),
      ...(finding === undefined ? [] : validateFindingFamilyTagCompatible(finding, reopened.rawFindingIds, 'reopen', decision, context)),
    ];
  });
  const conflictErrors = managerOutput.conflicts.flatMap((conflict, index) => {
    const decision = `conflicts[${index}]`;
    return [
      ...(conflict.findingIds.length === 0 && conflict.rawFindingIds.length === 0
        ? [`${decision} must reference at least one finding id or current raw finding id`]
        : []),
      ...(conflict.rawFindingIds.length > 0
        ? validateCurrentRawFindingIds(conflict.rawFindingIds, decision, context)
        : []),
    ];
  });

  return [
    ...matchErrors,
    ...newFindingErrors,
    ...reopenedErrors,
    ...conflictErrors,
    ...validateDuplicateRawFindingDecisionRefs(decisionRefs),
  ];
}

function collectRawFindingDecisionRefs(managerOutput: FindingManagerOutput): RawFindingDecisionRef[] {
  return [
    ...managerOutput.matches.flatMap((match, index) => rawFindingDecisionRefs(`matches[${index}]`, match.rawFindingIds)),
    ...managerOutput.newFindings.flatMap((finding, index) => rawFindingDecisionRefs(`newFindings[${index}]`, finding.rawFindingIds)),
    ...managerOutput.resolvedFindings.flatMap((resolved, index) => rawFindingDecisionRefs(`resolvedFindings[${index}]`, resolved.rawFindingIds)),
    ...managerOutput.reopenedFindings.flatMap((reopened, index) => rawFindingDecisionRefs(`reopenedFindings[${index}]`, reopened.rawFindingIds)),
    ...managerOutput.conflicts.flatMap((conflict, index) => rawFindingDecisionRefs(`conflicts[${index}]`, conflict.rawFindingIds)),
  ];
}

function rawFindingDecisionRefs(decision: string, rawFindingIds: readonly string[]): RawFindingDecisionRef[] {
  return Array.from(new Set(rawFindingIds)).map((rawFindingId) => ({ decision, rawFindingId }));
}

function validateDuplicateRawFindingDecisionRefs(refs: readonly RawFindingDecisionRef[]): string[] {
  return refs.flatMap((ref, index) => {
    const previousRef = refs.slice(0, index).find((candidate) => (
      candidate.rawFindingId === ref.rawFindingId && candidate.decision !== ref.decision
    ));
    return previousRef === undefined
      ? []
      : [`Raw finding id "${ref.rawFindingId}" appears in multiple manager decisions: ${previousRef.decision} and ${ref.decision}`];
  });
}

function validateCurrentRawFindingIds(
  rawFindingIds: readonly string[],
  decision: string,
  context: ValidationContext,
): string[] {
  if (rawFindingIds.length === 0) {
    return [`${decision} must reference at least one current raw finding id`];
  }

  return [
    ...rawFindingIds.flatMap((rawFindingId, index) => (
      rawFindingIds.indexOf(rawFindingId) === index
        ? []
        : [`Duplicate raw finding id "${rawFindingId}" in ${decision}`]
    )),
    ...Array.from(new Set(rawFindingIds))
      .filter((rawFindingId) => !context.currentRawFindingIds.has(rawFindingId))
      .map((rawFindingId) => `Unknown raw finding id "${rawFindingId}" in ${decision}`),
  ];
}

function getCurrentRawFindings(
  rawFindingIds: readonly string[],
  context: ValidationContext,
): RawFinding[] {
  return rawFindingIds
    .map((rawFindingId) => context.currentRawFindingsById.get(rawFindingId))
    .filter((rawFinding): rawFinding is RawFinding => rawFinding !== undefined);
}

function validateCurrentRawFindingFamilyTags(
  rawFindingIds: readonly string[],
  action: string,
  decision: string,
  context: ValidationContext,
): string[] {
  const rawFindings = getCurrentRawFindings(rawFindingIds, context);
  const [primary, ...rest] = rawFindings;
  if (primary === undefined) {
    return [];
  }

  return rest
    .filter((rawFinding) => rawFinding.familyTag !== primary.familyTag)
    .map((rawFinding) => (
      `Cannot ${action} raw findings with different familyTag values: "${primary.familyTag}" and "${rawFinding.familyTag}" (${decision})`
    ));
}

function validateFindingFamilyTagCompatible(
  finding: FindingRecord,
  currentRawFindingIds: readonly string[],
  action: string,
  decision: string,
  context: ValidationContext,
): string[] {
  const missingPreviousRawFindingErrors = finding.rawFindingIds
    .filter((rawFindingId) => !context.previousRawFindingsById.has(rawFindingId))
    .map((rawFindingId) => `Finding "${finding.id}" references previous raw finding "${rawFindingId}" that is not in the ledger`);
  const previousRawFindings = finding.rawFindingIds
    .map((rawFindingId) => context.previousRawFindingsById.get(rawFindingId))
    .filter((rawFinding): rawFinding is RawFinding => rawFinding !== undefined);
  const currentRawFindings = getCurrentRawFindings(currentRawFindingIds, context);
  const [primary, ...rest] = [...previousRawFindings, ...currentRawFindings];
  if (primary === undefined) {
    return missingPreviousRawFindingErrors;
  }

  return [
    ...missingPreviousRawFindingErrors,
    ...rest
      .filter((rawFinding) => rawFinding.familyTag !== primary.familyTag)
      .map((rawFinding) => (
        `Cannot ${action} raw findings with different familyTag values: "${primary.familyTag}" and "${rawFinding.familyTag}" (${decision}, finding "${finding.id}")`
      )),
  ];
}

function validateFindingDecisionRefs(
  managerOutput: FindingManagerOutput,
  context: ValidationContext,
): string[] {
  const decisionRefs = collectFindingDecisionRefs(managerOutput);
  const matchErrors = managerOutput.matches.flatMap((match, index) => (
    validateFindingDecision(match.findingId, `matches[${index}]`, 'match', 'open', context)
  ));
  const resolvedErrors = managerOutput.resolvedFindings.flatMap((resolved, index) => {
    const decision = `resolvedFindings[${index}]`;
    const finding = context.previousFindingsById.get(resolved.findingId);
    return [
      ...validateFindingDecision(resolved.findingId, decision, 'resolve', 'open', context),
      ...(finding === undefined ? [] : validateResolvedFindingRawFindingIds(finding, resolved.rawFindingIds, context)),
    ];
  });
  const reopenedErrors = managerOutput.reopenedFindings.flatMap((reopened, index) => (
    validateFindingDecision(reopened.findingId, `reopenedFindings[${index}]`, 'reopen', 'resolved', context)
  ));
  const conflictErrors = managerOutput.conflicts.flatMap((conflict, index) => (
    validateConflictFindingIds(conflict.findingIds, `conflicts[${index}]`, context)
  ));

  return [
    ...matchErrors,
    ...resolvedErrors,
    ...reopenedErrors,
    ...conflictErrors,
    ...validateDuplicateFindingDecisionRefs(decisionRefs),
  ];
}

function collectFindingDecisionRefs(managerOutput: FindingManagerOutput): FindingDecisionRef[] {
  return [
    ...managerOutput.matches.map((match, index) => ({ decision: `matches[${index}]`, findingId: match.findingId })),
    ...managerOutput.resolvedFindings.map((resolved, index) => ({
      decision: `resolvedFindings[${index}]`,
      findingId: resolved.findingId,
    })),
    ...managerOutput.reopenedFindings.map((reopened, index) => ({
      decision: `reopenedFindings[${index}]`,
      findingId: reopened.findingId,
    })),
    ...managerOutput.conflicts.flatMap((conflict, index) => (
      Array.from(new Set(conflict.findingIds)).map((findingId) => ({ decision: `conflicts[${index}]`, findingId }))
    )),
  ];
}

function validateDuplicateFindingDecisionRefs(refs: readonly FindingDecisionRef[]): string[] {
  return refs.flatMap((ref, index) => {
    const previousRef = refs.slice(0, index).find((candidate) => (
      candidate.findingId === ref.findingId && candidate.decision !== ref.decision
    ));
    return previousRef === undefined
      ? []
      : [`Finding id "${ref.findingId}" appears in multiple manager decisions: ${previousRef.decision} and ${ref.decision}`];
  });
}

function validateFindingDecision(
  findingId: string,
  decision: string,
  action: string,
  expectedStatus: FindingRecord['status'],
  context: ValidationContext,
): string[] {
  const finding = context.previousFindingsById.get(findingId);
  if (finding === undefined) {
    return [`Unknown finding id "${findingId}" in ${decision}`];
  }
  return finding.status === expectedStatus
    ? []
    : [`Cannot ${action} finding "${findingId}" because it is not ${expectedStatus}`];
}

function validateConflictFindingIds(
  findingIds: readonly string[],
  decision: string,
  context: ValidationContext,
): string[] {
  return findingIds.flatMap((findingId, index) => {
    if (findingIds.indexOf(findingId) !== index) {
      return [`Duplicate finding id "${findingId}" in ${decision}`];
    }
    return context.previousFindingsById.has(findingId)
      ? []
      : [`Unknown finding id "${findingId}" in ${decision}`];
  });
}

function validateResolvedFindingRawFindingIds(
  finding: FindingRecord,
  rawFindingIds: readonly string[],
  context: ValidationContext,
): string[] {
  if (rawFindingIds.length === 0) {
    return [`Resolved finding "${finding.id}" must reference at least one previous raw finding id`];
  }
  const findingRawFindingIds = new Set(finding.rawFindingIds);
  return rawFindingIds.flatMap((rawFindingId, index) => {
    if (rawFindingIds.indexOf(rawFindingId) !== index) {
      return [`Duplicate raw finding id "${rawFindingId}" in resolvedFindings for "${finding.id}"`];
    }
    if (!findingRawFindingIds.has(rawFindingId)) {
      return [`Resolved finding "${finding.id}" references raw finding id "${rawFindingId}" that does not belong to the finding`];
    }
    return context.previousRawFindingsById.has(rawFindingId)
      ? []
      : [`Resolved finding "${finding.id}" references previous raw finding "${rawFindingId}" that is not in the ledger`];
  });
}

function validateResolvedConflicts(
  managerOutput: FindingManagerOutput,
  context: ValidationContext,
): string[] {
  return managerOutput.resolvedConflicts.flatMap((resolvedConflict, index) => {
    const decision = `resolvedConflicts[${index}]`;
    if (managerOutput.resolvedConflicts.findIndex((candidate) => (
      candidate.conflictId === resolvedConflict.conflictId
    )) !== index) {
      return [`Duplicate conflict id "${resolvedConflict.conflictId}" in ${decision}`];
    }
    const conflict = context.previousConflictsById.get(resolvedConflict.conflictId);
    if (conflict === undefined) {
      return [`Unknown conflict id "${resolvedConflict.conflictId}" in ${decision}`];
    }
    return conflict.status === 'active'
      ? []
      : [`Cannot resolve conflict "${conflict.id}" because it is not active`];
  });
}
