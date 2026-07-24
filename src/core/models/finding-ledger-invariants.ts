import { formatConflictId, type ConflictIdentity } from './finding-conflict-identity.js';

const FINDING_ID_PATTERN = /^F-(\d{4})$/;

export interface FindingLedgerProjectionInvariantInput {
  nextId: number;
  findings: readonly { id: string }[];
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
