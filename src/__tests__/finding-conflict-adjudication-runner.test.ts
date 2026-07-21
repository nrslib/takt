/**
 * Runner-level coverage for the finding-conflict-adjudication executor
 * (adjudication-runner.ts) against a REAL FindingLedgerStore:
 *
 * - codex B2: the decision is applied only when the evidence hash at apply
 *   time equals the hash the LLM was prompted with; otherwise it is discarded,
 *   audited (saveConflictAdjudicationReport), and the conflict stays
 *   unadjudicated for its NEW evidence.
 * - attempt-at-start semantics: the attempt lands on the ledger before the
 *   LLM call (the engine-level resume test builds on this).
 */
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const failingRead = vi.hoisted(() => ({
  suffix: '',
  afterReadSuffix: '',
  afterRead: undefined as (() => void) | undefined,
  beforeWritePathFragment: '',
  beforeWrite: undefined as (() => void) | undefined,
  descriptorPaths: new Map<number, string>(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    openSync: ((path: Parameters<typeof actual.openSync>[0], ...args: unknown[]) => {
      const descriptor = Reflect.apply(actual.openSync, actual, [path, ...args]) as number;
      failingRead.descriptorPaths.set(descriptor, String(path));
      return descriptor;
    }) as typeof actual.openSync,
    closeSync: ((descriptor: number) => {
      failingRead.descriptorPaths.delete(descriptor);
      return actual.closeSync(descriptor);
    }) as typeof actual.closeSync,
    readFileSync(...args: Parameters<typeof actual.readFileSync>) {
      const path = typeof args[0] === 'number'
        ? failingRead.descriptorPaths.get(args[0])
        : String(args[0]);
      if (failingRead.suffix.length > 0
        && path?.endsWith(failingRead.suffix)) {
        throw Object.assign(new Error('injected adjudication read failure'), { code: 'EIO' });
      }
      const content = actual.readFileSync(...args);
      if (failingRead.afterReadSuffix.length > 0
        && path?.endsWith(failingRead.afterReadSuffix)) {
        const afterRead = failingRead.afterRead;
        failingRead.afterReadSuffix = '';
        failingRead.afterRead = undefined;
        afterRead?.();
      }
      return content;
    },
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      const path = typeof args[0] === 'number'
        ? failingRead.descriptorPaths.get(args[0])
        : String(args[0]);
      if (
        failingRead.beforeWritePathFragment.length > 0
        && path?.includes(failingRead.beforeWritePathFragment)
      ) {
        const beforeWrite = failingRead.beforeWrite;
        failingRead.beforeWritePathFragment = '';
        failingRead.beforeWrite = undefined;
        beforeWrite?.();
      }
      return actual.writeFileSync(...args);
    },
  };
});

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

import { createFindingConflictAdjudicationRunner } from '../core/workflow/findings/adjudication-runner.js';
import { commitFindingConflictAdjudication } from '../core/workflow/findings/adjudication-commit.js';
import {
  buildAdjudicationEvidenceSnapshot,
  computeAdjudicationEvidenceHash,
} from '../core/workflow/findings/adjudication-evidence.js';
import { buildFindingConflictAdjudicationStep, FINDING_CONFLICT_ADJUDICATION_RULE_INDEX } from '../core/workflow/findings/adjudication-step.js';
import { createFindingLedgerStore } from '../core/workflow/findings/store.js';
import { captureReviewScopeSnapshot } from '../core/workflow/findings/snapshot.js';
import type { FindingContractConfig } from '../core/workflow/findings/types.js';
import type { WorkflowState } from '../core/models/types.js';
import { initializeGitFixture } from './helpers/git-fixture.js';

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);

function makeContract(cwd: string): FindingContractConfig {
  return {
    ledgerPath: '.takt/findings/peer-review.json',
    rawFindingsPath: '.takt/findings/raw',
    manager: {
      persona: 'findings-manager',
      instruction: 'findings-manager',
      outputContract: 'findings-manager',
    },
    adjudicator: {
      persona: 'supervisor',
      personaPath: join(cwd, 'personas', 'supervisor.md'),
      personaDisplayName: 'supervisor',
      providerRoutingPersonaKey: 'supervisor',
    },
  };
}

