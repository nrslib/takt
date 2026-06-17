import { describe, expect, it } from 'vitest';
import { validateFindingManagerOutput } from '../core/workflow/findings/manager-output-validation.js';
import type {
  FindingLedger,
  FindingManagerOutput,
  RawFinding,
} from '../core/workflow/findings/types.js';

function makeLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    version: 1,
    workflowName: 'peer-review',
    nextId: 2,
    updatedAt: '2026-06-13T00:00:00.000Z',
    rawFindings: [makeRawFinding({ rawFindingId: 'raw-existing' })],
    conflicts: [],
    findings: [
      {
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        severity: 'high',
        title: 'Existing issue',
        reviewers: ['architecture-review'],
        rawFindingIds: ['raw-existing'],
        firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
      },
    ],
    ...overrides,
  };
}

function makeRawFinding(overrides: Partial<RawFinding> = {}): RawFinding {
  return {
    rawFindingId: 'raw-current',
    stepName: 'architecture-review',
    reviewer: 'architecture-review',
    familyTag: 'bug',
    severity: 'high',
    title: 'Current issue',
    description: 'The issue is present in the current review.',
    ...overrides,
  };
}

function makeManagerOutput(overrides: Partial<FindingManagerOutput> = {}): FindingManagerOutput {
  return {
    matches: [],
    newFindings: [],
    resolvedFindings: [],
    reopenedFindings: [],
    conflicts: [],
    resolvedConflicts: [],
    ...overrides,
  };
}

describe('validateFindingManagerOutput', () => {
  it('should accept a valid manager output before reconciliation', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [makeRawFinding()],
      managerOutput: makeManagerOutput({
        matches: [{ findingId: 'F-0001', rawFindingIds: ['raw-current'] }],
      }),
    });

    expect(result).toEqual({ ok: true });
  });

  it('should reject a rawFindingId referenced by multiple decision categories', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [makeRawFinding()],
      managerOutput: makeManagerOutput({
        newFindings: [{ rawFindingIds: ['raw-current'], title: 'Current issue', severity: 'high' }],
        conflicts: [{ findingIds: [], rawFindingIds: ['raw-current'], description: 'Duplicate raw decision.' }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        'Raw finding id "raw-current" appears in multiple manager decisions: newFindings[0] and conflicts[0]',
      ],
    });
  });

  it('should reject a rawFindingId shared by resolvedFindings and another decision category', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [makeRawFinding({ rawFindingId: 'raw-existing' })],
      managerOutput: makeManagerOutput({
        newFindings: [{ rawFindingIds: ['raw-existing'], title: 'Current issue', severity: 'high' }],
        resolvedFindings: [{ findingId: 'F-0001', rawFindingIds: ['raw-existing'], evidence: 'Fixed.' }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        'Raw finding id "raw-existing" appears in multiple manager decisions: newFindings[0] and resolvedFindings[0]',
      ],
    });
  });

  it('should reject a rawFindingId shared by multiple resolvedFindings decisions', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger({
        findings: [
          {
            id: 'F-0001',
            status: 'open',
            lifecycle: 'new',
            severity: 'high',
            title: 'Existing issue',
            reviewers: ['architecture-review'],
            rawFindingIds: ['raw-existing'],
            firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
            lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
          },
          {
            id: 'F-0002',
            status: 'open',
            lifecycle: 'new',
            severity: 'medium',
            title: 'Second issue',
            reviewers: ['architecture-review'],
            rawFindingIds: ['raw-existing'],
            firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
            lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
          },
        ],
      }),
      rawFindings: [],
      managerOutput: makeManagerOutput({
        resolvedFindings: [
          { findingId: 'F-0001', rawFindingIds: ['raw-existing'], evidence: 'Fixed.' },
          { findingId: 'F-0002', rawFindingIds: ['raw-existing'], evidence: 'Also fixed.' },
        ],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        'Raw finding id "raw-existing" appears in multiple manager decisions: resolvedFindings[0] and resolvedFindings[1]',
      ],
    });
  });

  it('should reject a findingId referenced by multiple decision categories', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [makeRawFinding()],
      managerOutput: makeManagerOutput({
        matches: [{ findingId: 'F-0001', rawFindingIds: ['raw-current'] }],
        conflicts: [{ findingIds: ['F-0001'], rawFindingIds: [], description: 'Conflicting decision.' }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        'Finding id "F-0001" appears in multiple manager decisions: matches[0] and conflicts[0]',
      ],
    });
  });

  it('should reject unknown rawFindingId references in current raw-finding decisions', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [makeRawFinding({ rawFindingId: 'raw-current' })],
      managerOutput: makeManagerOutput({
        newFindings: [{ rawFindingIds: ['raw-missing'], title: 'Missing raw finding', severity: 'high' }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: ['Unknown raw finding id "raw-missing" in newFindings[0]'],
    });
  });

  it('should reject current raw-finding decisions with empty rawFindingIds before reconciliation', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [makeRawFinding()],
      managerOutput: makeManagerOutput({
        newFindings: [{ rawFindingIds: [], title: 'Missing raw evidence', severity: 'high' }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: ['newFindings[0] must reference at least one current raw finding id'],
    });
  });

  it('should reject conflicts without existing finding ids or current raw finding ids', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [makeRawFinding()],
      managerOutput: makeManagerOutput({
        conflicts: [{ findingIds: [], rawFindingIds: [], description: 'No conflict evidence.' }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: ['conflicts[0] must reference at least one finding id or current raw finding id'],
    });
  });

  it('should reject unknown findingId references', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [makeRawFinding()],
      managerOutput: makeManagerOutput({
        matches: [{ findingId: 'F-9999', rawFindingIds: ['raw-current'] }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: ['Unknown finding id "F-9999" in matches[0]'],
    });
  });

  it('should validate resolvedFinding rawFindingIds against the previous ledger evidence', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger({
        rawFindings: [makeRawFinding({ rawFindingId: 'raw-other' })],
      }),
      rawFindings: [],
      managerOutput: makeManagerOutput({
        resolvedFindings: [{ findingId: 'F-0001', rawFindingIds: ['raw-other'], evidence: 'Fixed.' }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: ['Resolved finding "F-0001" references raw finding id "raw-other" that does not belong to the finding'],
    });
  });

  it('should reject invalid state transitions before ledger mutation', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger({
        findings: [
          {
            id: 'F-0001',
            status: 'resolved',
            lifecycle: 'resolved',
            severity: 'high',
            title: 'Resolved issue',
            reviewers: ['architecture-review'],
            rawFindingIds: ['raw-existing'],
            firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
            lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
            resolvedAt: '2026-06-13T00:30:00.000Z',
          },
        ],
      }),
      rawFindings: [makeRawFinding()],
      managerOutput: makeManagerOutput({
        matches: [{ findingId: 'F-0001', rawFindingIds: ['raw-current'] }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: ['Cannot match finding "F-0001" because it is not open'],
    });
  });

  it('should reject raw findings with different familyTag values before reconciliation', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [
        makeRawFinding({ rawFindingId: 'raw-current-a', familyTag: 'bug' }),
        makeRawFinding({ rawFindingId: 'raw-current-b', familyTag: 'security' }),
      ],
      managerOutput: makeManagerOutput({
        newFindings: [{
          rawFindingIds: ['raw-current-a', 'raw-current-b'],
          title: 'Mixed finding families',
          severity: 'high',
        }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        'Cannot create a new finding from raw findings with different familyTag values: "bug" and "security" (newFindings[0])',
      ],
    });
  });
});
