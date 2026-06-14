import { createHash } from 'node:crypto';
import type {
  FindingLedger,
  FindingLedgerConflict,
  FindingManagerOutput,
  FindingObservation,
  FindingReconcileContext,
  FindingRecord,
  RawFinding,
} from './types.js';
import { assertLedgerIdAllocationInvariant } from './ledger-validation.js';

interface ReconcileFindingLedgerInput {
  previousLedger: FindingLedger;
  rawFindings: RawFinding[];
  managerOutput: FindingManagerOutput;
  context: FindingReconcileContext;
}

function formatFindingId(nextId: number): string {
  return `F-${String(nextId).padStart(4, '0')}`;
}

function formatConflictId(conflict: { findingIds: readonly string[]; rawFindingIds: readonly string[] }): string {
  const ids = conflict.findingIds.length > 0 ? conflict.findingIds : conflict.rawFindingIds;
  const signature = [...ids].sort().join('\0');
  const hash = createHash('sha256').update(signature).digest('hex').slice(0, 12).toUpperCase();
  return `C-${hash}`;
}

function assertKnownFinding(findingIds: Set<string>, findingId: string): void {
  if (!findingIds.has(findingId)) {
    throw new Error(`Unknown finding id "${findingId}"`);
  }
}

function assertKnownConflict(conflictsById: ReadonlyMap<string, FindingLedgerConflict>, conflictId: string): void {
  if (!conflictsById.has(conflictId)) {
    throw new Error(`Unknown conflict id "${conflictId}"`);
  }
}

function assertKnownRawFindings(rawFindingIds: Set<string>, referencedIds: readonly string[]): void {
  if (referencedIds.length === 0) {
    throw new Error('Manager output must reference at least one raw finding id');
  }
  assertUniqueIds(referencedIds, 'raw finding id');
  for (const rawFindingId of referencedIds) {
    if (!rawFindingIds.has(rawFindingId)) {
      throw new Error(`Unknown raw finding id "${rawFindingId}"`);
    }
  }
}

function assertUniqueIds(ids: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`Duplicate ${label} "${id}"`);
    }
    seen.add(id);
  }
}

function assertFindingStatus(finding: FindingRecord, expectedStatus: FindingRecord['status'], action: string): void {
  if (finding.status !== expectedStatus) {
    throw new Error(`Cannot ${action} finding "${finding.id}" because it is not ${expectedStatus}`);
  }
}

function markRawFindingIdsUsed(usedRawFindingIds: Set<string>, rawFindingIds: readonly string[]): void {
  for (const rawFindingId of rawFindingIds) {
    if (usedRawFindingIds.has(rawFindingId)) {
      throw new Error(`Raw finding id "${rawFindingId}" is referenced by multiple manager decisions`);
    }
    usedRawFindingIds.add(rawFindingId);
  }
}

function markFindingIdDecision(
  usedFindingDecisions: Map<string, string>,
  findingId: string,
  decision: string,
): void {
  const previousDecision = usedFindingDecisions.get(findingId);
  if (previousDecision !== undefined) {
    throw new Error(
      `Finding id "${findingId}" appears in multiple manager decisions: ${previousDecision} and ${decision}`,
    );
  }
  usedFindingDecisions.set(findingId, decision);
}

function assertFindingIdsHaveSingleDecision(managerOutput: FindingManagerOutput): void {
  const usedFindingDecisions = new Map<string, string>();
  for (const match of managerOutput.matches) {
    markFindingIdDecision(usedFindingDecisions, match.findingId, 'match');
  }
  for (const resolved of managerOutput.resolvedFindings) {
    markFindingIdDecision(usedFindingDecisions, resolved.findingId, 'resolve');
  }
  for (const reopened of managerOutput.reopenedFindings) {
    markFindingIdDecision(usedFindingDecisions, reopened.findingId, 'reopen');
  }
  for (const conflict of managerOutput.conflicts) {
    assertUniqueIds(conflict.findingIds, 'finding id');
    for (const findingId of conflict.findingIds) {
      markFindingIdDecision(usedFindingDecisions, findingId, 'conflict');
    }
  }
}

