import { describe, expect, it } from 'vitest';
import type { PartDefinition } from '../core/models/types.js';
import {
  FindingContractPartCompletionValidationError,
  createFindingContractPartCompletionStructuredOutputError,
  createFindingContractPartCompletionMutationGuard,
  validateFindingContractPartCompletion,
} from '../core/workflow/team-leader-finding-contract-part-completion-validation.js';

const part: PartDefinition = {
  id: 'repair',
  title: 'Repair',
  instruction: 'repair',
  findingContract: {
    findingIds: ['F-0001', 'F-0002'],
    role: 'repair',
    writePaths: ['src'],
    readPaths: ['src'],
  },
};

function validClaim() {
  return {
    findingOutcomes: [
      {
        findingId: 'F-0001',
        outcome: 'addressed',
        evidence: ['src/one.ts:10'],
      },
      {
        findingId: 'F-0002',
        outcome: 'disputed',
        evidence: ['src/two.ts:20'],
      },
    ],
    changedPaths: ['src/one.ts'],
    checks: [{ command: 'npm test', status: 'passed' }],
    summary: 'completed',
  };
}

describe('Finding Contract part completion validation', () => {
  it.each([
    ['model_output', 'corrective_retry', 'shape.structured_output'],
    ['schema_config', 'terminal', 'contract.schema_config'],
  ] as const)('classifies %s structured output failures', (kind, retryability, code) => {
    const error = createFindingContractPartCompletionStructuredOutputError(
      part,
      'invalid structured output',
      kind,
      {},
    );

    expect(error.retryability).toBe(retryability);
    expect(error.issues).toEqual([
      expect.objectContaining({ code, retryability }),
    ]);
  });

  it('aggregates independent retryable claim issues', () => {
    let captured: unknown;
    try {
      validateFindingContractPartCompletion({
        findingOutcomes: [
          {
            findingId: 'F-0001',
            outcome: 'invalid',
            evidence: [],
          },
          {
            findingId: 'F-0001',
            outcome: 'addressed',
            evidence: ['src/one.ts:10'],
          },
        ],
        changedPaths: [],
        checks: [{ command: '', status: 'invalid' }],
        summary: '',
        unknown: true,
      }, part);
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(FindingContractPartCompletionValidationError);
    const error = captured as FindingContractPartCompletionValidationError;
    expect(error.retryability).toBe('corrective_retry');
    expect(error.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'contract.duplicate_outcome',
      'contract.invalid_check_status',
      'contract.invalid_outcome',
      'contract.missing_outcome',
      'evidence.invalid_evidence',
      'shape.check_command',
      'shape.summary',
      'shape.unknown_key',
    ]));
    expect(new Set(error.issues.map((issue) => issue.boundaryKind))).toEqual(new Set(['part_completion']));
  });

  it.each([
    {
      label: 'unassigned finding',
      mutate: (claim: ReturnType<typeof validClaim>) => ({
        ...claim,
        findingOutcomes: [
          ...claim.findingOutcomes,
          { findingId: 'F-9999', outcome: 'addressed', evidence: ['src/other.ts:1'] },
        ],
      }),
      code: 'authority.unassigned_finding',
    },
    {
      label: 'path outside assignment',
      mutate: (claim: ReturnType<typeof validClaim>) => ({
        ...claim,
        changedPaths: ['docs/outside.md'],
      }),
      code: 'authority.changed_path_outside_assignment',
    },
    {
      label: 'absolute path',
      mutate: (claim: ReturnType<typeof validClaim>) => ({
        ...claim,
        changedPaths: ['/tmp/outside.ts'],
      }),
      code: 'authority.invalid_changed_path',
    },
  ])('classifies $label as terminal without correction', ({ mutate, code }) => {
    let captured: unknown;
    try {
      validateFindingContractPartCompletion(mutate(validClaim()), part);
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(FindingContractPartCompletionValidationError);
    const error = captured as FindingContractPartCompletionValidationError;
    expect(error.retryability).toBe('terminal');
    expect(error.issues.some((issue) => issue.code === code)).toBe(true);
  });

  it('requires disputed evidence to contain file:line', () => {
    const claim = validClaim();
    claim.findingOutcomes[1] = {
      findingId: 'F-0002',
      outcome: 'disputed',
      evidence: ['inspected the file'],
    };

    expect(() => validateFindingContractPartCompletion(claim, part)).toThrow(
      expect.objectContaining({
        retryability: 'corrective_retry',
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'evidence.disputed_file_line' }),
        ]),
      }),
    );
  });

  it('classifies a malformed changed path value as corrective', () => {
    const claim: Record<string, unknown> = validClaim();
    claim.changedPaths = [42];

    expect(() => validateFindingContractPartCompletion(claim, part)).toThrow(
      expect.objectContaining({
        retryability: 'corrective_retry',
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'shape.changed_path' }),
        ]),
      }),
    );
  });

  it('rejects correction that mutates previously valid contract fields but permits a revised summary', () => {
    const initial = validClaim();
    initial.findingOutcomes[1] = {
      findingId: 'F-0002',
      outcome: 'disputed',
      evidence: ['missing location'],
    };
    const guard = createFindingContractPartCompletionMutationGuard(initial, part);
    const correction = validClaim();
    correction.changedPaths = [];
    correction.summary = 'rewritten';

    expect(() => validateFindingContractPartCompletion(correction, part, guard)).toThrow(
      expect.objectContaining({
        retryability: 'corrective_retry',
        issues: [
          expect.objectContaining({
            code: 'mutation.valid_field_changed',
            path: 'changedPaths',
          }),
        ],
      }),
    );
  });

  it('accepts correction that only revises the summary', () => {
    const initial = validClaim();
    initial.findingOutcomes[1] = {
      findingId: 'F-0002',
      outcome: 'disputed',
      evidence: ['missing location'],
    };
    const guard = createFindingContractPartCompletionMutationGuard(initial, part);
    const correction = validClaim();
    correction.summary = 'rewritten after correcting the invalid finding outcome';

    expect(
      validateFindingContractPartCompletion(correction, part, guard).summary,
    ).toBe('rewritten after correcting the invalid finding outcome');
  });

  it('reports bounded evidence violations as typed corrective issues', () => {
    const claim = validClaim();
    claim.findingOutcomes[0] = {
      ...claim.findingOutcomes[0],
      evidence: ['x'.repeat(1_001)],
    };

    expect(() => validateFindingContractPartCompletion(claim, part)).toThrow(
      expect.objectContaining({
        retryability: 'corrective_retry',
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'evidence.invalid_evidence',
            findingId: 'F-0001',
          }),
        ]),
      }),
    );
  });
});