function makeState(): WorkflowState {
  return {
    workflowName: 'runner-test',
    currentStep: 'finding-conflict-adjudication',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
  };
}

function seedLedger(ledgerPath: string): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify({
    version: 1,
    workflowName: 'runner-test',
    nextId: 2,
    updatedAt: '2026-06-13T00:00:00.000Z',
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      severity: 'high',
      title: 'Disputed issue',
      location: 'src/a.ts:5',
      reviewers: ['coding-review'],
      rawFindingIds: ['raw-1'],
      firstSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
      lastSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    }],
    rawFindings: [{
      rawFindingId: 'raw-1',
      stepName: 'reviewers',
      reviewer: 'coding-review',
      familyTag: 'bug',
      severity: 'high',
      title: 'Disputed issue',
      location: 'src/a.ts:5',
      description: 'The bug is present.',
      relation: 'new',
    }],
    conflicts: [{
      id: 'C-0001',
      status: 'active',
      findingIds: ['F-0001'],
      rawFindingIds: [],
      description: 'Reviewers disagree about F-0001.',
      firstSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
      lastSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    }],
  }, null, 2), 'utf-8');
}

describe('finding-conflict-adjudication runner', () => {
  let cwd: string;
  let reportDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-adjudication-runner-'));
    reportDir = join(cwd, '.takt', 'runs', 'run-1', 'reports');
    mkdirSync(reportDir, { recursive: true });
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'a.ts'), Array.from({ length: 20 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n');
    ledgerPath = join(cwd, '.takt', 'findings', 'peer-review.json');
    seedLedger(ledgerPath);
    initializeGitFixture(cwd, ['src/a.ts']);
    executeAgentMock.mockReset();
  });

  afterEach(() => {
    failingRead.suffix = '';
    failingRead.afterReadSuffix = '';
    failingRead.afterRead = undefined;
    failingRead.beforeWritePathFragment = '';
    failingRead.beforeWrite = undefined;
    failingRead.descriptorPaths.clear();
    if (existsSync(cwd)) {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  function makeRunner(
    refreshFindingsState: () => void = () => {},
    emitEvent: (event: string, ...args: unknown[]) => void = () => {},
  ) {
    const contract = makeContract(cwd);
    const ledgerStore = createFindingLedgerStore({
      projectCwd: cwd,
      reportDir,
      workflowName: 'runner-test',
      ledgerPath: contract.ledgerPath,
      rawFindingsPath: contract.rawFindingsPath,
    });
    const step = buildFindingConflictAdjudicationStep({ contract, workflowProvider: 'claude' });
    const runner = createFindingConflictAdjudicationRunner({
      ledgerStore,
      optionsBuilder: {
        buildAgentOptions: () => ({ provider: 'claude', cwd }),
        resolveStepProviderModel: () => ({ provider: 'claude', providerSource: 'workflow' }),
      },
      stepExecutor: {
        buildPhase1Instruction: (instruction: string) => instruction,
        normalizeStructuredOutput: (_step, response) => response,
      },
      getCwd: () => cwd,
      workflowName: 'runner-test',
      runId: 'run-1',
      refreshFindingsState,
      emitEvent,
    });
    return { runner, step, ledgerStore };
  }

  it('hash 不一致時は裁定を破棄する: 適用されず監査記録が残り、conflict は新 evidence に対して未裁定のまま', async () => {
    const { runner, step } = makeRunner();

    executeAgentMock.mockImplementation(async () => {
      // LLM 応答が返る前に台帳の evidence（raw の本文）が変わったことを再現。
      const current = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
        rawFindings: Array<{ description: string }>;
      };
      current.rawFindings[0]!.description = 'A NEW observation recorded while the adjudicator was thinking.';
      writeFileSync(ledgerPath, JSON.stringify(current, null, 2), 'utf-8');
      return {
        persona: 'supervisor',
        status: 'done',
        content: '{}',
        structuredOutput: {
          conflictId: 'C-0001',
          outcome: 'finding_stale',
          findingTransition: 'resolved',
          evidence: ['Verified fixed.', 'src/a.ts:5'],
          actionableFix: '',
        },
        timestamp: new Date('2026-06-13T02:00:00.000Z'),
      };
    });

    const result = await runner.run(step, makeState());

    // 破棄: origin へ戻す（新 hash は未裁定なので次ラウンドで再裁定できる）
    expect(result.response.status).toBe('done');
    expect(result.response.matchedRuleIndex).toBe(FINDING_CONFLICT_ADJUDICATION_RULE_INDEX.FINDING_CLOSED);
    expect(result.response.content).toContain('discarded');

    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
      findings: Array<{ status: string }>;
      conflicts: Array<{ status: string; adjudications?: unknown[]; adjudicationAttempts?: Array<{ evidenceHash: string }> }>;
    };
    // 適用されていない: finding は open のまま、adjudications は空
    expect(ledger.findings[0]?.status).toBe('open');
    expect(ledger.conflicts[0]?.status).toBe('active');
    expect(ledger.conflicts[0]?.adjudications ?? []).toHaveLength(0);
    // attempt（旧 hash）は残る
    expect(ledger.conflicts[0]?.adjudicationAttempts).toHaveLength(1);

    // 監査記録
    const reportPath = join(reportDir, 'findings-adjudication.C-0001.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as {
      discarded: boolean;
      reason: string;
      promptEvidenceHash: string;
      freshEvidenceHash?: string;
      output: { conflictId: string };
    };
    expect(report.discarded).toBe(true);
    expect(report.reason).toContain('changed');
    expect(result.response.content).toContain(report.reason);
    expect(report.freshEvidenceHash).not.toBe(report.promptEvidenceHash);
    expect(report.output.conflictId).toBe('C-0001');
  });

  it('直列化待ち中に作業ツリーが変化した裁定を破棄する', async () => {
    const { ledgerStore } = makeRunner();
    const initialLedger = ledgerStore.loadLedger();
    const conflict = initialLedger.conflicts[0]!;
    const promptedEvidenceHash = computeAdjudicationEvidenceHash(buildAdjudicationEvidenceSnapshot({
      ledger: initialLedger,
      conflictId: conflict.id,
      reviewScopeSnapshot: captureReviewScopeSnapshot(cwd),
    }));
    const precedingUpdate = ledgerStore.updateLedger((current) => {
      writeFileSync(join(cwd, 'src', 'a.ts'), '// changed while waiting\n');
      return { ledger: current, result: undefined };
    });

    const commit = commitFindingConflictAdjudication({
      ledgerStore,
      conflictId: conflict.id,
      promptedEvidenceHash,
      output: {
        conflictId: conflict.id,
        outcome: 'finding_stale',
        findingTransition: 'resolved',
        evidence: ['The finding no longer applies.', 'src/a.ts:5'],
        actionableFix: '',
      },
      cwd,
      workflowName: 'runner-test',
      stepName: 'finding-conflict-adjudication',
      runId: 'run-1',
      timestamp: '2026-06-13T02:00:00.000Z',
    });

    await precedingUpdate;
    const mutation = await commit;
    const persistedLedger = ledgerStore.loadLedger();
    const persistedConflict = persistedLedger.conflicts[0]!;
    const roundtripEvidenceHash = computeAdjudicationEvidenceHash(buildAdjudicationEvidenceSnapshot({
      ledger: persistedLedger,
      conflictId: persistedConflict.id,
      reviewScopeSnapshot: captureReviewScopeSnapshot(cwd),
    }));

    expect(mutation.result).toMatchObject({
      applied: false,
      reason: expect.stringContaining('evidence changed'),
      freshEvidenceHash: roundtripEvidenceHash,
    });
    expect(roundtripEvidenceHash).not.toBe(promptedEvidenceHash);
    expect(mutation.ledger).toEqual(persistedLedger);
    expect(persistedLedger.findings[0]?.status).toBe('open');
    expect(persistedConflict.status).toBe('active');
    expect(persistedConflict.adjudications ?? []).toHaveLength(0);
  });

  it('保存処理中に作業ツリーが変化した裁定を公開しない', async () => {
    const { ledgerStore } = makeRunner();
    const initialLedger = ledgerStore.loadLedger();
    const conflict = initialLedger.conflicts[0]!;
    const promptedEvidenceHash = computeAdjudicationEvidenceHash(buildAdjudicationEvidenceSnapshot({
      ledger: initialLedger,
      conflictId: conflict.id,
      reviewScopeSnapshot: captureReviewScopeSnapshot(cwd),
    }));
    failingRead.beforeWritePathFragment = 'peer-review.json';
    failingRead.beforeWrite = () => {
      writeFileSync(join(cwd, 'src', 'a.ts'), '// changed during ledger save\n');
    };

    const mutation = await commitFindingConflictAdjudication({
      ledgerStore,
      conflictId: conflict.id,
      promptedEvidenceHash,
      output: {
        conflictId: conflict.id,
        outcome: 'finding_stale',
        findingTransition: 'resolved',
        evidence: ['The finding no longer applies.', 'src/a.ts:5'],
        actionableFix: '',
      },
      cwd,
      workflowName: 'runner-test',
      stepName: 'finding-conflict-adjudication',
      runId: 'run-1',
      timestamp: '2026-06-13T02:00:00.000Z',
    });

    const persisted = ledgerStore.loadLedger();
    expect(mutation.result).toMatchObject({
      applied: false,
      reason: expect.stringContaining('evidence changed'),
    });
    expect(persisted.findings[0]?.status).toBe('open');
    expect(persisted.conflicts[0]?.status).toBe('active');
    expect(persisted.conflicts[0]?.adjudications ?? []).toHaveLength(0);
  });

  it('should reserve, prompt, and persist adjudication evidence from the worktree after the ledger wait', async () => {
    const { runner, step, ledgerStore } = makeRunner();
    const ledgerBeforeWait = ledgerStore.loadLedger();
    const conflictBeforeWait = ledgerBeforeWait.conflicts[0]!;
    const evidenceHashBeforeWait = computeAdjudicationEvidenceHash(buildAdjudicationEvidenceSnapshot({
      ledger: ledgerBeforeWait,
      conflictId: conflictBeforeWait.id,
      reviewScopeSnapshot: captureReviewScopeSnapshot(cwd),
    }));
    const updateLedger = ledgerStore.updateLedger.bind(ledgerStore);
    let releasePrecedingUpdate!: () => void;
    let notifyReservationWaiting!: () => void;
    const precedingUpdate = new Promise<void>((resolve) => { releasePrecedingUpdate = resolve; });
    const reservationWaiting = new Promise<void>((resolve) => { notifyReservationWaiting = resolve; });
    ledgerStore.updateLedger = ((mutator) => {
      notifyReservationWaiting();
      return precedingUpdate.then(() => updateLedger(mutator));
    }) as typeof ledgerStore.updateLedger;

    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const snapshot = captureReviewScopeSnapshot(cwd);
      const ledgerAtPrompt = ledgerStore.loadLedger();
      const conflict = ledgerAtPrompt.conflicts[0]!;
      const expectedEvidenceHash = computeAdjudicationEvidenceHash(buildAdjudicationEvidenceSnapshot({
        ledger: ledgerAtPrompt,
        conflictId: conflict.id,
        reviewScopeSnapshot: snapshot,
      }));

      expect(instruction).toContain(`reviewScopeSnapshotId: ${snapshot.reviewScopeSnapshotId}`);
      expect(instruction).toContain('trackedDiffDigest:');
      expect(instruction).not.toContain('+export const changedDuringLedgerWait = true;');
      expect(conflict.adjudicationAttempts).toEqual([
        expect.objectContaining({ evidenceHash: expectedEvidenceHash }),
      ]);
      return {
        persona: 'supervisor',
        status: 'done',
        content: '{}',
        structuredOutput: {
          conflictId: 'C-0001',
          outcome: 'undetermined',
          findingTransition: 'keep_open',
          evidence: ['The evidence remains inconclusive.'],
          actionableFix: '',
        },
        timestamp: new Date('2026-06-13T02:00:00.000Z'),
      };
    });

    const run = runner.run(step, makeState());
    await reservationWaiting;
    writeFileSync(join(cwd, 'src', 'a.ts'), 'export const changedDuringLedgerWait = true;\n', 'utf-8');
    releasePrecedingUpdate();

    const result = await run;
    const persistedLedger = ledgerStore.loadLedger();
    const persistedConflict = persistedLedger.conflicts[0]!;
    const persistedAttemptHash = persistedConflict.adjudicationAttempts?.[0]?.evidenceHash;
    const roundtripEvidenceHash = computeAdjudicationEvidenceHash(buildAdjudicationEvidenceSnapshot({
      ledger: persistedLedger,
      conflictId: persistedConflict.id,
      reviewScopeSnapshot: captureReviewScopeSnapshot(cwd),
    }));

    expect(result.response.content).toContain('Adjudicated conflict C-0001');
    expect(roundtripEvidenceHash).not.toBe(evidenceHashBeforeWait);
    expect(persistedAttemptHash).toBe(roundtripEvidenceHash);
    expect(persistedConflict.adjudications).toEqual([
      expect.objectContaining({ evidenceHash: roundtripEvidenceHash }),
    ]);
    expect(persistedConflict.adjudications).not.toContainEqual(
      expect.objectContaining({ evidenceHash: evidenceHashBeforeWait }),
    );
  });

  it.each([
    ['tracked', 'src/a.ts'],
    ['untracked', 'src/new.ts'],
  ] as const)('%s worktree の変更時は snapshot CAS が裁定を破棄する', async (_kind, relativePath) => {
    const { runner, step } = makeRunner();
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      expect(instruction).toContain('reviewScopeSnapshotId:');
      writeFileSync(join(cwd, relativePath), '// changed while adjudicating\n', 'utf-8');
      return {
        persona: 'supervisor',
        status: 'done',
        content: '{}',
        structuredOutput: {
          conflictId: 'C-0001',
          outcome: 'finding_stale',
          findingTransition: 'resolved',
          evidence: ['Verified fixed.', 'src/a.ts:5'],
          actionableFix: '',
        },
        timestamp: new Date('2026-06-13T02:00:00.000Z'),
      };
    });

    const result = await runner.run(step, makeState());

    expect(result.response.content).toContain('discarded');
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
      findings: Array<{ status: string }>;
      conflicts: Array<{ status: string; adjudications?: unknown[] }>;
    };
    expect(ledger.findings[0]?.status).toBe('open');
    expect(ledger.conflicts[0]?.status).toBe('active');
    expect(ledger.conflicts[0]?.adjudications ?? []).toHaveLength(0);
  });

  it('should discard an adjudication when the worktree changes during evidence application', async () => {
    const { runner, step } = makeRunner();
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: {
        conflictId: 'C-0001',
        outcome: 'finding_stale',
        findingTransition: 'resolved',
        evidence: ['src/a.ts:5'],
        actionableFix: '',
      },
      timestamp: new Date('2026-06-13T02:00:00.000Z'),
    });
    failingRead.afterReadSuffix = join('src', 'a.ts');
    failingRead.afterRead = () => {
      writeFileSync(join(cwd, 'src', 'a.ts'), 'export const changedDuringApply = true;\n', 'utf-8');
    };

    const result = await runner.run(step, makeState());

    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
      findings: Array<{ status: string }>;
      conflicts: Array<{ status: string; adjudications?: unknown[] }>;
    };
    expect(result.response.content).toContain('discarded');
    const report = JSON.parse(readFileSync(
      join(reportDir, 'findings-adjudication.C-0001.json'),
      'utf-8',
    )) as { discarded: boolean; reason: string };
    expect(report).toMatchObject({
      discarded: true,
      reason: expect.stringContaining('evidence changed'),
    });
    expect(ledger.findings[0]?.status).toBe('open');
    expect(ledger.conflicts[0]?.status).toBe('active');
    expect(ledger.conflicts[0]?.adjudications ?? []).toHaveLength(0);
  });

  it('裁定 evidence はイベント購読者の変更から独立し、未追跡ファイルはdigestだけを含む', async () => {
    const untrackedSource = 'export const UNTRACKED_EVIDENCE_SENTINEL = 42;\n';
    writeFileSync(join(cwd, 'src', 'new.ts'), untrackedSource, 'utf-8');
    const emitEvent = vi.fn((_event: string, ...args: unknown[]) => {
      const emittedLedger = args[0] as {
        findings: Array<{ title: string }>;
        rawFindings: Array<{ description: string }>;
      };
      emittedLedger.findings[0]!.title = 'MUTATED BY LISTENER';
      emittedLedger.rawFindings[0]!.description = 'MUTATED BY LISTENER';
    });
    const { runner, step } = makeRunner(() => {}, emitEvent);
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      expect(instruction).toContain('Disputed issue');
      expect(instruction).toContain('The bug is present.');
      expect(instruction).toContain('untracked: src/new.ts (file)');
      expect(instruction).toContain(createHash('sha256').update(untrackedSource).digest('hex'));
      expect(instruction).not.toContain(untrackedSource.trim());
      expect(instruction).not.toContain('MUTATED BY LISTENER');
      return {
        persona: 'supervisor',
        status: 'done',
        content: '{}',
        structuredOutput: {
          conflictId: 'C-0001',
          outcome: 'undetermined',
          findingTransition: 'keep_open',
          evidence: ['Still disputed.'],
          actionableFix: '',
        },
        timestamp: new Date('2026-06-13T02:00:00.000Z'),
      };
    });

    const result = await runner.run(step, makeState());

    expect(result.response.content).toContain('Adjudicated conflict C-0001');
    expect(emitEvent).toHaveBeenCalledTimes(2);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
      findings: Array<{ title: string }>;
      rawFindings: Array<{ description: string }>;
      conflicts: Array<{ adjudications?: unknown[] }>;
    };
    expect(ledger.findings[0]?.title).toBe('Disputed issue');
    expect(ledger.rawFindings[0]?.description).toBe('The bug is present.');
    expect(ledger.conflicts[0]?.adjudications).toHaveLength(1);
  });

  it('Git snapshot の取得失敗を差分なしとして扱わず伝播する', async () => {
    const { runner, step } = makeRunner();
    writeFileSync(join(cwd, '.git', 'index'), 'invalid git index', 'utf-8');

    await expect(runner.run(step, makeState())).rejects.toThrow();
    expect(executeAgentMock).not.toHaveBeenCalled();
  });

  it('R2(a) 相当のランナー単体: 同一 run の pending attempt は予約として再利用され、二重記録されない', async () => {
    const { runner, step } = makeRunner();

    // 1回目: rate_limited — attempt は記録されるが outcome は残らない
    executeAgentMock.mockResolvedValueOnce({
      persona: 'supervisor',
      status: 'rate_limited',
      content: '',
      timestamp: new Date('2026-06-13T02:00:00.000Z'),
    });
    const first = await runner.run(step, makeState());
    expect(first.response.status).toBe('rate_limited');

    const ledgerAfterRateLimit = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
      conflicts: Array<{ adjudicationAttempts?: unknown[]; adjudications?: unknown[] }>;
    };
    expect(ledgerAfterRateLimit.conflicts[0]?.adjudicationAttempts).toHaveLength(1);
    expect(ledgerAfterRateLimit.conflicts[0]?.adjudications ?? []).toHaveLength(0);

    // 2回目（同一 runner = 同一 runId の fallback 再実行相当）: pending attempt を
    // 再利用して LLM を呼び、attempt は二重記録されない
    executeAgentMock.mockResolvedValueOnce({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: {
        conflictId: 'C-0001',
        outcome: 'undetermined',
        findingTransition: 'keep_open',
        evidence: ['Still cannot decide.'],
        actionableFix: '',
      },
      timestamp: new Date('2026-06-13T02:05:00.000Z'),
    });
    const second = await runner.run(step, makeState());
    expect(second.response.status).toBe('done');
    expect(second.response.matchedRuleIndex).toBe(FINDING_CONFLICT_ADJUDICATION_RULE_INDEX.UNRESOLVED);
    expect(executeAgentMock).toHaveBeenCalledTimes(2);

    const ledgerAfterRetry = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
      conflicts: Array<{ adjudicationAttempts?: unknown[]; adjudications?: unknown[] }>;
    };
    expect(ledgerAfterRetry.conflicts[0]?.adjudicationAttempts).toHaveLength(1);
    expect(ledgerAfterRetry.conflicts[0]?.adjudications).toHaveLength(1);
  });

  it('台帳再読込が失敗しても予約を解放し、同じ pending attempt を再試行できる', async () => {
    const refreshFindingsState = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('injected refresh failure');
      })
      .mockImplementation(() => {});
    const { runner, step } = makeRunner(refreshFindingsState);
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: {
        conflictId: 'C-0001',
        outcome: 'undetermined',
        findingTransition: 'keep_open',
        evidence: ['Still disputed.'],
        actionableFix: '',
      },
      timestamp: new Date('2026-06-13T02:05:00.000Z'),
    });

    await expect(runner.run(step, makeState())).rejects.toThrow('injected refresh failure');
    const retried = await runner.run(step, makeState());

    expect(retried.response.content).toContain('Adjudicated conflict C-0001');
    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
      conflicts: Array<{ adjudicationAttempts?: unknown[]; adjudications?: unknown[] }>;
    };
    expect(ledger.conflicts[0]?.adjudicationAttempts).toHaveLength(1);
    expect(ledger.conflicts[0]?.adjudications).toHaveLength(1);
  });

  it('R2(c): outcome 記録済みの evidence は同一 run でも再裁定しない（attempt は LLM 前に記録される）', async () => {
    const { runner, step } = makeRunner();

    let attemptsAtLlmTime: unknown[] | undefined;
    executeAgentMock.mockImplementation(async () => {
      const current = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
        conflicts: Array<{ adjudicationAttempts?: unknown[] }>;
      };
      attemptsAtLlmTime = current.conflicts[0]?.adjudicationAttempts;
      return {
        persona: 'supervisor',
        status: 'done',
        content: '{}',
        structuredOutput: {
          conflictId: 'C-0001',
          outcome: 'undetermined',
          findingTransition: 'keep_open',
          evidence: ['Cannot decide.'],
          actionableFix: '',
        },
        timestamp: new Date('2026-06-13T02:00:00.000Z'),
      };
    });

    const result = await runner.run(step, makeState());
    expect(attemptsAtLlmTime).toHaveLength(1);
    expect(result.response.matchedRuleIndex).toBe(FINDING_CONFLICT_ADJUDICATION_RULE_INDEX.UNRESOLVED);

    // 同一 evidence の2回目は LLM を呼ばずに UNRESOLVED（ABORT 側）へ落ちる
    executeAgentMock.mockClear();
    const second = await runner.run(step, makeState());
    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(second.response.matchedRuleIndex).toBe(FINDING_CONFLICT_ADJUDICATION_RULE_INDEX.UNRESOLVED);
  });

  it('同一 evidenceHash の競合裁定は予約所有者だけが LLM を実行する', async () => {
    const { runner, step } = makeRunner();
    let releaseOwner!: () => void;
    let notifyOwnerStarted!: () => void;
    const ownerStarted = new Promise<void>((resolve) => { notifyOwnerStarted = resolve; });
    const ownerMayFinish = new Promise<void>((resolve) => { releaseOwner = resolve; });
    executeAgentMock.mockImplementation(async () => {
      const callNumber = executeAgentMock.mock.calls.length;
      notifyOwnerStarted();
      await ownerMayFinish;
      return {
        persona: 'supervisor',
        status: 'done',
        content: '{}',
        structuredOutput: {
          conflictId: 'C-0001',
          outcome: 'undetermined',
          findingTransition: 'keep_open',
          evidence: [`concurrent decision ${callNumber}`],
          actionableFix: '',
        },
        timestamp: new Date('2026-06-13T02:00:00.000Z'),
      };
    });

    const ownerRun = runner.run(step, makeState());
    await ownerStarted;
    const competingResult = await runner.run(step, makeState());
    releaseOwner();
    const ownerResult = await ownerRun;

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(ownerResult.response.content).toContain('Adjudicated conflict C-0001');
    expect(competingResult.response.content).toContain('already being adjudicated');
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
      conflicts: Array<{
        adjudications?: Array<{ evidence: string[] }>;
        adjudicationAttempts?: Array<{ reservationToken: string }>;
      }>;
    };
    expect(ledger.conflicts[0]?.adjudicationAttempts).toHaveLength(1);
    expect(ledger.conflicts[0]?.adjudications).toHaveLength(1);
    expect(ledger.conflicts[0]?.adjudications?.[0]?.evidence).toEqual(['concurrent decision 1']);
    expect(ledger.conflicts[0]?.adjudicationAttempts?.[0]?.reservationToken).toBeTruthy();
  });

  it('適用時に conflict が inactive なら台帳を変更せず、監査と応答で同じ理由を返す', async () => {
    const { runner, step } = makeRunner();
    executeAgentMock.mockImplementation(async () => {
      const current = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
        conflicts: Array<{ status: string }>;
      };
      current.conflicts[0]!.status = 'resolved';
      writeFileSync(ledgerPath, JSON.stringify(current, null, 2), 'utf-8');
      return {
        persona: 'supervisor',
        status: 'done',
        content: '{}',
        structuredOutput: {
          conflictId: 'C-0001',
          outcome: 'undetermined',
          findingTransition: 'keep_open',
          evidence: ['No longer actionable.'],
          actionableFix: '',
        },
        timestamp: new Date('2026-06-13T02:00:00.000Z'),
      };
    });

    const result = await runner.run(step, makeState());
    const report = JSON.parse(readFileSync(
      join(reportDir, 'findings-adjudication.C-0001.json'),
      'utf-8',
    )) as { reason: string };
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
      findings: Array<{ status: string }>;
      conflicts: Array<{ status: string; adjudications?: unknown[] }>;
    };

    expect(report.reason).toBe('conflict "C-0001" is no longer active');
    expect(result.response.content).toContain(report.reason);
    expect(ledger.findings[0]?.status).toBe('open');
    expect(ledger.conflicts[0]?.status).toBe('resolved');
    expect(ledger.conflicts[0]?.adjudications ?? []).toHaveLength(0);
  });

  it('source quote の EIO は例外として伝播し裁定結果を保存しない', async () => {
    const { runner, step } = makeRunner();
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: {
        conflictId: 'C-0001',
        outcome: 'evidence_invalid',
        findingTransition: 'invalidated',
        evidence: ['invalid premise'],
        actionableFix: '',
      },
      timestamp: new Date('2026-06-13T02:00:00.000Z'),
    });
    failingRead.suffix = join('src', 'a.ts');

    await expect(runner.run(step, makeState())).rejects.toThrow(/injected adjudication read failure/);

    failingRead.suffix = '';
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
      findings: Array<{ status: string }>;
      conflicts: Array<{ status: string; adjudications?: unknown[]; adjudicationAttempts?: unknown[] }>;
    };
    expect(ledger.findings[0]?.status).toBe('open');
    expect(ledger.conflicts[0]?.status).toBe('active');
    expect(ledger.conflicts[0]?.adjudications ?? []).toHaveLength(0);
    expect(ledger.conflicts[0]?.adjudicationAttempts).toHaveLength(1);
  });
});
