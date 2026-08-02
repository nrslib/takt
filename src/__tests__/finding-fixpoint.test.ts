/**
 * provisional fixpoint 判定（対策バッチ B1: raw finding 解釈梯子の収束性
 * 対策）の単体・往復ラウンドテスト。
 *
 * - 単体: computeFixpointSnapshot / attachFixpointState の純粋なロジック
 * - 往復ラウンド: runFindingManagerForStep を実際に複数回呼び、
 *   findings-manager の1ラウンド = 1回の reconcile という前提のもとで、
 *   fixpoint.reached がラウンド跨ぎで正しく機械判定されることを検証する
 *   （実測形の再現、同一 run の process 再起動、新観測による解消を含む）
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentResponse, WorkflowStep } from '../core/models/types.js';
import type { FindingLedger, FindingLedgerEntry, RawFinding } from '../core/workflow/findings/types.js';
import {
  attachFixpointState as attachFixpointStateWithCwd,
  computeFixpointSnapshot as computeFixpointSnapshotWithCwd,
} from '../core/workflow/findings/fixpoint.js';
import { runFindingManagerForStep, type FindingManagerSubStepResult } from '../core/workflow/findings/manager-runner.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import { processInterpretationLiveClaims } from '../core/workflow/findings/interpretation-live-claims.js';
import { buildFindingsRuleContext as buildFindingsRuleContextWithCwd } from '../core/workflow/findings/context.js';
import {
  verifiedSourceQuoteFields,
} from './helpers/finding-evidence.js';
import { createFindingManagerPublicationDouble, RevisionedFindingLedgerTestRepository } from './helpers/finding-manager-publication.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
  emptyFindingAuthorityProjection,
  reviewerRawExtractionFixture,
} from './helpers/finding-lifecycle-fixture.js';
import { findingReviewPublicationFixture } from './helpers/finding-review-publication.js';
import { findingManagerTaskResponse } from './helpers/finding-manager-task-response.js';
import { initializeGitFixture } from './helpers/git-fixture.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);

function computeFixpointSnapshot(ledger: FindingLedger) {
  return computeFixpointSnapshotWithCwd(ledger, process.cwd());
}

function attachFixpointState(previous: FindingLedger, next: FindingLedger): FindingLedger {
  return attachFixpointStateWithCwd(previous, next, process.cwd());
}

function buildFindingsRuleContext(ledger: FindingLedger) {
  return buildFindingsRuleContextWithCwd(ledger, process.cwd());
}

beforeEach(() => {
  executeAgentMock.mockReset();
});

/**
 * A generic mockImplementation shared across multiple rounds/local ids:
 * tries each candidate local id in order and returns the one in the instruction.
 */
function extractResidualRawIdFromEitherLocalId(instruction: string, localIds: readonly string[]): string {
  for (const localId of localIds) {
    const matches = [...instruction.matchAll(/"rawFindingId":\s*"([^"]+)"/g)].map((match) => match[1]!);
    const found = matches.find((id) => id.endsWith(`:${localId}`));
    if (found !== undefined) {
      return found;
    }
  }
  throw new Error(`Test setup error: none of [${localIds.join(', ')}] found in instruction: ${instruction}`);
}

// ---------------------------------------------------------------------------
// 純粋関数テスト: computeFixpointSnapshot / attachFixpointState
// ---------------------------------------------------------------------------

function observation(runId = 'run-1'): { runId: string; stepName: string; timestamp: string } {
  return { runId, stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' };
}

function provisionalFinding(
  overrides: Pick<FindingLedgerEntry, 'revision'> & Partial<Omit<FindingLedgerEntry, 'revision'>>,
): FindingLedgerEntry {
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    target: null,
    targetIdentityHash: null,
    claimIdentityHash: null,
    semanticClaimIdentityHash: null,
    severity: 'high',
    title: 'Hallucinated issue',
    evidenceIds: [],
    reviewers: ['arch-review'],
    rawFindingIds: ['raw-1'],
    firstSeen: observation(),
    lastSeen: observation(),
    provisional: {
      kind: 'raw-adjudication-unresolved',
      stableKey: 'stable-key-a',
      lineageKey: 'lineage-a',
      sourceRawFindingIds: ['raw-1'],
      reason: 'No mechanically verifiable evidence was supplied',
      firstObservedAt: observation(),
      lastObservedAt: observation(),
      gateEffect: 'block',
    },
    ...overrides,
  };
}

