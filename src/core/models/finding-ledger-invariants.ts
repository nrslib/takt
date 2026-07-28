import { formatConflictId, type ConflictIdentity } from './finding-conflict-identity.js';

const FINDING_ID_PATTERN = /^F-(\d{4})$/;

export interface FindingLedgerProjectionInvariantInput {
  nextId: number;
  findings: readonly {
    id: string;
    status: string;
    evidenceIds: readonly string[];
    supersededByFindingId?: string;
  }[];
  evidenceRecords: readonly { evidenceId: string }[];
  conflicts: readonly (ConflictIdentity & { id: string })[];
}

export interface FindingLedgerProjectionInvariantViolation {
  path: Array<string | number>;
  message: string;
}

function formatFindingIdNumber(idNumber: number): string {
  return `F-${String(idNumber).padStart(4, '0')}`;
}

export function collectFindingLedgerProjectionInvariantViolations(
  projection: FindingLedgerProjectionInvariantInput,
): FindingLedgerProjectionInvariantViolation[] {
  const violations: FindingLedgerProjectionInvariantViolation[] = [];
  const seen = new Set<string>();
  const evidenceIds = new Set<string>();
  projection.evidenceRecords.forEach((record, index) => {
    if (evidenceIds.has(record.evidenceId)) {
      violations.push({
        path: ['evidenceRecords', index, 'evidenceId'],
        message: `Duplicate evidence id "${record.evidenceId}"`,
      });
    }
    evidenceIds.add(record.evidenceId);
  });
  let maxFindingId = 0;
  projection.findings.forEach((finding, index) => {
    if (seen.has(finding.id)) {
      violations.push({
        path: ['findings', index, 'id'],
        message: `Duplicate finding id "${finding.id}"`,
      });
      return;
    }
    seen.add(finding.id);
    const match = FINDING_ID_PATTERN.exec(finding.id);
    if (match === null) {
      violations.push({
        path: ['findings', index, 'id'],
        message: `Invalid finding id format "${finding.id}"`,
      });
      return;
    }
    maxFindingId = Math.max(maxFindingId, Number(match[1]));
    finding.evidenceIds.forEach((evidenceId, evidenceIndex) => {
      if (!evidenceIds.has(evidenceId)) {
        violations.push({
          path: ['findings', index, 'evidenceIds', evidenceIndex],
          message: `Finding "${finding.id}" references unknown evidence id "${evidenceId}"`,
        });
      }
    });
  });
  const findingsById = new Map(projection.findings.map((finding) => [finding.id, finding]));
  projection.findings.forEach((finding, index) => {
    if (finding.status !== 'superseded' || finding.supersededByFindingId === undefined) {
      return;
    }
    const canonical = findingsById.get(finding.supersededByFindingId);
    if (canonical === undefined) {
      violations.push({
        path: ['findings', index, 'supersededByFindingId'],
        message: `Superseded finding "${finding.id}" references unknown canonical finding "${finding.supersededByFindingId}"`,
      });
      return;
    }
    const canonicalEvidenceIds = new Set(canonical.evidenceIds);
    const missingEvidenceId = finding.evidenceIds.find(
      (evidenceId) => !canonicalEvidenceIds.has(evidenceId),
    );
    if (missingEvidenceId !== undefined) {
      violations.push({
        path: ['findings', index, 'evidenceIds'],
        message: `Superseded finding "${finding.id}" evidence id "${missingEvidenceId}" must also be referenced by canonical finding "${canonical.id}"`,
      });
    }
  });
  if (projection.nextId <= maxFindingId) {
    violations.push({
      path: ['nextId'],
      message: `Finding ledger nextId ${projection.nextId} must be greater than existing finding id ${formatFindingIdNumber(maxFindingId)}`,
    });
  }
  projection.conflicts.forEach((conflict, index) => {
    const canonicalId = formatConflictId(conflict);
    if (conflict.id !== canonicalId) {
      violations.push({
        path: ['conflicts', index, 'id'],
        message: `Conflict id "${conflict.id}" must equal its canonical content-derived id "${canonicalId}"`,
      });
    }
  });
  return violations;
}

export function assertFindingLedgerProjectionInvariant(
  projection: FindingLedgerProjectionInvariantInput,
): void {
  const violation = collectFindingLedgerProjectionInvariantViolations(projection)[0];
  if (violation !== undefined) {
    throw new Error(violation.message);
  }
}