function assertNonEmptyIds(ids: readonly string[], label: string): void {
  if (ids.length === 0) {
    throw new Error(`Manager output must reference at least one ${label}`);
  }
}

function mergeRawFindingIds(current: readonly string[], next: readonly string[]): string[] {
  return Array.from(new Set([...current, ...next]));
}

function mergeReviewers(current: readonly string[], rawFindings: readonly RawFinding[]): string[] {
  return Array.from(new Set([...current, ...rawFindings.map((finding) => finding.reviewer)]));
}

function mergeRawFindingDetails(current: readonly RawFinding[], next: readonly RawFinding[]): RawFinding[] {
  const byId = new Map<string, RawFinding>();
  for (const rawFinding of current) {
    byId.set(rawFinding.rawFindingId, rawFinding);
  }
  for (const rawFinding of next) {
    byId.set(rawFinding.rawFindingId, rawFinding);
  }
  return [...byId.values()];
}

function assertResolvedEvidenceRawFindings(input: {
  finding: FindingRecord;
  resolvedRawFindingIds: readonly string[];
  previousRawFindingsById: ReadonlyMap<string, RawFinding>;
}): void {
  assertKnownRawFindings(new Set(input.finding.rawFindingIds), input.resolvedRawFindingIds);
  for (const rawFindingId of input.resolvedRawFindingIds) {
    const rawFinding = input.previousRawFindingsById.get(rawFindingId);
    if (rawFinding === undefined) {
      throw new Error(
        `Resolved finding "${input.finding.id}" references previous raw finding "${rawFindingId}" that is not in the ledger`,
      );
    }
  }
}

function getRawFinding(rawFindings: readonly RawFinding[], rawFindingIds: readonly string[]): RawFinding {
  const rawFinding = rawFindings.find((finding) => rawFindingIds.includes(finding.rawFindingId));
  if (rawFinding === undefined) {
    throw new Error(`Raw finding ids were validated but not found: ${rawFindingIds.join(', ')}`);
  }
  return rawFinding;
}

function getRawFindings(rawFindings: readonly RawFinding[], rawFindingIds: readonly string[]): RawFinding[] {
  return rawFindingIds.map((rawFindingId) => {
    const rawFinding = rawFindings.find((finding) => finding.rawFindingId === rawFindingId);
    if (rawFinding === undefined) {
      throw new Error(`Raw finding id was validated but not found: ${rawFindingId}`);
    }
    return rawFinding;
  });
}

function assertSameFamilyTag(rawFindings: readonly RawFinding[], action: string): void {
  const [primary, ...rest] = rawFindings;
  if (primary === undefined) {
    throw new Error('At least one raw finding is required to validate familyTag');
  }

  for (const rawFinding of rest) {
    if (rawFinding.familyTag !== primary.familyTag) {
      throw new Error(
        `Cannot ${action} raw findings with different familyTag values: "${primary.familyTag}" and "${rawFinding.familyTag}"`,
      );
    }
  }
}

function getPreviousRawFindingsForFinding(input: {
  finding: FindingRecord;
  previousRawFindingsById: ReadonlyMap<string, RawFinding>;
}): RawFinding[] {
  return input.finding.rawFindingIds.map((rawFindingId) => {
    const rawFinding = input.previousRawFindingsById.get(rawFindingId);
    if (rawFinding === undefined) {
      throw new Error(
        `Finding "${input.finding.id}" references previous raw finding "${rawFindingId}" that is not in the ledger`,
      );
    }
    return rawFinding;
  });
}

