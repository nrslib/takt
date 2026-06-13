import type { FindingLedger } from './types.js';

const FINDING_ID_PATTERN = /^F-(\d{4})$/;

function formatFindingIdNumber(idNumber: number): string {
  return `F-${String(idNumber).padStart(4, '0')}`;
}

function parseFindingIdNumber(findingId: string): number {
  const match = FINDING_ID_PATTERN.exec(findingId);
  if (!match) {
    throw new Error(`Invalid finding id format "${findingId}"`);
  }
  return Number(match[1]);
}

export function assertLedgerIdAllocationInvariant(ledger: FindingLedger): void {
  const seen = new Set<string>();
  let maxFindingId = 0;
  for (const finding of ledger.findings) {
    if (seen.has(finding.id)) {
      throw new Error(`Duplicate finding id "${finding.id}"`);
    }
    seen.add(finding.id);
    maxFindingId = Math.max(maxFindingId, parseFindingIdNumber(finding.id));
  }
  if (ledger.nextId <= maxFindingId) {
    throw new Error(
      `Finding ledger nextId ${ledger.nextId} must be greater than existing finding id ${formatFindingIdNumber(maxFindingId)}`,
    );
  }
}