function substantiveFinding(
  overrides: Pick<FindingLedgerEntry, 'revision'> & Partial<Omit<FindingLedgerEntry, 'revision'>>,
): FindingLedgerEntry {
  const finding = {
    id: 'F-0002',
    status: 'open',
    lifecycle: 'new',
    severity: 'medium',
    title: 'Real issue',
    evidenceIds: [],
    reviewers: ['arch-review'],
    rawFindingIds: ['raw-2'],
    firstSeen: observation(),
    lastSeen: observation(),
    ...overrides,
  };
  const raw = canonicalRawFindingFixture({
    rawFindingId: finding.rawFindingIds[0] ?? `raw-${finding.id}`,
    stepName: 'reviewers',
    reviewer: finding.reviewers[0] ?? 'arch-review',
    familyTag: 'bug',
    severity: finding.severity,
    title: finding.title,
    description: finding.description ?? finding.title,
    suggestion: finding.suggestion ?? null,
    relation: 'new',
    targetFindingId: null,
    evidence: [],
    target: finding.target,
  });
  return {
    ...finding,
    target: raw.target,
    targetIdentityHash: raw.targetIdentityHash,
    claimIdentityHash: raw.claimIdentityHash,
    semanticClaimIdentityHash: raw.semanticClaimIdentityHash,
  };
}

function ledger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return authorizeFindingLedgerFixture({
    workflowName: 'peer-review',
    nextId: 3,
    updatedAt: '2026-07-01T00:00:00.000Z',
    findings: [],
    evidenceRecords: [],
    rawFindings: [],
    conflicts: [],
    ...emptyFindingAuthorityProjection(),
    ...overrides,
  });
}

function fixpointRawFinding(overrides: Partial<RawFinding> = {}): RawFinding {
  const base = canonicalRawFindingFixture({
    rawFindingId: 'raw-c1',
    stepName: 'reviewers',
    reviewer: 'arch-review',
    familyTag: 'bug',
    severity: 'high',
    title: 'Conflicting claim',
    description: 'One reviewer says X, another says Y.',
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    evidence: [],
  });
  const {
    targetIdentityHash: _targetIdentityHash,
    claimIdentityHash: _claimIdentityHash,
    semanticClaimIdentityHash: _semanticClaimIdentityHash,
    candidateIdentityHash: _candidateIdentityHash,
    target,
    sourceBinding,
    ...input
  } = { ...base, ...overrides };
  return canonicalRawFindingFixture({
    ...input,
    target,
    sourceBinding,
  });
}