function assertFindingFamilyTagCompatible(input: {
  finding: FindingRecord;
  previousRawFindingsById: ReadonlyMap<string, RawFinding>;
  currentRawFindings: readonly RawFinding[];
  action: string;
}): void {
  const previousRawFindings = getPreviousRawFindingsForFinding({
    finding: input.finding,
    previousRawFindingsById: input.previousRawFindingsById,
  });
  assertSameFamilyTag([...previousRawFindings, ...input.currentRawFindings], input.action);
}

function rawEvidenceFields(rawFindings: readonly RawFinding[]): Pick<FindingRecord, 'location' | 'description' | 'suggestion' | 'reviewers'> {
  const primary = rawFindings[0];
  if (primary === undefined) {
    throw new Error('At least one raw finding is required to build finding evidence');
  }
  return {
    ...(primary.location !== undefined ? { location: primary.location } : {}),
    description: primary.description,
    ...(primary.suggestion !== undefined ? { suggestion: primary.suggestion } : {}),
    reviewers: Array.from(new Set(rawFindings.map((finding) => finding.reviewer))),
  };
}

function buildNewFinding(input: {
  id: string;
  rawFindingIds: string[];
  title: string;
  severity: FindingRecord['severity'];
  rawFindings: RawFinding[];
  firstSeenStepName: string;
  context: FindingReconcileContext;
}): FindingRecord {
  const observation = {
    runId: input.context.runId,
    stepName: input.firstSeenStepName,
    timestamp: input.context.timestamp,
  };
  return {
    id: input.id,
    status: 'open',
    lifecycle: 'new',
    severity: input.severity,
    title: input.title,
    ...rawEvidenceFields(input.rawFindings),
    rawFindingIds: input.rawFindingIds,
    firstSeen: observation,
    lastSeen: observationFromContext(input.context),
  };
}

function observationFromContext(context: FindingReconcileContext): FindingObservation {
  return {
    stepName: context.stepName,
    runId: context.runId,
    timestamp: context.timestamp,
  };
}

function withoutResolutionFields(finding: FindingRecord): Omit<FindingRecord, 'resolvedAt' | 'resolvedEvidence'> {
  return {
    id: finding.id,
    status: finding.status,
    lifecycle: finding.lifecycle,
    severity: finding.severity,
    title: finding.title,
    rawFindingIds: finding.rawFindingIds,
    ...(finding.location !== undefined ? { location: finding.location } : {}),
    ...(finding.description !== undefined ? { description: finding.description } : {}),
    ...(finding.suggestion !== undefined ? { suggestion: finding.suggestion } : {}),
    reviewers: finding.reviewers,
    firstSeen: finding.firstSeen,
    lastSeen: finding.lastSeen,
    ...(finding.reopenedEvidence !== undefined ? { reopenedEvidence: finding.reopenedEvidence } : {}),
  };
}

function withoutConflictResolutionFields(
  conflict: FindingLedgerConflict,
): Omit<FindingLedgerConflict, 'resolvedAt' | 'resolvedEvidence'> {
  return {
    id: conflict.id,
    status: conflict.status,
    findingIds: conflict.findingIds,
    rawFindingIds: conflict.rawFindingIds,
    description: conflict.description,
    firstSeen: conflict.firstSeen,
    lastSeen: conflict.lastSeen,
  };
}

