import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFindingContractPartIndexEntry,
  parseFindingContractPartCompletionClaim,
  parseFindingContractPartDefinition,
  buildLatestFindingContractDigests,
  validateFindingContractPartBatch,
} from '../core/workflow/team-leader-finding-contract.js';
import {
  parseFindingContractTeamLeaderDecision,
  validateFindingContractCompletionEvidence,
} from '../core/workflow/team-leader-finding-contract-decision.js';
import { buildFindingContractTeamLeaderAggregatedContent } from '../core/workflow/engine/team-leader-aggregation.js';
import type { PartDefinition, PartResult } from '../core/models/types.js';
import { buildMorePartsPrompt } from '../agents/team-leader-structured-output.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { writeTeamLeaderPartArtifact } from '../core/workflow/engine/team-leader-artifacts.js';

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
  return {
    part,
    response: {
      persona: `fix.${part.id}`,
      status: 'done',
      content: `raw response for ${part.id}`,
      structuredOutput: {
        findingOutcomes: part.findingContract.findingIds.map((findingId) => ({
          findingId,
          outcome: 'addressed',
          evidence: [`src/${part.id}.ts:10`],
        })),
        changedPaths: [`src/${part.id}.ts`],
        checks: [{ command: 'npm test', status: 'passed' }],
        summary,
      },
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    },
  };
}

describe('Finding Contract Team Leader contract', () => {
  it('parses a scoped assignment and normalizes portable paths', () => {
    const part = parseFindingContractPartDefinition({
      id: 'repair-api',
      title: 'Repair API',
      instruction: 'repair it',
      findingContract: {
        findingIds: ['F-0001'],
        role: 'repair',
        writePaths: ['./src\\api.ts'],
        readPaths: ['src/types.ts'],
      },
    }, 0);

    expect(part.findingContract).toEqual({
      findingIds: ['F-0001'],
      role: 'repair',
      writePaths: ['src/api.ts'],
      readPaths: ['src/types.ts'],
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
    expect(() => parseFindingContractTeamLeaderDecision({
      decision: 'continue',
      reasoning: 'retry after blocked claim',
      parts: [makePart('retry', ['F-0001'])],
      fixCoverage: [],
      blockers: [],
    }, ['F-0001'], ['first'], [makePart('first', ['F-0001'])])).not.toThrow();
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
    expect(() => parseFindingContractTeamLeaderDecision({
      decision: 'continue',
      reasoning: 'mixed IDs',
      parts: [makePart('existing', ['F-0001']), makePart('new', ['F-0002'])],
      fixCoverage: [],
      blockers: [],
    }, ['F-0001', 'F-0002'], ['existing'], [])).toThrow(/reuses existing part ID "existing"/);
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
    expect(() => parseFindingContractTeamLeaderDecision({
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
    }, ['F-0001', 'F-0002'], ['repair'], [part])).toThrow(/does not cover actionable finding "F-0002"/);

    expect(() => parseFindingContractTeamLeaderDecision({
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
    }, ['F-0001'], ['repair'], [part])).toThrow(/fixCoverage contains duplicate finding "F-0001"/);

    const decision = parseFindingContractTeamLeaderDecision({
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
    }, ['F-0001', 'F-0002'], ['repair'], [part]);

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
    };

    expect(() => validateFindingContractCompletionEvidence(complete, [result]))
      .toThrow(/no supporting part claim/);

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
    expect(() => validateFindingContractCompletionEvidence(addressed, [result]))
      .toThrow(/contains a failed check/);
    result.response.structuredOutput = {
      ...(result.response.structuredOutput as Record<string, unknown>),
      checks: [],
    };
    expect(() => validateFindingContractCompletionEvidence(addressed, [result]))
      .toThrow(/no passed verification check/);
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
    const decision = parseFindingContractTeamLeaderDecision({
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
    }, ['F-0001'], ['diagnose'], [part]);

    if (decision.decision !== 'complete') throw new Error('Expected complete decision');
    expect(() => validateFindingContractCompletionEvidence(decision, [result])).not.toThrow();
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
        previouslyPlannedParts: [],
      },
    );

    expect(prompt).toContain('LATEST_RAW_TOKEN');
    expect(prompt).toContain('"partId": "latest"');
    expect(prompt).toContain('[truncated; full response is in the audit artifact]');
    expect(prompt).not.toContain('x'.repeat(13_000));
    expect(prompt).toContain('"partId": "earlier"');
    expect(prompt).not.toContain('EARLIER_RAW_TOKEN');
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
      previouslyPlannedParts: [],
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
        result: makeResult(makePart(id, ['F-0001'])),
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