describe('computeFixpointSnapshot', () => {
  it('returns empty arrays for an empty ledger', () => {
    const snapshot = computeFixpointSnapshot(ledger());
    expect(snapshot).toEqual({ provisionalKeys: [], substantiveEntries: [], unadjudicatedConflictEntries: [] });
  });

  it('collects only open findings with provisional metadata into provisionalKeys, keyed by stableKey', () => {
    const snapshot = computeFixpointSnapshot(ledger({
      findings: [
        provisionalFinding({ revision: 1, id: 'F-0001', provisional: { ...provisionalFinding({ revision: 1 }).provisional!, stableKey: 'key-a' } }),
        // resolved provisional は open ではないため除外される。
        provisionalFinding({ revision: 1,
          id: 'F-0003',
          status: 'resolved',
          provisional: { ...provisionalFinding({ revision: 1 }).provisional!, stableKey: 'key-b' },
        }),
      ],
    }));
    expect(snapshot.provisionalKeys).toEqual(['key-a']);
  });

  it('collects every non-provisional finding regardless of status into substantiveEntries as "id:status"', () => {
    const snapshot = computeFixpointSnapshot(ledger({
      findings: [
        substantiveFinding({ revision: 1, id: 'F-0002', status: 'open' }),
        substantiveFinding({ revision: 1, id: 'F-0004', status: 'resolved' }),
        // provisional は substantiveEntries から除外される。
        provisionalFinding({ revision: 1, id: 'F-0001' }),
      ],
    }));
    expect(snapshot.substantiveEntries).toEqual(['F-0002:open', 'F-0004:resolved']);
  });

  it('includes only active AND unadjudicated conflicts in unadjudicatedConflictEntries', () => {
    const withRaws = ledger({
      rawFindings: [fixpointRawFinding(), fixpointRawFinding({
        rawFindingId: 'raw-c2',
        title: 'Resolved conflicting claim',
        description: 'A separate conflict was already resolved.',
      })],
      conflicts: [
        {
          id: 'C-2BF240CC0BEC',
          status: 'active',
          findingIds: ['F-0002'],
          rawFindingIds: ['raw-c1'],
          description: 'Unresolved disagreement',
          firstSeen: observation(),
          lastSeen: observation(),
        },
        {
          id: 'C-4CE476E40661',
          status: 'resolved',
          findingIds: [],
          rawFindingIds: ['raw-c2'],
          description: 'Already resolved conflict',
          firstSeen: observation(),
          lastSeen: observation(),
          resolvedAt: observation().timestamp,
        },
      ],
      findings: [substantiveFinding({ revision: 1, id: 'F-0002' })],
    });
    const snapshot = computeFixpointSnapshot(withRaws);
    expect(snapshot.unadjudicatedConflictEntries).toHaveLength(1);
    expect(snapshot.unadjudicatedConflictEntries[0]).toMatch(/^C-2BF240CC0BEC:/);
  });

  it('changes the conflict fixpoint entry when the reviewed worktree changes', () => {
    const scopeCwd = mkdtempSync(join(tmpdir(), 'takt-fixpoint-scope-'));
    try {
      mkdirSync(join(scopeCwd, 'src'), { recursive: true });
      writeFileSync(join(scopeCwd, 'src', 'a.ts'), 'export const value = 1;\n');
      initializeGitFixture(scopeCwd, ['src/a.ts']);
      const withConflict = ledger({
        findings: [substantiveFinding({ revision: 1, id: 'F-0002' })],
        rawFindings: [fixpointRawFinding()],
        conflicts: [{
          id: 'C-2BF240CC0BEC',
          status: 'active',
          findingIds: ['F-0002'],
          rawFindingIds: ['raw-c1'],
          description: 'Unresolved disagreement',
          firstSeen: observation(),
          lastSeen: observation(),
        }],
      });
      const before = computeFixpointSnapshotWithCwd(withConflict, scopeCwd);

      writeFileSync(join(scopeCwd, 'src', 'a.ts'), 'export const value = 2;\n');
      const after = computeFixpointSnapshotWithCwd(withConflict, scopeCwd);

      expect(after.unadjudicatedConflictEntries).not.toEqual(before.unadjudicatedConflictEntries);
    } finally {
      rmSync(scopeCwd, { recursive: true, force: true });
    }
  });

  it('produces sorted, order-independent output (two different insertion orders yield the same snapshot)', () => {
    const a = provisionalFinding({ revision: 1, id: 'F-0001', provisional: { ...provisionalFinding({ revision: 1 }).provisional!, stableKey: 'zzz' } });
    const b = provisionalFinding({ revision: 1, id: 'F-0002', provisional: { ...provisionalFinding({ revision: 1 }).provisional!, stableKey: 'aaa' } });
    const snapshot1 = computeFixpointSnapshot(ledger({ findings: [a, b] }));
    const snapshot2 = computeFixpointSnapshot(ledger({ findings: [b, a] }));
    expect(snapshot1).toEqual(snapshot2);
    expect(snapshot1.provisionalKeys).toEqual(['aaa', 'zzz']);
  });

});