function reconcileLedgerConflicts(input: {
  previousLedger: FindingLedger;
  managerOutput: FindingManagerOutput;
  knownFindingIds: Set<string>;
  rawFindingIds: Set<string>;
  usedRawFindingIds: Set<string>;
  context: FindingReconcileContext;
}): FindingLedgerConflict[] {
  const conflictsById = new Map(input.previousLedger.conflicts.map((conflict) => [conflict.id, { ...conflict }]));

  for (const resolvedConflict of input.managerOutput.resolvedConflicts) {
    assertKnownConflict(conflictsById, resolvedConflict.conflictId);
    const conflict = conflictsById.get(resolvedConflict.conflictId)!;
    if (conflict.status !== 'active') {
      throw new Error(`Cannot resolve conflict "${conflict.id}" because it is not active`);
    }
    conflictsById.set(conflict.id, {
      ...conflict,
      status: 'resolved',
      resolvedAt: input.context.timestamp,
      resolvedEvidence: resolvedConflict.evidence,
    });
  }

  for (const conflict of input.managerOutput.conflicts) {
    if (conflict.findingIds.length === 0) {
      assertNonEmptyIds(conflict.rawFindingIds, 'raw finding id');
    }
    assertUniqueIds(conflict.rawFindingIds, 'raw finding id');
    for (const findingId of conflict.findingIds) {
      assertKnownFinding(input.knownFindingIds, findingId);
    }
    if (conflict.rawFindingIds.length > 0) {
      assertKnownRawFindings(input.rawFindingIds, conflict.rawFindingIds);
      markRawFindingIdsUsed(input.usedRawFindingIds, conflict.rawFindingIds);
    }

    const conflictId = formatConflictId(conflict);
    const existing = conflictsById.get(conflictId);
    const base = existing !== undefined
      ? withoutConflictResolutionFields(existing)
      : {
        id: conflictId,
        status: 'active' as const,
        findingIds: [...conflict.findingIds],
        rawFindingIds: [],
        description: conflict.description,
        firstSeen: observationFromContext(input.context),
        lastSeen: observationFromContext(input.context),
      };

    conflictsById.set(conflictId, {
      ...base,
      status: 'active',
      rawFindingIds: mergeRawFindingIds(base.rawFindingIds, conflict.rawFindingIds),
      description: conflict.description,
      lastSeen: observationFromContext(input.context),
    });
  }

  return [...conflictsById.values()];
}

