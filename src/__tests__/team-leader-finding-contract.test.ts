import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFindingContractPartIndexEntry,
  createFindingContractDecompositionJsonSchema,
  createFindingContractFeedbackJsonSchema,
  createFindingContractPartCompletionJsonSchema,
  parseFindingContractPartCompletionClaim,
  parseFindingContractPartDefinition,
  buildLatestFindingContractDigests,
  renderActionableFindingContractSummary,
  renderCompactActionableFindingContractSummary,
  validateFindingContractPartBatch,
} from '../core/workflow/team-leader-finding-contract.js';
import {
  FindingContractTeamLeaderDecisionValidationError,
  parseFindingContractTeamLeaderDecision,
} from '../core/workflow/team-leader-finding-contract-decision.js';
import { buildFindingContractDecisionEvidenceSnapshot } from '../core/workflow/team-leader-finding-contract-evidence.js';
import { createFindingContractRejectedDecisionDigest } from '../core/workflow/team-leader-finding-contract-decision-validation.js';
import { buildFindingContractTeamLeaderAggregatedContent } from '../core/workflow/engine/team-leader-aggregation.js';
import type { FindingLedger, PartDefinition, PartResult } from '../core/models/types.js';
import { buildMorePartsPrompt } from '../agents/team-leader-structured-output.js';
import { buildFindingContractRecoveryPromptSections } from '../agents/team-leader-finding-contract-recovery-prompt.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { writeTeamLeaderPartArtifact } from '../core/workflow/engine/team-leader-artifacts.js';
import {
  buildTeamLeaderPartFeedbackResult,
} from '../core/workflow/engine/team-leader-common.js';
import { validateStructuredOutputAgainstSchema } from '../core/workflow/engine/structured-output-schema-validator.js';
import { FINDING_CONTRACT_CHANGED_PATHS_LIMITS } from '../core/workflow/team-leader-finding-contract-validation.js';
import {
  FindingContractDecompositionValidationError,
  validateFindingContractDecomposition,
} from '../core/workflow/team-leader-finding-contract-decomposition-validation.js';

function makePart(
  id: string,
  findingIds: string[],
  role: 'diagnose' | 'repair' | 'verify' = 'repair',
  writePaths: string[] = [`src/${id}.ts`],
): PartDefinition {
  return parseFindingContractPartDefinition({
    id,
    title: `title-${id}`,
    instruction: `do-${id}`,
    findingContract: {
      findingIds,
      role,
      writePaths,
      readPaths: [],
    },
  }, 0);
}

function makeResult(part: PartDefinition, summary = `completed ${part.id}`): PartResult {
  if (!part.findingContract) throw new Error(`Missing Finding Contract assignment: ${part.id}`);
  const findingContractClaim = {
    findingOutcomes: part.findingContract.findingIds.map((findingId) => ({
      findingId,
      outcome: 'addressed' as const,
      evidence: [`src/${part.id}.ts:10`],
    })),
    changedPaths: [`src/${part.id}.ts`],
    checks: [{ command: 'npm test', status: 'passed' as const }],
    summary,
  };
  return {
    part,
    findingContractClaim,
    response: {
      persona: `fix.${part.id}`,
      status: 'done',
      content: `raw response for ${part.id}`,
      structuredOutput: findingContractClaim,
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    },
  };
}

function parseDecision(
  raw: unknown,
  targetFindingIds: readonly string[],
  plannedParts: readonly PartDefinition[],
  partResults: readonly PartResult[] = plannedParts.map((part) => makeResult(part)),
) {
  return parseFindingContractTeamLeaderDecision(raw, {
    targetFindingIds,
    plannedParts,
    evidence: buildFindingContractDecisionEvidenceSnapshot(partResults, targetFindingIds),
  });
}