describe('attachFixpointState', () => {
  it('is never reached on the first comparable round (no previous snapshot), even if the round already has open provisional findings', () => {
    const previous = ledger();
    const next = ledger({ findings: [provisionalFinding({ revision: 1 })] });
    const result = attachFixpointState(previous, next);
    expect(result.fixpoint?.reached).toBe(false);
    expect(result.fixpoint?.snapshot.provisionalKeys).toEqual(['stable-key-a']);
  });

  it('reaches fixpoint when the round is identical to the previous round and has at least one open provisional', () => {
    const withProvisional = ledger({ findings: [provisionalFinding({ revision: 1 })] });
    const previous = attachFixpointState(ledger(), withProvisional);
    const next = attachFixpointState(previous, withProvisional);
    expect(next.fixpoint?.reached).toBe(true);
  });

  it('does not reach fixpoint when there is no open provisional finding, even if the snapshot is otherwise unchanged', () => {
    const clean = ledger({ findings: [substantiveFinding({ revision: 1, status: 'resolved' })] });
    const previous = attachFixpointState(ledger(), clean);
    const next = attachFixpointState(previous, clean);
    expect(next.fixpoint?.reached).toBe(false);
    expect(next.fixpoint?.snapshot.provisionalKeys).toEqual([]);
  });

  it('breaks fixpoint when the provisional key set changes (a different observation replaces the old one)', () => {
    const round1 = ledger({ findings: [provisionalFinding({ revision: 1, provisional: { ...provisionalFinding({ revision: 1 }).provisional!, stableKey: 'key-a' } })] });
    const round2 = ledger({ findings: [provisionalFinding({ revision: 1, provisional: { ...provisionalFinding({ revision: 1 }).provisional!, stableKey: 'key-b' } })] });
    const previous = attachFixpointState(ledger(), round1);
    const next = attachFixpointState(previous, round2);
    expect(next.fixpoint?.reached).toBe(false);
  });

  it('breaks fixpoint when a substantive finding changes status between rounds (e.g. resolved)', () => {
    const round1 = ledger({ findings: [provisionalFinding({ revision: 1 }), substantiveFinding({ revision: 1, status: 'open' })] });
    const round2 = ledger({ findings: [provisionalFinding({ revision: 1 }), substantiveFinding({ revision: 1, status: 'resolved' })] });
    const previous = attachFixpointState(ledger(), round1);
    const next = attachFixpointState(previous, round2);
    expect(next.fixpoint?.reached).toBe(false);
  });

  it('breaks fixpoint when a new substantive finding is created between rounds', () => {
    const round1 = ledger({ findings: [provisionalFinding({ revision: 1 })] });
    const round2 = ledger({ findings: [provisionalFinding({ revision: 1 }), substantiveFinding({ revision: 1 })] });
    const previous = attachFixpointState(ledger(), round1);
    const next = attachFixpointState(previous, round2);
    expect(next.fixpoint?.reached).toBe(false);
  });

  it('always advances the stored snapshot to the current round, so a THIRD identical round reaches fixpoint after a differing round 2', () => {
    const stable = ledger({ findings: [provisionalFinding({ revision: 1 })] });
    const changed = ledger({ findings: [provisionalFinding({ revision: 1 }), substantiveFinding({ revision: 1, status: 'open' })] });
    const round1 = attachFixpointState(ledger(), stable);
    const round2 = attachFixpointState(round1, changed);
    expect(round2.fixpoint?.reached).toBe(false);
    const round3 = attachFixpointState(round2, changed);
    expect(round3.fixpoint?.reached).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 往復ラウンドテスト: runFindingManagerForStep を実際に複数回呼ぶ
// ---------------------------------------------------------------------------

const FIXTURE_CWD = mkdtempSync(join(tmpdir(), 'takt-fixpoint-fixtures-'));
const REPORT_DIR = mkdtempSync(join(tmpdir(), 'takt-fixpoint-reports-'));
function writeFixtureFile(relativePath: string, lineCount: number): void {
  const fullPath = join(FIXTURE_CWD, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${Array.from({ length: lineCount }, (_, index) => `// line ${index + 1}`).join('\n')}\n`);
}
writeFixtureFile('src/real.ts', 60);
initializeGitFixture(FIXTURE_CWD, ['src/real.ts']);

afterAll(() => {
  rmSync(FIXTURE_CWD, { recursive: true, force: true });
  rmSync(REPORT_DIR, { recursive: true, force: true });
});

function makeRoundHarness(
  initialLedger: FindingLedger,
  runId = 'run-1',
  roundsCompleted = 0,
): {
  currentLedger: () => FindingLedger;
  run: (reviewerRawFindings: Array<Record<string, unknown>>) => ReturnType<typeof runFindingManagerForStep>;
} {
  const ledgerRepository = new RevisionedFindingLedgerTestRepository(
    authorizeFindingLedgerFixture(initialLedger),
  );
  const ledgerStore: FindingLedgerStore = {
    ledgerIdentity: '/test/finding-fixpoint/ledger.json',
    workflowName: 'peer-review',
    loadLedger: () => ledgerRepository.loadLedger(),
    updateLedger: (mutator) => ledgerRepository.updateLedger(mutator),
    interpretationLiveClaims: processInterpretationLiveClaims,
    saveLedgerSnapshot: () => {},
    saveRawFindings: () => {},
    saveManagerValidationReport: () => {},
    ...createFindingManagerPublicationDouble(
      (report) => join(REPORT_DIR, `findings-manager-validation.${report.stepName}.json`),
      ledgerRepository,
    ),
  };
  const optionsBuilder = {
    buildAgentOptions: () => ({}),
    resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
  };
  const stepExecutor = {
    buildPhase1Instruction: (instruction: string) => instruction,
    recordSynthesizedAgentUsage: () => {},
    normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
  };
  const parentStep: WorkflowStep = { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep;
  const contract = {
    manager: {
      persona: 'findings-manager',
      instruction: 'Reconcile findings.',
      outputContract: 'Return JSON.',
    },
  };
  let round = roundsCompleted;
  return {
    currentLedger: () => ledgerRepository.loadLedger(),
    run: (reviewerRawFindings) => {
      round += 1;
      const subResults: FindingManagerSubStepResult[] = [{
        subStep: { kind: 'agent', name: 'arch-review', persona: 'arch', edit: false } as WorkflowStep,
        publication: findingReviewPublicationFixture({
          scopeIdentity: ledgerStore.ledgerIdentity,
          parentStepName: parentStep.name,
          stepIteration: round,
          reviewerStepName: 'arch-review',
          rawFindings: reviewerRawFindings,
        }),
      }];
      return runFindingManagerForStep({
        contract: contract as never,
        ledgerStore,
        optionsBuilder: optionsBuilder as never,
        stepExecutor: stepExecutor as never,
        cwd: FIXTURE_CWD,
        parentStep,
        stepIteration: round,
        subResults,
        workflowName: 'peer-review',
        workflowTask: 'Review the implementation.',
        runId,
        callNamespace: '',
        timestamp: `2026-07-0${round}T00:00:00.000Z`,
        managerAuthority: 'standard',
      });
    },
  };
}

function hallucinatedRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const candidate = {
    rawFindingId: 'hallucinated-1',
    familyTag: 'bug',
    severity: 'high',
    title: 'Nonexistent file has a null check bug',
    description: 'This describes a bug in a file that does not exist in the reviewed tree.',
    suggestion: 'Add a null check.',
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: ['src/does-not-exist.ts'] },
    evidenceRequests: [{
      kind: 'file_quote',
      path: 'src/does-not-exist.ts',
      startLine: 5,
      endLine: 5,
    }],
    ...overrides,
  };
  return reviewerRawExtractionFixture({
    ...candidate,
    rawExcerpt: candidate.description as string,
  } as Parameters<typeof reviewerRawExtractionFixture>[0]);
}

/** Recovery が substantive outcome を返せない状況を再現する応答。 */
function instructionSectionJson<T>(instruction: string, heading: string): T {
  const start = instruction.indexOf(`${heading}\n`);
  const rest = instruction.slice(start + heading.length + 1);
  const match = /^(`{3,})json\n([\s\S]*?)\n\1/m.exec(rest);
  if (start < 0 || match?.[2] === undefined) {
    throw new Error(`Missing JSON block after ${heading}`);
  }
  return JSON.parse(match[2]) as T;
}

function unresolvedRecoveryResponse(
  instruction: string,
  rawFindingId: string,
): AgentResponse {
  if (instruction.includes('entity-binding contract')) {
    const manifest = instructionSectionJson<{
      taskId: string;
      ownedRawFindingIds: string[];
    }>(instruction, '## Task manifest');
    const observations = instructionSectionJson<Array<{
      rawFindingId: string;
      title: string | null;
      description: string | null;
    }>>(instruction, '## Raw observations');
    const projection = instructionSectionJson<{
      findings: Array<{ id: string; title: string; description: string }>;
    }>(instruction, '## Complete ledger entities for the supplied connected components');
    return {
      persona: 'findings-manager',
      status: 'done',
      content: '',
      structuredOutput: {
        taskId: manifest.taskId,
        decisions: observations.map((observation) => {
          const existing = projection.findings.find((finding) => (
            finding.title === observation.title
            && finding.description === observation.description
          ));
          return {
            rawFindingId: observation.rawFindingId,
            decision: existing === undefined ? 'new_entity' : 'bind_existing',
            findingId: existing?.id ?? '',
            groupRawFindingId: existing === undefined ? observation.rawFindingId : '',
            reason: existing === undefined
              ? 'This observation describes a distinct semantic entity.'
              : 'This observation describes the existing semantic entity.',
          };
        }),
      },
      timestamp: new Date('2026-07-01T00:00:01.000Z'),
    } as unknown as AgentResponse;
  }
  return findingManagerTaskResponse(instruction, {
    rawDecisions: [{
      decision: 'unsupported',
      rawFindingId,
      anchorRelevance: 'not_applicable',
      evidence: 'Cannot determine the identity of this re-report.',
    }],
    disputeDecisions: [],
    conflictDecisions: [],
    invalidateDecisions: [],
    duplicateDecisions: [],
    dismissDecisions: [],
  });
}

function resolutionAwareResponse(
  instruction: string,
  unresolvedRawFindingId: string,
): AgentResponse {
  if (instruction.includes('entity-binding contract')) {
    const response = unresolvedRecoveryResponse(instruction, unresolvedRawFindingId);
    if (instruction.includes(':confirm-1"')) {
      const output = response.structuredOutput as {
        decisions: Array<{
          rawFindingId: string;
          decision: string;
          findingId: string;
          groupRawFindingId: string;
          reason: string;
        }>;
      };
      output.decisions = output.decisions.map((decision) => (
        decision.rawFindingId.endsWith(':confirm-1')
          ? {
              ...decision,
              decision: 'bind_existing',
              findingId: 'F-0001',
              groupRawFindingId: '',
              reason: 'The lifecycle observation explicitly targets this existing finding.',
            }
          : decision
      ));
    }
    return response;
  }
  const manifest = instructionSectionJson<{
    rawFindings?: Array<{ rawFindingId: string }>;
  }>(instruction, '## Task manifest');
  const confirmation = manifest.rawFindings?.find((raw) => (
    raw.rawFindingId.endsWith(':confirm-1')
  ));
  if (confirmation === undefined) {
    return unresolvedRecoveryResponse(instruction, unresolvedRawFindingId);
  }
  const taskManifest = instructionSectionJson<{
    taskId: string;
    rawFindings: Array<{ rawFindingId: string; componentId: string }>;
  }>(instruction, '## Task manifest');
  return {
    persona: 'findings-manager',
    status: 'done',
    content: '',
    structuredOutput: {
      taskId: taskManifest.taskId,
      decisions: taskManifest.rawFindings.map((raw) => (
        raw.rawFindingId === confirmation.rawFindingId
          ? {
              rawFindingId: raw.rawFindingId,
              componentId: raw.componentId,
              decision: 'resolved',
              findingId: 'F-0001',
              evidence: 'The materialized quote satisfies the original failure mode and required fix.',
            }
          : {
              rawFindingId: raw.rawFindingId,
              componentId: raw.componentId,
              decision: 'unsupported',
              findingId: '',
              evidence: 'Cannot determine the identity of this re-report.',
            }
      )),
    },
    timestamp: new Date('2026-07-01T00:00:01.000Z'),
  } as unknown as AgentResponse;
}

function unverifiedClaimRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const candidate = {
    rawFindingId: 'ambiguous-1',
    familyTag: 'bug',
    severity: 'high',
    title: 'A claim without mechanical evidence',
    description: 'The reviewer supplied an explicit claim identity but no evidence.',
    suggestion: '',
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: ['src/real.ts'] },
    evidenceRequests: [],
    ...overrides,
  };
  return reviewerRawExtractionFixture({
    ...candidate,
    rawExcerpt: candidate.description as string,
  } as Parameters<typeof reviewerRawExtractionFixture>[0]);
}

describe('runFindingManagerForStep: failed file_quote evidence is isolated from admitted findings', () => {
  it('a nonexistent file_quote becomes an engine-gap provisional and needs no manager call', async () => {
    const harness = makeRoundHarness({
      workflowName: 'peer-review', nextId: 1, updatedAt: '2026-07-01T00:00:00.000Z',
      findings: [], evidenceRecords: [], rawFindings: [], conflicts: [],
    });

    const result = await harness.run([hallucinatedRaw()]);

    expect(executeAgentMock).not.toHaveBeenCalled();
    const ledger = harness.currentLedger();
    expect(ledger.findings).toHaveLength(1);
    const context = buildFindingsRuleContext(ledger);
    expect(context.provisional.count).toBe(1);
    expect(context.open.count).toBe(1);
    expect(context.reviewerAnomalies.count).toBe(0);
    expect(result.ledger.reviewerAnomalies).toBeUndefined();
  });
});

describe('runFindingManagerForStep across rounds: provisional fixpoint mechanics', () => {
  it('is not a fixpoint on the first round, even though a provisional is already open', async () => {
    const harness = makeRoundHarness({
      workflowName: 'peer-review', nextId: 1, updatedAt: '2026-07-01T00:00:00.000Z',
      findings: [], evidenceRecords: [], rawFindings: [], conflicts: [],
    });

    await harness.run([unverifiedClaimRaw()]);

    expect(buildFindingsRuleContext(harness.currentLedger()).provisional.fixpoint).toBe(false);
  });

  it('reaches fixpoint after bounded raw-adjudication recovery is exhausted and the claim stabilizes', async () => {
    const harness = makeRoundHarness({
      workflowName: 'peer-review', nextId: 1, updatedAt: '2026-07-01T00:00:00.000Z',
      findings: [], evidenceRecords: [], rawFindings: [], conflicts: [],
    });

    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromEitherLocalId(
        instruction as string,
        ['ambiguous-1', 'ambiguous-1-again', 'ambiguous-1-final', 'ambiguous-1-stable'],
      );
      return unresolvedRecoveryResponse(instruction as string, rawId);
    });
    await harness.run([unverifiedClaimRaw()]);
    await harness.run([unverifiedClaimRaw({ rawFindingId: 'ambiguous-1-again' })]);
    await harness.run([unverifiedClaimRaw({ rawFindingId: 'ambiguous-1-final' })]);
    await harness.run([unverifiedClaimRaw({ rawFindingId: 'ambiguous-1-stable' })]);

    const context = buildFindingsRuleContext(harness.currentLedger());
    expect(context.provisional.count).toBe(1);
    expect(context.provisional.fixpoint).toBe(true);
  });

  it('does not reach fixpoint when a different claim shows up on the second round instead', async () => {
    const harness = makeRoundHarness({
      workflowName: 'peer-review', nextId: 1, updatedAt: '2026-07-01T00:00:00.000Z',
      findings: [], evidenceRecords: [], rawFindings: [], conflicts: [],
    });

    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromEitherLocalId(instruction as string, ['ambiguous-1', 'ambiguous-2']);
      return unresolvedRecoveryResponse(instruction as string, rawId);
    });
    await harness.run([unverifiedClaimRaw()]);
    await harness.run([unverifiedClaimRaw({
      rawFindingId: 'ambiguous-2',
      title: 'A completely different unverified claim',
      description: 'This distinct explicit claim also has no evidence.',
    })]);

    // Both explicit claims stay open because neither has verified evidence.
    const context = buildFindingsRuleContext(harness.currentLedger());
    expect(context.provisional.count).toBe(2);
    expect(context.provisional.fixpoint).toBe(false);
  });

  it('a measured substantive finding resolving across rounds blocks fixpoint until the unverified claim stabilizes', async () => {
    // F-0001 pre-seeded as an already-open substantive finding (as if an
    // earlier round created it) — round 1 below is the round where it is
    // confirmed resolved by a semantically adjudicated resolution_confirmation.
    const seedRaw = canonicalRawFindingFixture({
      rawFindingId: 'raw-seed',
      stepName: 'reviewers',
      reviewer: 'arch-review',
      familyTag: 'bug',
      severity: 'medium',
      title: 'Real, fixable issue',
      description: 'A genuine issue that the fixer can and will resolve.',
      suggestion: null,
      relation: 'new',
      targetFindingId: null,
      target: { kind: 'code', paths: ['src/real.ts'] },
      evidence: [],
    });
    const harness = makeRoundHarness({
      workflowName: 'peer-review', nextId: 2, updatedAt: '2026-07-01T00:00:00.000Z',
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        target: seedRaw.target,
        targetIdentityHash: seedRaw.targetIdentityHash,
        claimIdentityHash: seedRaw.claimIdentityHash,
        semanticClaimIdentityHash: seedRaw.semanticClaimIdentityHash,
        severity: 'medium',
        title: 'Real, fixable issue',
        description: 'A genuine issue that the fixer can and will resolve.',
        evidenceIds: [],
        reviewers: ['arch-review'],
        rawFindingIds: ['raw-seed'],
        firstSeen: observation('run-0'),
        lastSeen: observation('run-0'),
        revision: 1,
      }],
      evidenceRecords: [],
      rawFindings: [seedRaw],
      conflicts: [],
    });

    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const taskInstruction = instruction as string;
      if (taskInstruction.includes('## Control task output override')) {
        return findingManagerTaskResponse(taskInstruction, {
          rawDecisions: [],
          disputeDecisions: [],
          conflictDecisions: [],
          invalidateDecisions: [],
          duplicateDecisions: [],
          dismissDecisions: [],
        });
      }
      const rawFindingIds = [...taskInstruction.matchAll(/"rawFindingId":\s*"([^"]+)"/g)]
        .map((match) => match[1]!);
      const rawId = rawFindingIds.find((id) => [
        'ambiguous-1',
        'ambiguous-1-r2',
        'ambiguous-1-r3',
        'ambiguous-1-r4',
      ].some((localId) => id.endsWith(`:${localId}`)))
        ?? rawFindingIds.find((id) => id.endsWith(':confirm-1'));
      if (rawId === undefined) {
        throw new Error(`Test setup error: no expected raw finding in instruction: ${taskInstruction}`);
      }
      return resolutionAwareResponse(taskInstruction, rawId);
    });

    // Round 1: the unverified claim is first observed; the substantive finding
    // is untouched this round (still open — carried over from the seed).
    await harness.run([unverifiedClaimRaw()]);
    expect(buildFindingsRuleContext(harness.currentLedger()).provisional.fixpoint).toBe(false);

    // The substantive resolution and the first adjudication recovery attempt both
    // represent real progress, so this round cannot be a fixpoint.
    await harness.run([
      unverifiedClaimRaw({ rawFindingId: 'ambiguous-1-r2' }),
      reviewerRawExtractionFixture({
        rawFindingId: 'confirm-1',
        familyTag: 'bug',
        severity: 'medium',
        title: 'Real, fixable issue',
        description: 'Verified: the fix removes the issue.',
        suggestion: null,
        relation: 'resolution_confirmation',
        targetFindingId: 'F-0001',
        target: { kind: 'code', paths: ['src/real.ts'] },
        // confirmation は検証済み file_quote 証跡が
        // 無いと resolve できない（機械照合を通らず finding を閉じさせない）。
        evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/real.ts', 10)],
      }),
    ]);
    const afterRound2 = harness.currentLedger();
    expect(afterRound2.findings.find((finding) => finding.id === 'F-0001')?.status)
      .toBe('resolved');
    expect(buildFindingsRuleContext(afterRound2).provisional.fixpoint).toBe(false);

    // The second bounded recovery attempt is still progress.
    await harness.run([unverifiedClaimRaw({ rawFindingId: 'ambiguous-1-r3' })]);
    const afterRound3 = harness.currentLedger();
    expect(buildFindingsRuleContext(afterRound3).provisional.fixpoint).toBe(false);

    // Once recovery is exhausted, an unchanged blocker forms a stable snapshot.
    await harness.run([unverifiedClaimRaw({ rawFindingId: 'ambiguous-1-r4' })]);
    const context = buildFindingsRuleContext(harness.currentLedger());
    expect(context.provisional.count).toBe(1);
    expect(context.provisional.fixpoint).toBe(true);
  });

  it('fresh process continuity: reopening the same Finding authority continues bounded recovery progress toward fixpoint', async () => {
    const runId = 'run-process-continuity';
    const priorProcess = makeRoundHarness({
      workflowName: 'peer-review', nextId: 1, updatedAt: '2026-07-01T00:00:00.000Z',
      findings: [], evidenceRecords: [], rawFindings: [], conflicts: [],
    }, runId);
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromEitherLocalId(
        instruction as string,
        ['ambiguous-1', 'ambiguous-1-resumed', 'ambiguous-1-resumed-again', 'ambiguous-1-resumed-stable'],
      );
      return unresolvedRecoveryResponse(instruction as string, rawId);
    });
    await priorProcess.run([unverifiedClaimRaw()]);
    const ledgerFromPriorProcess = priorProcess.currentLedger();
    expect(ledgerFromPriorProcess.fixpoint?.reached).toBe(false);

    const reopenedProcess = makeRoundHarness(ledgerFromPriorProcess, runId, 1);
    await reopenedProcess.run([unverifiedClaimRaw({ rawFindingId: 'ambiguous-1-resumed' })]);

    expect(reopenedProcess.currentLedger().fixpoint?.snapshot.provisionalKeys[0])
      .toContain(':recovery:0:1:0:0');
    await reopenedProcess.run([unverifiedClaimRaw({ rawFindingId: 'ambiguous-1-resumed-again' })]);
    await reopenedProcess.run([unverifiedClaimRaw({ rawFindingId: 'ambiguous-1-resumed-stable' })]);
    expect(buildFindingsRuleContext(reopenedProcess.currentLedger()).provisional.fixpoint).toBe(true);
  });

  it('a new explicit claim after a fixpoint breaks it, routing back to replan instead of staying stuck', async () => {
    const harness = makeRoundHarness({
      workflowName: 'peer-review', nextId: 1, updatedAt: '2026-07-01T00:00:00.000Z',
      findings: [], evidenceRecords: [], rawFindings: [], conflicts: [],
    });
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromEitherLocalId(
        instruction as string,
        ['ambiguous-1', 'ambiguous-1-r2', 'ambiguous-1-r3', 'ambiguous-1-r4', 'ambiguous-1-r5', 'new-observation'],
      );
      return unresolvedRecoveryResponse(instruction as string, rawId);
    });
    await harness.run([unverifiedClaimRaw()]);
    await harness.run([unverifiedClaimRaw({ rawFindingId: 'ambiguous-1-r2' })]);
    await harness.run([unverifiedClaimRaw({ rawFindingId: 'ambiguous-1-r3' })]);
    await harness.run([unverifiedClaimRaw({ rawFindingId: 'ambiguous-1-r4' })]);
    expect(buildFindingsRuleContext(harness.currentLedger()).provisional.fixpoint).toBe(true);

    // A new, different observation arrives (e.g. the human adjusted
    // something and a reviewer now reports something new) — the fixpoint
    // must not stay latched; it re-evaluates fresh each round.
    await harness.run([
      unverifiedClaimRaw({ rawFindingId: 'ambiguous-1-r5' }),
      unverifiedClaimRaw({
        rawFindingId: 'new-observation',
        title: 'A newly reported, different unverified claim',
        description: 'This is a new explicit claim without evidence.',
      }),
    ]);

    expect(buildFindingsRuleContext(harness.currentLedger()).provisional.fixpoint).toBe(false);
  });
});