export function reconcileFindingLedger(input: ReconcileFindingLedgerInput): FindingLedger {
  const rawFindingIds = new Set(input.rawFindings.map((finding) => finding.rawFindingId));
  assertUniqueIds(input.rawFindings.map((finding) => finding.rawFindingId), 'raw finding id');
  assertLedgerIdAllocationInvariant(input.previousLedger);
  const previousById = new Map(input.previousLedger.findings.map((finding) => [finding.id, finding]));
  const previousRawFindingsById = new Map(input.previousLedger.rawFindings.map((finding) => [
    finding.rawFindingId,
    finding,
  ]));
  const knownFindingIds = new Set(previousById.keys());
  assertFindingIdsHaveSingleDecision(input.managerOutput);
  let nextId = input.previousLedger.nextId;
  const usedRawFindingIds = new Set<string>();

  const updatedById = new Map<string, FindingRecord>(
    input.previousLedger.findings.map((finding) => [finding.id, { ...finding }]),
  );

  for (const match of input.managerOutput.matches) {
    assertKnownFinding(knownFindingIds, match.findingId);
    assertKnownRawFindings(rawFindingIds, match.rawFindingIds);
    markRawFindingIdsUsed(usedRawFindingIds, match.rawFindingIds);
    const finding = updatedById.get(match.findingId)!;
    assertFindingStatus(finding, 'open', 'match');
    const matchedRawFindings = getRawFindings(input.rawFindings, match.rawFindingIds);
    assertFindingFamilyTagCompatible({
      finding,
      previousRawFindingsById,
      currentRawFindings: matchedRawFindings,
      action: 'match',
    });
    const evidence = rawEvidenceFields(matchedRawFindings);
    updatedById.set(match.findingId, {
      ...finding,
      status: 'open',
      lifecycle: finding.lifecycle === 'reopened' ? 'reopened' : 'persists',
      rawFindingIds: mergeRawFindingIds(finding.rawFindingIds, match.rawFindingIds),
      location: evidence.location ?? finding.location,
      description: evidence.description,
      suggestion: evidence.suggestion ?? finding.suggestion,
      reviewers: mergeReviewers(finding.reviewers, matchedRawFindings),
      lastSeen: observationFromContext(input.context),
    });
  }

  for (const resolved of input.managerOutput.resolvedFindings) {
    assertKnownFinding(knownFindingIds, resolved.findingId);
    const finding = updatedById.get(resolved.findingId)!;
    assertFindingStatus(finding, 'open', 'resolve');
    assertResolvedEvidenceRawFindings({
      finding,
      resolvedRawFindingIds: resolved.rawFindingIds,
      previousRawFindingsById,
    });
    updatedById.set(resolved.findingId, {
      ...finding,
      status: 'resolved',
      lifecycle: 'resolved',
      resolvedAt: input.context.timestamp,
      resolvedEvidence: resolved.evidence,
    });
  }

  for (const reopened of input.managerOutput.reopenedFindings) {
    assertKnownFinding(knownFindingIds, reopened.findingId);
    assertKnownRawFindings(rawFindingIds, reopened.rawFindingIds);
    markRawFindingIdsUsed(usedRawFindingIds, reopened.rawFindingIds);
    const finding = updatedById.get(reopened.findingId)!;
    assertFindingStatus(finding, 'resolved', 'reopen');
    const reopenedRawFindings = getRawFindings(input.rawFindings, reopened.rawFindingIds);
    assertFindingFamilyTagCompatible({
      finding,
      previousRawFindingsById,
      currentRawFindings: reopenedRawFindings,
      action: 'reopen',
    });
    const evidence = rawEvidenceFields(reopenedRawFindings);
    const reopenedFinding = withoutResolutionFields(finding);
    updatedById.set(reopened.findingId, {
      ...reopenedFinding,
      status: 'open',
      lifecycle: 'reopened',
      rawFindingIds: mergeRawFindingIds(finding.rawFindingIds, reopened.rawFindingIds),
      location: evidence.location ?? finding.location,
      description: evidence.description,
      suggestion: evidence.suggestion ?? finding.suggestion,
      reviewers: mergeReviewers(finding.reviewers, reopenedRawFindings),
      lastSeen: observationFromContext(input.context),
      reopenedEvidence: reopened.evidence,
    });
  }

  const newFindings: FindingRecord[] = input.managerOutput.newFindings.map((newFinding) => {
    assertKnownRawFindings(rawFindingIds, newFinding.rawFindingIds);
    markRawFindingIdsUsed(usedRawFindingIds, newFinding.rawFindingIds);
    const rawFinding = getRawFinding(input.rawFindings, newFinding.rawFindingIds);
    const newRawFindings = getRawFindings(input.rawFindings, newFinding.rawFindingIds);
    assertSameFamilyTag(newRawFindings, 'create a new finding from');
    const id = formatFindingId(nextId);
    nextId += 1;
    return buildNewFinding({
      id,
      severity: newFinding.severity,
      title: newFinding.title,
      rawFindingIds: [...newFinding.rawFindingIds],
      rawFindings: newRawFindings,
      firstSeenStepName: rawFinding.stepName,
      context: input.context,
    });
  });

  const conflicts = reconcileLedgerConflicts({
    previousLedger: input.previousLedger,
    managerOutput: input.managerOutput,
    knownFindingIds,
    rawFindingIds,
    usedRawFindingIds,
    context: input.context,
  });

  const unmentionedNewFindings = input.rawFindings
    .filter((rawFinding) => !usedRawFindingIds.has(rawFinding.rawFindingId))
    .map((rawFinding) => {
      const id = formatFindingId(nextId);
      nextId += 1;
      return buildNewFinding({
        id,
        severity: rawFinding.severity,
        title: rawFinding.title,
        rawFindingIds: [rawFinding.rawFindingId],
        rawFindings: [rawFinding],
        firstSeenStepName: rawFinding.stepName,
        context: input.context,
      });
    });

  return {
    version: 1,
    workflowName: input.context.workflowName,
    nextId,
    updatedAt: input.context.timestamp,
    findings: [...updatedById.values(), ...newFindings, ...unmentionedNewFindings],
    rawFindings: mergeRawFindingDetails(input.previousLedger.rawFindings, input.rawFindings),
    conflicts,
  };
}
