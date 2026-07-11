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
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

import { createFindingConflictAdjudicationRunner } from '../core/workflow/findings/adjudication-runner.js';
import { buildFindingConflictAdjudicationStep, FINDING_CONFLICT_ADJUDICATION_RULE_INDEX } from '../core/workflow/findings/adjudication-step.js';
import { createFindingLedgerStore } from '../core/workflow/findings/store.js';
import type { FindingContractConfig } from '../core/workflow/findings/types.js';
import type { WorkflowState } from '../core/models/types.js';

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
    executeAgentMock.mockReset();
  });

  afterEach(() => {
    if (existsSync(cwd)) {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  function makeRunner() {
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
      refreshFindingsState: () => {},
      emitEvent: () => {},
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
    expect(report.freshEvidenceHash).not.toBe(report.promptEvidenceHash);
    expect(report.output.conflictId).toBe('C-0001');
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
});