describe('Finding Contract Team Leader contract', () => {
  it('aggregates malformed decomposition parts into typed corrective diagnostics', () => {
    let captured: unknown;
    try {
      validateFindingContractDecomposition([
        { id: '', unexpected: true },
        { id: 'valid-shape-but-missing-fields' },
      ], 1, ['F-0001']);
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(FindingContractDecompositionValidationError);
    expect(captured).toMatchObject({
      retryability: 'corrective_retry',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'contract.initial_part_limit' }),
        expect.objectContaining({ code: 'shape.part', path: 'parts[0]' }),
        expect.objectContaining({ code: 'shape.part', path: 'parts[1]' }),
      ]),
    });
  });

  it('keeps actionable context while omitting raw finding IDs from the Team Leader summary', () => {
    const observedAt = {
      runId: 'run-1',
      stepName: 'reviewers',
      timestamp: '2026-07-23T00:00:00.000Z',
    };
    const ledger: FindingLedger = {
      version: 1,
      workflowName: 'workflow',
      nextId: 2,
      updatedAt: observedAt.timestamp,
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'persists',
        severity: 'high',
        title: 'Defect',
        location: 'src/defect.ts:10',
        description: 'The defect persists.',
        suggestion: 'Repair the defect class.',
        reviewers: ['architecture-review', 'testing-review'],
        rawFindingIds: ['raw-architecture', 'raw-testing'],
        firstSeen: observedAt,
        lastSeen: observedAt,
      }],
      rawFindings: [
        {
          rawFindingId: 'raw-architecture',
          stepName: 'reviewers',
          reviewer: 'architecture-review',
          familyTag: 'architecture',
          severity: 'high',
          title: 'Defect',
          location: 'src/defect.ts:10',
          description: 'The defect persists.',
          suggestion: 'Repair the defect class.',
          relation: 'new',
        },
        {
          rawFindingId: 'raw-testing',
          stepName: 'reviewers',
          reviewer: 'testing-review',
          familyTag: 'testing',
          severity: 'high',
          title: 'Defect',
          location: 'src/defect.ts:10',
          description: 'The defect persists.',
          suggestion: 'Repair the defect class.',
          relation: 'new',
        },
      ],
      conflicts: [],
    };

    const summary = JSON.parse(renderCompactActionableFindingContractSummary(ledger)) as {
      open: Array<Record<string, unknown>>;
    };
    const assignedSummary = JSON.parse(renderActionableFindingContractSummary(ledger)) as {
      open: Array<Record<string, unknown>>;
    };

    expect(summary.open[0]).toMatchObject({
      id: 'F-0001',
      lifecycle: 'persists',
      severity: 'high',
      location: 'src/defect.ts:10',
      description: 'The defect persists.',
      suggestion: 'Repair the defect class.',
      familyTags: ['architecture', 'testing'],
    });
    expect(summary.open[0]).not.toHaveProperty('rawFindingIds');
    expect(assignedSummary.open[0]).toHaveProperty(
      'rawFindingIds',
      ['raw-architecture', 'raw-testing'],
    );
  });

  it('parses a scoped assignment and normalizes portable paths', () => {
    const part = parseFindingContractPartDefinition({
      id: 'repair-api',
      title: 'Repair API',
      instruction: 'repair it',
      findingContract: {
        findingIds: ['F-0001'],
        role: 'repair',
        writePaths: ['./src\\app\\[slug]\\page.tsx'],
        readPaths: ['src/{draft}.ts'],
      },
    }, 0);

    expect(part.findingContract).toEqual({
      findingIds: ['F-0001'],
      role: 'repair',
      writePaths: ['src/app/[slug]/page.tsx'],
      readPaths: ['src/{draft}.ts'],
    });

    const directoryPart = makePart('directory', ['F-0001'], 'repair', ['src/api/']);
    expect(directoryPart.findingContract?.writePaths).toEqual(['src/api']);

    expect(() => parseFindingContractPartDefinition({
      id: 'unsafe',
      title: 'Unsafe',
      instruction: 'unsafe',
      findingContract: {
        findingIds: ['F-0001'],
        role: 'repair',
        writePaths: ['\\\\server\\share\\file.ts'],
        readPaths: [],
      },
    }, 0)).toThrow(/relative to the working directory/);
  });

  it('rejects unknown properties consistently with native structured output schemas', () => {
    expect(() => parseFindingContractPartDefinition({
      id: 'repair',
      title: 'Repair',
      instruction: 'repair',
      unexpected: true,
      findingContract: {
        findingIds: ['F-0001'],
        role: 'repair',
        writePaths: ['src/a.ts'],
        readPaths: [],
      },
    }, 0)).toThrow(/unknown property "unexpected"/);
  });

  it.each([
    'src/__tests__/**/*Arpeggio*.test.ts',
    'src/file?.ts',
  ])('rejects glob write and read paths before parts execute: %s', (path) => {
    const makeDefinition = (writePaths: string[], readPaths: string[]) => ({
      id: 'repair',
      title: 'Repair',
      instruction: 'repair',
      findingContract: {
        findingIds: ['F-0001'],
        role: 'repair',
        writePaths,
        readPaths,
      },
    });

    expect(() => parseFindingContractPartDefinition(
      makeDefinition([path], []),
      0,
    )).toThrow(/wildcard characters/);
    expect(() => parseFindingContractPartDefinition(
      makeDefinition(['src/a.ts'], [path]),
      0,
    )).toThrow(/wildcard characters/);
  });

  it.each([
    'src/**/*.ts',
    'src/file?.ts',
  ])('rejects wildcard paths in provider-facing Finding Contract schemas: %s', (path) => {
    expect(() => validateStructuredOutputAgainstSchema({
      parts: [{
        id: 'repair',
        title: 'Repair',
        instruction: 'repair',
        findingContract: {
          findingIds: ['F-0001'],
          role: 'repair',
          writePaths: [path],
          readPaths: [],
        },
      }],
    }, createFindingContractDecompositionJsonSchema())).toThrow(/must match pattern/);

    expect(() => validateStructuredOutputAgainstSchema({
      parts: [{
        id: 'repair',
        title: 'Repair',
        instruction: 'repair',
        findingContract: {
          findingIds: ['F-0001'],
          role: 'repair',
          writePaths: ['src/a.ts'],
          readPaths: [path],
        },
      }],
    }, createFindingContractDecompositionJsonSchema())).toThrow(/must match pattern/);

    expect(() => validateStructuredOutputAgainstSchema({
      decision: 'continue',
      reasoning: 'continue repair',
      parts: [{
        id: 'repair',
        title: 'Repair',
        instruction: 'repair',
        findingContract: {
          findingIds: ['F-0001'],
          role: 'repair',
          writePaths: [path],
          readPaths: [],
        },
      }],
      fixCoverage: [],
      blockers: [],
    }, createFindingContractFeedbackJsonSchema())).toThrow(/must match pattern/);

    expect(() => validateStructuredOutputAgainstSchema({
      decision: 'continue',
      reasoning: 'continue repair',
      parts: [{
        id: 'repair',
        title: 'Repair',
        instruction: 'repair',
        findingContract: {
          findingIds: ['F-0001'],
          role: 'repair',
          writePaths: ['src/a.ts'],
          readPaths: [path],
        },
      }],
      fixCoverage: [],
      blockers: [],
    }, createFindingContractFeedbackJsonSchema())).toThrow(/must match pattern/);

    expect(() => validateStructuredOutputAgainstSchema({
      findingOutcomes: [{
        findingId: 'F-0001',
        outcome: 'addressed',
        evidence: ['src/a.ts:1'],
      }],
      changedPaths: [path],
      checks: [],
      summary: 'done',
    }, createFindingContractPartCompletionJsonSchema())).toThrow(/must match pattern/);
  });

  it('keeps provider-facing finding ID schema native-compatible and validates semantics at runtime', () => {
    const makePayload = (findingIds: string[]) => ({
      parts: [{
        id: 'repair',
        title: 'Repair',
        instruction: 'repair',
        findingContract: {
          findingIds,
          role: 'repair',
          writePaths: ['src/a.ts'],
          readPaths: [],
        },
      }],
    });

    expect(() => validateStructuredOutputAgainstSchema(
      makePayload([]),
      createFindingContractDecompositionJsonSchema(),
    )).not.toThrow();
    expect(() => validateStructuredOutputAgainstSchema(
      makePayload(['F-0001', 'F-0001']),
      createFindingContractDecompositionJsonSchema(),
    )).not.toThrow();
    expect(() => parseFindingContractPartDefinition(makePayload([]).parts[0], 0))
      .toThrow(/must not be empty/);
    expect(() => parseFindingContractPartDefinition(
      makePayload(['F-0001', 'F-0001']).parts[0],
      0,
    )).toThrow(/must not contain duplicates/);
  });

  it('rejects unknown findings, duplicate repair ownership, and overlapping write paths', () => {
    expect(() => validateFindingContractPartBatch(
      [makePart('unknown', ['F-9999'])],
      ['F-0001'],
    )).toThrow(/unknown actionable finding/);

    expect(() => validateFindingContractPartBatch(
      [makePart('first', ['F-0001']), makePart('second', ['F-0001'])],
      ['F-0001'],
    )).toThrow(/multiple repair parts/);

    expect(() => validateFindingContractPartBatch([
      makePart('parent', ['F-0001'], 'repair', ['src/api']),
      makePart('child', ['F-0002'], 'repair', ['src/api/client.ts']),
    ], ['F-0001', 'F-0002'])).toThrow(/write paths overlap/);

    expect(() => validateFindingContractPartBatch([
      makePart('parent-slash', ['F-0001'], 'repair', ['src/api/']),
      makePart('child', ['F-0002'], 'repair', ['src/api/client.ts']),
    ], ['F-0001', 'F-0002'])).toThrow(/write paths overlap/);

    expect(() => validateFindingContractPartBatch([
      makePart('root', ['F-0001'], 'repair', ['./']),
      makePart('nested', ['F-0002'], 'repair', ['src/api.ts']),
    ], ['F-0001', 'F-0002'])).toThrow(/write paths overlap/);
  });

  it('allows a later batch to repair a finding again after an earlier claim was blocked', () => {
    expect(() => parseDecision({
      decision: 'continue',
      reasoning: 'retry after blocked claim',
      parts: [makePart('retry', ['F-0001'])],
      fixCoverage: [],
      blockers: [],
    }, ['F-0001'], [makePart('first', ['F-0001'])])).not.toThrow();
  });

  it('keeps only the latest compact digest for each finding', () => {
    const first = buildFindingContractPartIndexEntry(makeResult(makePart('first', ['F-0001'])));
    const shared = buildFindingContractPartIndexEntry(makeResult(makePart('shared', ['F-0001', 'F-0002'])));
    const latest = buildFindingContractPartIndexEntry(makeResult(makePart('latest', ['F-0001'])));

    expect(buildLatestFindingContractDigests([
      { sequence: 2, entry: latest },
      { sequence: 0, entry: first },
      { sequence: 1, entry: shared },
    ])).toEqual([
      expect.objectContaining({ findingId: 'F-0001', partId: 'latest' }),
      expect.objectContaining({ findingId: 'F-0002', partId: 'shared' }),
    ]);
  });

  it('rejects a continue decision that reuses any existing part ID', () => {
    expect(() => parseDecision({
      decision: 'continue',
      reasoning: 'mixed IDs',
      parts: [makePart('existing', ['F-0001']), makePart('new', ['F-0002'])],
      fixCoverage: [],
      blockers: [],
    }, ['F-0001', 'F-0002'], [makePart('existing', ['F-0001'])]))
      .toThrow(/reuses existing part ID "existing"/);
  });

  it('requires a completion claim for exactly the assigned findings', () => {
    const part = makePart('repair', ['F-0001']);
    expect(() => parseFindingContractPartCompletionClaim({
      findingOutcomes: [{ findingId: 'F-0002', outcome: 'addressed', evidence: ['src/a.ts:1'] }],
      changedPaths: [],
      checks: [],
      summary: 'done',
    }, part)).toThrow(/unassigned finding/);
  });

  it('rejects changed paths outside the part assignment', () => {
    const repair = makePart('repair', ['F-0001'], 'repair', ['src/owned']);
    const claim = {
      findingOutcomes: [{ findingId: 'F-0001', outcome: 'addressed', evidence: ['src/owned/a.ts:1'] }],
      checks: [],
      summary: 'done',
    };

    expect(() => parseFindingContractPartCompletionClaim({
      ...claim,
      changedPaths: ['src/other.ts'],
    }, repair)).toThrow(/outside its writePaths assignment/);

    expect(() => parseFindingContractPartCompletionClaim({
      ...claim,
      changedPaths: ['src/owned/**/*.ts'],
    }, repair)).toThrow(/wildcard characters/);

    const dynamicRoute = makePart('dynamic-route', ['F-0001'], 'repair', ['src/app']);
    expect(() => parseFindingContractPartCompletionClaim({
      ...claim,
      changedPaths: ['src/app/[slug]/page.tsx'],
    }, dynamicRoute)).not.toThrow();
  });

  it('counts changed path maxLength as Unicode code points in both schema and runtime validation', () => {
    const part = makePart('unicode-path-boundary', ['F-0001'], 'repair', ['.']);
    const pathWithCodePoints = (length: number) => (
      `src/${'😀'.repeat(length - 'src/'.length - '.ts'.length)}.ts`
    );
    const tooManyPaths = Array.from(
      { length: FINDING_CONTRACT_CHANGED_PATHS_LIMITS.maxItems + 1 },
      (_, index) => `src/generated-${index}.ts`,
    );
    const baseClaim = {
      findingOutcomes: [{
        findingId: 'F-0001',
        outcome: 'addressed',
        evidence: ['src/target.ts:1'],
      }],
      checks: [{ command: 'npm test', status: 'passed' }],
      summary: 'claimed complete',
    };
    const schema = createFindingContractPartCompletionJsonSchema();

    for (const length of [999, 1000]) {
      const changedPath = pathWithCodePoints(length);
      expect([...changedPath]).toHaveLength(length);
      expect(changedPath.length).toBeGreaterThan(length);
      expect(() => validateStructuredOutputAgainstSchema({
        ...baseClaim,
        changedPaths: [changedPath],
      }, schema)).not.toThrow();
      expect(() => parseFindingContractPartCompletionClaim({
        ...baseClaim,
        changedPaths: [changedPath],
      }, part)).not.toThrow();
    }

    const overlongPath = pathWithCodePoints(1001);
    expect(() => validateStructuredOutputAgainstSchema({
      ...baseClaim,
      changedPaths: [overlongPath],
    }, schema)).toThrow();
    expect(() => parseFindingContractPartCompletionClaim({
      ...baseClaim,
      changedPaths: [overlongPath],
    }, part)).toThrow(
      new RegExp(`exceeds ${FINDING_CONTRACT_CHANGED_PATHS_LIMITS.maxItemLength} characters`),
    );

    expect(() => validateStructuredOutputAgainstSchema({
      ...baseClaim,
      changedPaths: tooManyPaths,
    }, schema)).toThrow();
    expect(() => parseFindingContractPartCompletionClaim({
      ...baseClaim,
      changedPaths: tooManyPaths,
    }, part)).toThrow(new RegExp(`exceeds ${FINDING_CONTRACT_CHANGED_PATHS_LIMITS.maxItems} items`));
  });

  it('preserves normal claim content and existing error feedback formatting', () => {
    const normalResult = makeResult(makePart('normal-feedback', ['F-0001']));
    const normalFeedback = buildTeamLeaderPartFeedbackResult(
      normalResult,
      buildFindingContractPartIndexEntry(normalResult),
    );
    expect(normalFeedback.content).toBe(normalResult.response.content);
    expect(normalFeedback.findingContractClaim?.claimAssessment).toBeUndefined();

    const errorResult = makeResult(makePart('error-feedback', ['F-0002']));
    errorResult.response = {
      ...errorResult.response,
      status: 'error',
      content: 'raw provider error content',
      error: 'provider failed',
    };
    const errorFeedback = buildTeamLeaderPartFeedbackResult(
      errorResult,
      buildFindingContractPartIndexEntry(errorResult),
    );
    expect(errorFeedback.content).toBe('[ERROR] provider failed');
    expect(errorFeedback.findingContractClaim?.claimAssessment).toBeUndefined();
  });

  it('treats the repository root as containing every relative changed path', () => {
    const repair = makePart('repair-root', ['F-0001'], 'repair', ['./']);

    expect(() => parseFindingContractPartCompletionClaim({
      findingOutcomes: [{ findingId: 'F-0001', outcome: 'addressed', evidence: ['src/a.ts:1'] }],
      changedPaths: ['src/a.ts'],
      checks: [],
      summary: 'done',
    }, repair)).not.toThrow();
  });

  it('accepts complete only when coverage contains every actionable finding exactly once', () => {
    const part = makePart('repair', ['F-0001', 'F-0002']);
    expect(() => parseDecision({
      decision: 'complete',
      reasoning: 'all fixed',
      parts: [],
      fixCoverage: [{
        findingId: 'F-0001',
        disposition: 'addressed',
        supportingPartIds: ['repair'],
        verificationPartIds: [],
      }],
      blockers: [],
    }, ['F-0001', 'F-0002'], [part])).toThrow(/does not cover actionable finding "F-0002"/);

    expect(() => parseDecision({
      decision: 'complete',
      reasoning: 'duplicate coverage',
      parts: [],
      fixCoverage: ['F-0001', 'F-0001'].map((findingId) => ({
        findingId,
        disposition: 'addressed',
        supportingPartIds: ['repair'],
        verificationPartIds: [],
      })),
      blockers: [],
    }, ['F-0001'], [part])).toThrow(/fixCoverage contains duplicate finding "F-0001"/);

    const decision = parseDecision({
      decision: 'complete',
      reasoning: 'all fixed',
      parts: [],
      fixCoverage: ['F-0001', 'F-0002'].map((findingId) => ({
        findingId,
        disposition: 'addressed',
        supportingPartIds: ['repair'],
        verificationPartIds: [],
      })),
      blockers: [],
    }, ['F-0001', 'F-0002'], [part]);

    expect(decision.decision).toBe('complete');
  });

  it('rejects completion coverage that contradicts worker claims or verification checks', () => {
    const part = makePart('repair', ['F-0001']);
    const result = makeResult(part);
    const complete = {
      decision: 'complete' as const,
      reasoning: 'covered',
      parts: [] as [],
      fixCoverage: [{
        findingId: 'F-0001',
        disposition: 'disputed' as const,
        supportingPartIds: ['repair'],
        verificationPartIds: [],
      }],
      blockers: [] as string[],
    };

    expect(() => parseDecision(complete, ['F-0001'], [part], [result]))
      .toThrow(/is not eligible for disposition/);

    const addressed = {
      ...complete,
      fixCoverage: [{
        ...complete.fixCoverage[0]!,
        disposition: 'addressed' as const,
      }],
    };
    result.response.structuredOutput = {
      ...(result.response.structuredOutput as Record<string, unknown>),
      checks: [{ command: 'npm test', status: 'failed' }],
    };
    expect(() => parseDecision(addressed, ['F-0001'], [part], [result]))
      .toThrow(/contains a failed check/);
    result.response.structuredOutput = {
      ...(result.response.structuredOutput as Record<string, unknown>),
      checks: [],
    };
    expect(() => parseDecision(addressed, ['F-0001'], [part], [result]))
      .toThrow(/no passed verification check/);
  });

  it('does not allow an invalid completion claim to support a complete decision', () => {
    const part = makePart('invalid-complete-evidence', ['F-0001'], 'repair', ['src/owned']);
    const result = makeResult(part);
    result.response.structuredOutput = {
      findingOutcomes: [{
        findingId: 'F-0001',
        outcome: 'addressed',
        evidence: ['src/owned/a.ts:1'],
      }],
      changedPaths: ['src/outside.ts'],
      checks: [{ command: 'npm test', status: 'passed' }],
      summary: 'claimed complete',
    };
    let validationError: FindingContractTeamLeaderDecisionValidationError | undefined;
    try {
      parseDecision({
        decision: 'complete',
        reasoning: 'incorrectly uses an invalid claim',
        parts: [],
        fixCoverage: [{
          findingId: 'F-0001',
          disposition: 'addressed',
          supportingPartIds: [part.id],
          verificationPartIds: [part.id],
        }],
        blockers: [],
      }, ['F-0001'], [part], [result]);
    } catch (error) {
      if (error instanceof FindingContractTeamLeaderDecisionValidationError) {
        validationError = error;
      } else {
        throw error;
      }
    }

    expect(validationError?.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'evidence.invalid_part_claim',
      'evidence.unsupported_disposition',
      'evidence.ineligible_verification',
      'evidence.missing_passed_verification',
    ]));
    expect(validationError?.issues.map((issue) => issue.message).join('\n'))
      .toContain('Changed path is outside the part writePaths assignment');
  });

  it('collects independent completion evidence issues in one validation result', () => {
    const mismatchPart = makePart('mismatch', ['F-0001']);
    const failedPart = makePart('failed', ['F-0002']);
    const unverifiedPart = makePart('unverified', ['F-0003']);
    const mismatchResult = makeResult(mismatchPart);
    const failedResult = makeResult(failedPart);
    const unverifiedResult = makeResult(unverifiedPart);
    failedResult.response.structuredOutput = {
      ...(failedResult.response.structuredOutput as Record<string, unknown>),
      checks: [
        { command: 'npm test', status: 'passed' },
        { command: 'npm run lint', status: 'failed' },
      ],
    };
    unverifiedResult.response.structuredOutput = {
      ...(unverifiedResult.response.structuredOutput as Record<string, unknown>),
      checks: [{ command: 'npm test', status: 'not_run' }],
    };
    let validationError: FindingContractTeamLeaderDecisionValidationError | undefined;
    try {
      parseDecision({
        decision: 'complete',
        reasoning: 'invalid independent evidence',
        parts: [],
        fixCoverage: [
          {
            findingId: 'F-0001',
            disposition: 'disputed',
            supportingPartIds: ['mismatch'],
            verificationPartIds: ['mismatch'],
          },
          {
            findingId: 'F-0002',
            disposition: 'addressed',
            supportingPartIds: ['failed'],
            verificationPartIds: ['failed'],
          },
          {
            findingId: 'F-0003',
            disposition: 'addressed',
            supportingPartIds: ['unverified'],
            verificationPartIds: ['unverified'],
          },
        ],
        blockers: [],
      }, ['F-0001', 'F-0002', 'F-0003'], [mismatchPart, failedPart, unverifiedPart], [
        mismatchResult,
        failedResult,
        unverifiedResult,
      ]);
    } catch (error) {
      if (error instanceof FindingContractTeamLeaderDecisionValidationError) {
        validationError = error;
      } else {
        throw error;
      }
    }

    expect(validationError?.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'evidence.unsupported_disposition',
      'evidence.failed_check',
      'evidence.missing_passed_verification',
      'evidence.ineligible_verification',
    ]));
  });

  it('builds decision digests independent of reasoning and semantic array order', () => {
    const left = createFindingContractRejectedDecisionDigest({
      decision: 'complete',
      reasoning: 'first wording',
      parts: [],
      fixCoverage: [
        {
          findingId: 'F-0002',
          disposition: 'addressed',
          supportingPartIds: ['b', 'a'],
          verificationPartIds: ['v2', 'v1'],
        },
        {
          findingId: 'F-0001',
          disposition: 'disputed',
          supportingPartIds: ['d'],
          verificationPartIds: ['d'],
        },
      ],
      blockers: [],
    });
    const right = createFindingContractRejectedDecisionDigest({
      blockers: [],
      fixCoverage: [
        {
          verificationPartIds: ['d'],
          supportingPartIds: ['d'],
          disposition: 'disputed',
          findingId: 'F-0001',
        },
        {
          verificationPartIds: ['v1', 'v2'],
          supportingPartIds: ['a', 'b'],
          disposition: 'addressed',
          findingId: 'F-0002',
        },
      ],
      parts: [],
      reasoning: 'different wording',
      decision: 'complete',
    });

    expect(right.hash).toBe(left.hash);
  });

  it('keeps decision digest hashes canonical beyond the visible summary limit', () => {
    const parts = Array.from({ length: 101 }, (_, index) => ({
      id: `part-${String(index).padStart(3, '0')}`,
      findingContract: {
        findingIds: [`F-${String(index).padStart(4, '0')}`],
        role: 'repair',
      },
    }));
    const reordered = [...parts].reverse();
    const left = createFindingContractRejectedDecisionDigest({
      decision: 'continue',
      parts,
      fixCoverage: [],
      blockers: [],
    });
    const right = createFindingContractRejectedDecisionDigest({
      decision: 'continue',
      parts: reordered,
      fixCoverage: [],
      blockers: [],
    });
    const changed = createFindingContractRejectedDecisionDigest({
      decision: 'continue',
      parts: parts.map((part, index) => (
        index === 100 ? { ...part, id: 'part-changed-after-visible-limit' } : part
      )),
      fixCoverage: [],
      blockers: [],
    });

    expect(right.hash).toBe(left.hash);
    expect(changed.hash).not.toBe(left.hash);
    expect(left.assignments).toHaveLength(100);
  });

  it('does not collapse distinct long decision values in canonical digest hashes', () => {
    const prefix = 'x'.repeat(600);
    const left = createFindingContractRejectedDecisionDigest({
      decision: 'replan',
      parts: [],
      fixCoverage: [],
      blockers: [`${prefix}A`],
    });
    const right = createFindingContractRejectedDecisionDigest({
      decision: 'replan',
      parts: [],
      fixCoverage: [],
      blockers: [`${prefix}B`],
    });

    expect(right.hash).not.toBe(left.hash);
    expect(left.blockers[0]?.length).toBe(500);
  });

  it('collects every independent continue part-batch violation', () => {
    const first = makePart('first-invalid', ['F-9999']);
    const second = makePart('second-invalid', ['F-9999'], 'repair', ['src/first-invalid.ts']);
    const root = makePart('root-invalid', ['F-9999'], 'repair', ['src']);
    let validationError: FindingContractTeamLeaderDecisionValidationError | undefined;
    try {
      parseDecision({
        decision: 'continue',
        reasoning: 'contains several independent violations',
        parts: [first, second, root],
        fixCoverage: [],
        blockers: [],
      }, ['F-0001'], []);
    } catch (error) {
      if (error instanceof FindingContractTeamLeaderDecisionValidationError) {
        validationError = error;
      } else {
        throw error;
      }
    }

    expect(validationError?.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'reference.unknown_finding',
      'decision_contract.part_batch.duplicate_repair_assignment',
      'decision_contract.part_batch.overlapping_write_path',
    ]));
    expect(validationError?.issues.filter((issue) => issue.code === 'reference.unknown_finding'))
      .toHaveLength(3);
    expect(validationError?.issues.filter(
      (issue) => issue.code === 'decision_contract.part_batch.overlapping_write_path',
    )).toHaveLength(3);
  });

  it('uses the same evidence classification for support and verification guidance', () => {
    const eligiblePart = makePart('eligible', ['F-0001']);
    const failedPart = makePart('failed-guidance', ['F-0001'], 'verify');
    const eligibleResult = makeResult(eligiblePart);
    const failedResult = makeResult(failedPart);
    failedResult.response.structuredOutput = {
      ...(failedResult.response.structuredOutput as Record<string, unknown>),
      checks: [{ command: 'npm test', status: 'failed' }],
    };

    const evidence = buildFindingContractDecisionEvidenceSnapshot(
      [eligibleResult, failedResult],
      ['F-0001'],
    );

    expect(evidence.findings).toEqual([{
      findingId: 'F-0001',
      eligibleSupportingPartIds: {
        addressed: ['eligible'],
        disputed: [],
      },
      eligibleVerificationPartIds: ['eligible'],
      completeFeasible: true,
    }]);
    expect(evidence.entries.find((entry) => entry.partId === 'failed-guidance'))
      .toEqual(expect.objectContaining({
        usableAsSupportFor: [],
        usableAsVerification: false,
        supportIneligibleReasons: expect.arrayContaining(['failed_check']),
        verificationIneligibleReasons: expect.arrayContaining(['failed_check']),
      }));
  });

  it('propagates unexpected evidence parser failures instead of classifying them as invalid claims', () => {
    const part = makePart('unexpected-parser-failure', ['F-0001']);
    const result = makeResult(part);
    Object.defineProperty(result.response, 'structuredOutput', {
      get: () => {
        throw new TypeError('unexpected parser bug');
      },
    });

    expect(() => buildFindingContractDecisionEvidenceSnapshot([result], ['F-0001']))
      .toThrow(new TypeError('unexpected parser bug'));
  });

  it('rejects non-done support and verification evidence', () => {
    const part = makePart('errored', ['F-0001']);
    const result = makeResult(part);
    result.response.status = 'error';
    result.response.structuredOutput = undefined;
    result.response.error = 'worker failed';

    let validationError: FindingContractTeamLeaderDecisionValidationError | undefined;
    try {
      parseDecision({
        decision: 'complete',
        reasoning: 'incorrectly treating an errored part as evidence',
        parts: [],
        fixCoverage: [{
          findingId: 'F-0001',
          disposition: 'addressed',
          supportingPartIds: ['errored'],
          verificationPartIds: ['errored'],
        }],
        blockers: [],
      }, ['F-0001'], [part], [result]);
    } catch (error) {
      if (error instanceof FindingContractTeamLeaderDecisionValidationError) {
        validationError = error;
      } else {
        throw error;
      }
    }

    expect(validationError?.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'evidence.unsupported_disposition',
      'evidence.ineligible_verification',
      'evidence.missing_passed_verification',
    ]));
    expect(validationError?.issues.map((issue) => issue.message).join('\n'))
      .toContain('part_status:error');
  });

  it('accepts no-pass support when a separate eligible verifier passed', () => {
    const supportPart = makePart('support-only', ['F-0001']);
    const verifierPart = makePart('verifier', ['F-0001'], 'verify', []);
    const supportResult = makeResult(supportPart);
    const verifierResult = makeResult(verifierPart);
    supportResult.response.structuredOutput = {
      ...(supportResult.response.structuredOutput as Record<string, unknown>),
      checks: [],
    };
    verifierResult.response.structuredOutput = {
      ...(verifierResult.response.structuredOutput as Record<string, unknown>),
      changedPaths: [],
    };

    const decision = parseDecision({
      decision: 'complete',
      reasoning: 'support and verification are supplied by separate parts',
      parts: [],
      fixCoverage: [{
        findingId: 'F-0001',
        disposition: 'addressed',
        supportingPartIds: ['support-only'],
        verificationPartIds: ['verifier'],
      }],
      blockers: [],
    }, ['F-0001'], [supportPart, verifierPart], [supportResult, verifierResult]);

    expect(decision.decision).toBe('complete');
  });

  it('accepts disputed completion coverage backed by file evidence and a passed check', () => {
    const part = makePart('diagnose', ['F-0001'], 'diagnose', []);
    const result = makeResult(part);
    result.response.structuredOutput = {
      findingOutcomes: [{
        findingId: 'F-0001',
        outcome: 'disputed',
        evidence: ['src/current.ts:42'],
      }],
      changedPaths: [],
      checks: [{ command: 'inspect source', status: 'passed' }],
      summary: 'The finding does not match the current source.',
    };
    const decision = parseDecision({
      decision: 'complete',
      reasoning: 'The finding is disproven by current source evidence.',
      parts: [],
      fixCoverage: [{
        findingId: 'F-0001',
        disposition: 'disputed',
        supportingPartIds: ['diagnose'],
        verificationPartIds: ['diagnose'],
      }],
      blockers: [],
    }, ['F-0001'], [part], [result]);

    if (decision.decision !== 'complete') throw new Error('Expected complete decision');
  });

  it('builds a compact aggregate without raw part content and preserves disputes', () => {
    const part = makePart('dispute', ['F-0001'], 'diagnose', []);
    const result = makeResult(part, 'finding is stale');
    result.response.structuredOutput = {
      findingOutcomes: [{
        findingId: 'F-0001',
        outcome: 'disputed',
        evidence: ['src/current.ts:42'],
      }],
      changedPaths: [],
      checks: [{ command: 'inspect source', status: 'passed' }],
      summary: 'finding is stale',
    };
    result.findingContractClaim = result.response.structuredOutput as unknown as NonNullable<
      PartResult['findingContractClaim']
    >;
    const index = buildFindingContractPartIndexEntry(result);
    const content = buildFindingContractTeamLeaderAggregatedContent({
      decision: 'complete',
      reasoning: 'covered',
      parts: [],
      fixCoverage: [{
        findingId: 'F-0001',
        disposition: 'disputed',
        supportingPartIds: ['dispute'],
        verificationPartIds: ['dispute'],
      }],
    }, [index], [{ path: '.takt/runs/run/context/a.json', sha256: 'abc', bytes: 10 }]);

    expect(content).toContain('## Disputed Findings');
    expect(content).toContain('- findingId: F-0001');
    expect(content).toContain('src/current.ts:42');
    expect(content).not.toContain('raw response for dispute');
  });

  it('does not publish a stale worker dispute when final coverage is addressed', () => {
    const part = makePart('diagnose', ['F-0001'], 'diagnose', []);
    const result = makeResult(part, 'initial dispute');
    result.response.structuredOutput = {
      findingOutcomes: [{
        findingId: 'F-0001',
        outcome: 'disputed',
        evidence: ['src/current.ts:42'],
      }],
      changedPaths: [],
      checks: [{ command: 'inspect source', status: 'passed' }],
      summary: 'initial dispute',
    };
    result.findingContractClaim = result.response.structuredOutput as unknown as NonNullable<
      PartResult['findingContractClaim']
    >;
    const content = buildFindingContractTeamLeaderAggregatedContent({
      decision: 'complete',
      reasoning: 'later repair addressed it',
      parts: [],
      fixCoverage: [{
        findingId: 'F-0001',
        disposition: 'addressed',
        supportingPartIds: ['repair'],
        verificationPartIds: [],
      }],
    }, [buildFindingContractPartIndexEntry(result)], []);

    expect(content).not.toContain('## Disputed Findings');
  });

  it('passes only the latest raw batch and a compact index into feedback', () => {
    const prompt = buildMorePartsPrompt(
      'original task',
      [{
        id: 'latest',
        title: 'Latest',
        status: 'done',
        content: `LATEST_RAW_TOKEN${'x'.repeat(20_000)}`,
        findingContractClaim: {
          id: 'latest',
          title: 'Latest',
          role: 'repair',
          findingIds: ['F-0001'],
          status: 'done',
          summary: 'latest compact claim',
          outcomes: [],
          checks: { passed: 1, failed: 0, notRun: 0 },
        },
      }],
      ['earlier', 'latest'],
      'ja',
      {
        targetFindingIds: ['F-0001'],
        actionableFindings: '{"open":[{"id":"F-0001"}]}',
        completedPartIndex: [{
          findingId: 'F-0001',
          partId: 'earlier',
          title: 'Earlier',
          role: 'repair',
          status: 'done',
          checks: { passed: 1, failed: 0, notRun: 0 },
        }],
        plannedParts: [],
        evidence: buildFindingContractDecisionEvidenceSnapshot([], ['F-0001']),
        recovery: {
          boundaryKind: 'decision',
          attempt: 2,
          maxCalls: 100,
          mode: 'normal',
          latestRejection: {
            attempt: 1,
            mode: 'normal',
            issues: [{
              code: 'decision_contract.continue_fix_coverage',
              category: 'decision_contract',
              path: 'fixCoverage',
              message: 'continue decision must not include fixCoverage\n## injected heading',
              boundaryKind: 'decision',
              retryability: 'corrective_retry',
            }],
            issueFingerprint: 'issue-hash',
            outputDigest: {
              hash: 'decision-hash',
              decision: 'continue',
              partIds: [],
              assignments: [],
              fixCoverage: [],
              blockers: [],
            },
            repeatCount: 1,
          },
          recentRejectedOutputs: [],
          issueHistory: [],
        },
      },
    );

    expect(prompt).toContain('LATEST_RAW_TOKEN');
    expect(prompt).toContain('"partId": "latest"');
    expect(prompt).toContain('[truncated; full response is in the audit artifact]');
    expect(prompt).not.toContain('x'.repeat(13_000));
    expect(prompt).toContain('"partId": "earlier"');
    expect(prompt).not.toContain('EARLIER_RAW_TOKEN');
    expect(prompt).toContain('"attempt": 1');
    expect(prompt).toContain('fixCoverage\\n## injected heading');
    expect(prompt).not.toContain('\n## injected heading');
  });

  it('keeps strict recovery guidance bounded and preserves continue as the repairable path', () => {
    const long = '\\"'.repeat(5_000);
    const evidence = buildFindingContractDecisionEvidenceSnapshot([], Array.from(
      { length: 100 },
      (_, index) => `${long}-${index}`,
    ));
    const issue = {
      boundaryKind: 'decision' as const,
      code: long,
      category: 'evidence' as const,
      path: long,
      message: long,
      findingId: long,
      partId: long,
      retryability: 'corrective_retry' as const,
    };
    const digest = createFindingContractRejectedDecisionDigest({
      decision: long,
      parts: Array.from({ length: 101 }, (_, index) => ({
        id: `${long}-${index}`,
        findingContract: {
          findingIds: Array.from({ length: 20 }, (_, findingIndex) => (
            `${long}-${index}-${findingIndex}`
          )),
          role: long,
        },
      })),
      fixCoverage: Array.from({ length: 20 }, (_, index) => ({
        findingId: `${long}-${index}`,
        disposition: 'addressed',
        supportingPartIds: Array.from({ length: 20 }, (_, partIndex) => (
          `${long}-support-${index}-${partIndex}`
        )),
        verificationPartIds: Array.from({ length: 20 }, (_, partIndex) => (
          `${long}-verify-${index}-${partIndex}`
        )),
      })),
      blockers: [long],
    });
    const recovery = {
      boundaryKind: 'decision' as const,
      attempt: 4,
      maxCalls: 100,
      mode: 'strict' as const,
      strictReason: 'normal_attempts_exhausted' as const,
      latestRejection: {
        attempt: 3,
        mode: 'normal',
        issues: Array.from({ length: 100 }, () => issue),
        issueFingerprint: long,
        outputDigest: digest,
        repeatCount: 1,
      },
      recentRejectedOutputs: [digest, digest, digest],
      issueHistory: Array.from({ length: 20 }, (_, index) => ({
        fingerprint: `${long}-${index}`,
        occurrenceCount: 1,
        firstAttempt: index + 1,
        lastAttempt: index + 1,
        issues: Array.from({ length: 100 }, () => issue),
      })),
    };
    const sections = buildFindingContractRecoveryPromptSections('ja', recovery, evidence);
    const { strictReason: _strictReason, ...recoveryWithoutStrictReason } = recovery;
    const normalSections = buildFindingContractRecoveryPromptSections('ja', {
      ...recoveryWithoutStrictReason,
      mode: 'normal',
    }, evidence);
    const serialized = sections.join('\n');

    expect(serialized.length).toBeLessThan(70_000);
    expect(normalSections.join('\n').length).toBeLessThan(70_000);
    expect(serialized).toContain('追加作業で解消可能なら');
    expect(serialized).toContain('continue');
    expect(serialized).toContain('実際のblockerがある場合だけreplan');
    expect(serialized).not.toContain(long);
  });

  it('classifies decision and completion evidence violations as retryable validation errors', () => {
    const continuePart = makePart('continue-repair', ['F-0001']);
    let continueError: unknown;
    try {
      parseDecision({
        decision: 'continue',
        reasoning: 'invalid coverage on continue',
        parts: [continuePart],
        fixCoverage: [{
          findingId: 'F-0001',
          disposition: 'addressed',
          supportingPartIds: ['continue-repair'],
          verificationPartIds: [],
        }],
        blockers: [],
      }, ['F-0001'], []);
    } catch (error) {
      continueError = error;
    }
    expect(continueError).toBeInstanceOf(FindingContractTeamLeaderDecisionValidationError);
    expect(continueError).toEqual(expect.objectContaining({
      message: 'Finding Contract Team Leader continue decision must not include fixCoverage',
    }));

    const part = makePart('repair', ['F-0001']);
    const result = makeResult(part);
    const complete = {
      decision: 'complete' as const,
      reasoning: 'unsupported',
      parts: [] as [],
      fixCoverage: [{
        findingId: 'F-0001',
        disposition: 'disputed' as const,
        supportingPartIds: ['repair'],
        verificationPartIds: [],
      }],
      blockers: [] as string[],
    };
    expect(() => parseDecision(complete, ['F-0001'], [part], [result]))
      .toThrow(FindingContractTeamLeaderDecisionValidationError);
  });

  it('bounds raw content across the entire latest batch', () => {
    const results = ['A', 'B', 'C'].map((token, index) => ({
      id: `part-${index}`,
      title: `Part ${index}`,
      status: 'done',
      content: `${token}_RAW_TOKEN${token.repeat(12_000)}`,
      findingContractClaim: buildFindingContractPartIndexEntry(
        makeResult(makePart(`part-${index}`, [`F-000${index + 1}`])),
      ),
    }));

    const prompt = buildMorePartsPrompt('task', results, results.map((result) => result.id), 'en', {
      targetFindingIds: ['F-0001', 'F-0002', 'F-0003'],
      actionableFindings: '{"open":[]}',
      completedPartIndex: [],
      plannedParts: [],
      evidence: buildFindingContractDecisionEvidenceSnapshot([], ['F-0001', 'F-0002', 'F-0003']),
    });

    expect(prompt).toContain('A_RAW_TOKEN');
    expect(prompt).toContain('B_RAW_TOKEN');
    expect(prompt).not.toContain('C_RAW_TOKEN');
    expect(prompt).toContain('[omitted from prompt; full response is in the audit artifact]');
    expect(prompt).toContain('"findingId": "F-0003"');
  });

  it('writes attempt-scoped atomic audit artifacts with digest and byte length', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-team-leader-artifact-'));
    try {
      const runPaths = buildRunPaths(cwd, 'run-1');
      mkdirSync(runPaths.contextAbs, { recursive: true });
      const result = makeResult(makePart('repair', ['F-0001']));
      const reference = writeTeamLeaderPartArtifact({
        runPaths,
        stepName: '../../fix',
        attemptId: '0002-test-attempt',
        batchNumber: 3,
        partIndex: 0,
        result,
      });

      expect(reference.path).toContain('context/team_leader/_.._fix/attempt-0002-test-attempt/batch-0003/');
      const content = readFileSync(join(cwd, reference.path), 'utf8');
      expect(reference.bytes).toBe(Buffer.byteLength(content));
      expect(reference.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(content).toContain('raw response for repair');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('keeps lossy-normalized part IDs in distinct artifact files', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-team-leader-artifact-collision-'));
    try {
      const runPaths = buildRunPaths(cwd, 'run-1');
      mkdirSync(runPaths.contextAbs, { recursive: true });
      const references = ['a/b', 'a?b'].map((id, partIndex) => writeTeamLeaderPartArtifact({
        runPaths,
        stepName: 'fix',
        attemptId: '0001-test-attempt',
        batchNumber: 1,
        partIndex,
        result: makeResult(makePart(id, ['F-0001'], 'repair', ['src/artifact.ts'])),
      }));

      expect(new Set(references.map((reference) => reference.path))).toHaveLength(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('bounds artifact filenames derived from long part IDs', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-team-leader-artifact-long-id-'));
    try {
      const runPaths = buildRunPaths(cwd, 'run-1');
      mkdirSync(runPaths.contextAbs, { recursive: true });
      const reference = writeTeamLeaderPartArtifact({
        runPaths,
        stepName: 'fix',
        attemptId: '0001-test-attempt',
        batchNumber: 1,
        partIndex: 0,
        result: makeResult(makePart('part-'.repeat(100), ['F-0001'])),
      });

      expect(readFileSync(join(cwd, reference.path), 'utf8')).toContain('part-part-part');
      expect(reference.path.split('/').at(-1)?.length).toBeLessThan(128);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
