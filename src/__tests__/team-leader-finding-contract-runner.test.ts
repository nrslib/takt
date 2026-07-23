import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamLeaderRunner } from '../core/workflow/engine/TeamLeaderRunner.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import type {
  AgentResponse,
  FindingContractConfig,
  FindingLedger,
  WorkflowState,
  WorkflowStep,
} from '../core/models/types.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import { evaluateWhenExpression } from '../core/workflow/evaluation/when-evaluator.js';
import {
  createFindingContractDecisionValidationIssue,
  createFindingContractTeamLeaderDecisionValidationError,
} from '../core/workflow/team-leader-finding-contract-decision-validation.js';

const { executeAgentMock } = vi.hoisted(() => ({ executeAgentMock: vi.fn() }));

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: executeAgentMock,
}));

const temporaryDirectories: string[] = [];

function decisionValidationError(
  code: string,
  category: 'decision_contract' | 'evidence',
) {
  return createFindingContractTeamLeaderDecisionValidationError({
    decision: code,
    parts: [],
    fixCoverage: [],
    blockers: [],
  }, [createFindingContractDecisionValidationIssue({
    code,
    category,
    path: code,
    message: code,
  })]);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

function makeLedger(): FindingLedger {
  return {
    version: 1,
    workflowName: 'workflow',
    findings: [
      {
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        severity: 'high',
        title: 'First defect',
        location: 'src/first.ts:10',
        description: 'first description',
        suggestion: 'fix first',
        reviewers: ['reviewer'],
        rawFindingIds: ['R-0001'],
        observations: [],
      },
      {
        id: 'F-0002',
        status: 'open',
        lifecycle: 'persists',
        severity: 'medium',
        title: 'Second defect',
        location: 'src/second.ts:20',
        description: 'second description',
        suggestion: 'fix second',
        reviewers: ['reviewer'],
        rawFindingIds: ['R-0002'],
        observations: [],
      },
    ],
    rawFindings: [
      {
        rawFindingId: 'R-0001',
        stepName: 'reviewers',
        reviewer: 'reviewer',
        familyTag: 'first-family',
        severity: 'high',
        title: 'First defect',
        description: 'first description',
        relation: 'new',
      },
      {
        rawFindingId: 'R-0002',
        stepName: 'reviewers',
        reviewer: 'reviewer',
        familyTag: 'second-family',
        severity: 'medium',
        title: 'Second defect',
        description: 'second description',
        relation: 'new',
      },
    ],
    conflicts: [],
    reviewerAnomalies: [],
  } as unknown as FindingLedger;
}

function makeState(): WorkflowState {
  return {
    workflowName: 'workflow',
    currentStep: 'fix',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    lastOutput: undefined,
    previousResponseSourcePath: undefined,
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
  };
}

describe('TeamLeaderRunner finding_contract_fix', () => {
  it('scopes each worker to assigned findings and publishes the explicit final decision', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-finding-contract-runner-'));
    temporaryDirectories.push(cwd);
    const runPaths = buildRunPaths(cwd, 'run-1');
    mkdirSync(runPaths.contextAbs, { recursive: true });
    const ledger = makeLedger();
    const ledgerStore = {
      loadLedger: vi.fn(() => ledger),
      createRunCopy: vi.fn(() => join(cwd, '.takt', 'finding-ledger.json')),
    } as unknown as FindingLedgerStore;
    const findingContract: FindingContractConfig = {
      ledgerPath: '.takt/findings.json',
      rawFindingsPath: '.takt/raw',
      manager: {
        persona: 'findings-manager',
        instruction: 'manage',
        outputContract: 'contract',
      },
    };
    const parts = [
      {
        id: 'repair-first',
        title: 'First',
        instruction: 'repair first',
        findingContract: {
          findingIds: ['F-0001'],
          role: 'repair' as const,
          writePaths: ['src/first.ts'],
          readPaths: [],
        },
      },
      {
        id: 'repair-second',
        title: 'Second',
        instruction: 'repair second',
        findingContract: {
          findingIds: ['F-0002'],
          role: 'repair' as const,
          writePaths: ['src/second.ts'],
          readPaths: [],
        },
      },
    ];
    const verificationPart = {
      id: 'verify-first',
      title: 'Verify first',
      instruction: 'verify first',
      findingContract: {
        findingIds: ['F-0001'],
        role: 'verify' as const,
        writePaths: [],
        readPaths: ['src/first.ts'],
      },
    };
    executeAgentMock
      .mockResolvedValueOnce({
        persona: 'coder',
        status: 'done',
        content: 'FIRST_RAW',
        structuredOutput: {
          findingOutcomes: [{ findingId: 'F-0001', outcome: 'addressed', evidence: ['src/first.ts:10'] }],
          changedPaths: ['src/first.ts'],
          checks: [{ command: 'npm test', status: 'passed' }],
          summary: 'first fixed',
        },
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'coder',
        status: 'done',
        content: 'SECOND_RAW',
        structuredOutput: {
          findingOutcomes: [{ findingId: 'F-0002', outcome: 'addressed', evidence: ['src/second.ts:20'] }],
          changedPaths: ['src/second.ts'],
          checks: [{ command: 'npm test', status: 'passed' }],
          summary: 'second fixed',
        },
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'coder',
        status: 'done',
        content: 'VERIFY_RAW',
        structuredOutput: {
          findingOutcomes: [{ findingId: 'F-0001', outcome: 'addressed', evidence: ['src/first.ts:10'] }],
          changedPaths: [],
          checks: [{ command: 'npm test', status: 'passed' }],
          summary: 'first verified',
        },
        timestamp: new Date(),
      });
    const completeDecision = {
      decision: 'complete' as const,
      reasoning: 'all covered',
      parts: [] as [],
      fixCoverage: parts.map((part) => {
        const findingId = part.findingContract.findingIds[0];
        if (!findingId) throw new Error(`Missing finding assignment: ${part.id}`);
        return {
          findingId,
          disposition: 'addressed' as const,
          supportingPartIds: [part.id],
          verificationPartIds: [],
        };
      }),
    };
    const structuredCaller = {
      judgeStatus: vi.fn(),
      evaluateCondition: vi.fn(),
      decomposeTask: vi.fn(async (_instruction, _max, options) => {
        options.onPromptResolved?.({ systemPrompt: 'system', userInstruction: 'leader instruction' });
        return { parts };
      }),
      requestMoreParts: vi.fn()
        .mockRejectedValueOnce(decisionValidationError(
          'decision_contract.continue_fix_coverage',
          'decision_contract',
        ))
        .mockRejectedValueOnce(decisionValidationError(
          'evidence.unsupported_disposition',
          'evidence',
        ))
        .mockResolvedValueOnce({
          done: false,
          reasoning: 'verify first',
          parts: [verificationPart],
          findingContractDecision: {
            decision: 'continue',
            reasoning: 'verify first',
            parts: [verificationPart],
          },
        })
        .mockResolvedValueOnce({
          done: true,
          reasoning: 'all covered',
          parts: [],
          findingContractDecision: completeDecision,
        }),
    };
    let leaderContext: unknown;
    let completeRuleMatched = false;
    const stepExecutor = {
      buildInstruction: vi.fn((step: WorkflowStep, _iteration, _state, _task, _max, _fallback, context) => {
        if (!step.name.includes('.')) leaderContext = context;
        return step.name.includes('.') ? step.instruction : 'leader instruction';
      }),
      buildPhase1Instruction: vi.fn((instruction: string) => instruction),
      normalizeStructuredOutput: vi.fn((_step, response: AgentResponse) => response),
      applyPostExecutionPhases: vi.fn(async (_step, state: WorkflowState, _iteration, response: AgentResponse) => {
        if (response.structuredOutput) state.structuredOutputs.set('fix', response.structuredOutput);
        completeRuleMatched = evaluateWhenExpression(
          'structured.fix.decision == "complete"',
          state,
        );
        return response;
      }),
      persistPreviousResponseSnapshot: vi.fn(),
      emitStepReports: vi.fn(),
    };
    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({ cwd }),
        buildBaseOptions: vi.fn().mockReturnValue({}),
        buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
        resolveMcpServersForStep: vi.fn().mockReturnValue(undefined),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'codex', model: 'gpt-5' }),
      },
      stepExecutor,
      engineOptions: { projectCwd: cwd, structuredCaller, language: 'ja' },
      getCwd: () => cwd,
      getWorkflowName: () => 'workflow',
      getInteractive: () => false,
      getRunPaths: () => runPaths,
      findingContract,
      findingLedgerStore: ledgerStore,
      observabilityEnabled: false,
      emitEvent: vi.fn(),
    } as unknown as ConstructorParameters<typeof TeamLeaderRunner>[0]);
    const step: WorkflowStep = {
      name: 'fix',
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'fix findings',
      edit: true,
      teamLeader: {
        mode: 'finding_contract_fix',
        maxConcurrency: 2,
        timeoutMs: 1000,
        partPersona: 'coder',
        partEdit: true,
      },
    };
    const state = makeState();

    const result = await runner.runTeamLeaderStep(step, state, 'task', 20, vi.fn());

    expect(result.response.structuredOutput).toEqual({
      decision: 'complete',
      reasoning: 'all covered',
      fixCoverage: expect.any(Array),
    });
    expect(completeRuleMatched).toBe(true);
    expect(result.response.content).not.toContain('FIRST_RAW');
    expect(result.response.content).not.toContain('SECOND_RAW');
    expect(leaderContext).toEqual({ mode: 'omit' });
    const decompositionOptions = structuredCaller.decomposeTask.mock.calls[0]?.[2];
    expect(decompositionOptions?.findingContract.actionableFindings).toContain('F-0001');
    expect(decompositionOptions?.findingContract.actionableFindings).toContain('F-0002');
    expect(decompositionOptions?.findingContract.actionableFindings).not.toContain('R-0001');
    expect(decompositionOptions?.findingContract.actionableFindings).not.toContain('R-0002');
    const firstWorkerInstruction = executeAgentMock.mock.calls[0]?.[1] as string;
    const secondWorkerInstruction = executeAgentMock.mock.calls[1]?.[1] as string;
    expect(firstWorkerInstruction).toContain('## Finding Contract Part Assignment');
    expect(firstWorkerInstruction).toContain('src/first.ts');
    expect(firstWorkerInstruction).not.toContain('src/second.ts');
    expect(firstWorkerInstruction).toContain('F-0001');
    expect(firstWorkerInstruction).toContain('R-0001');
    expect(firstWorkerInstruction).not.toContain('F-0002');
    expect(firstWorkerInstruction).not.toContain('R-0002');
    expect(secondWorkerInstruction).toContain('src/second.ts');
    expect(secondWorkerInstruction).toContain('F-0002');
    expect(secondWorkerInstruction).toContain('R-0002');
    expect(secondWorkerInstruction).not.toContain('F-0001');
    expect(secondWorkerInstruction).not.toContain('R-0001');
    expect(firstWorkerInstruction).not.toContain('.takt/finding-ledger.json');
    expect(executeAgentMock).toHaveBeenCalledTimes(3);
    expect(structuredCaller.requestMoreParts).toHaveBeenCalledTimes(4);
    const firstFeedbackOptions = structuredCaller.requestMoreParts.mock.calls[0]?.[3];
    const secondFeedbackOptions = structuredCaller.requestMoreParts.mock.calls[1]?.[3];
    const thirdFeedbackOptions = structuredCaller.requestMoreParts.mock.calls[2]?.[3];
    const fourthFeedbackOptions = structuredCaller.requestMoreParts.mock.calls[3]?.[3];
    expect(firstFeedbackOptions?.findingContract.completedPartIndex).toEqual([]);
    expect(firstFeedbackOptions?.findingContract.recovery).toEqual(expect.objectContaining({
      attempt: 1,
      mode: 'normal',
    }));
    expect(secondFeedbackOptions?.findingContract.recovery).toEqual(expect.objectContaining({
      attempt: 2,
      mode: 'normal',
      latestRejection: expect.objectContaining({
        attempt: 1,
        issueFingerprint: expect.any(String),
      }),
    }));
    expect(thirdFeedbackOptions?.findingContract.recovery).toEqual(expect.objectContaining({
      attempt: 3,
      mode: 'strict',
      strictReason: 'evidence_or_reference_issue',
    }));
    expect(fourthFeedbackOptions?.findingContract.recovery).toEqual(expect.objectContaining({
      attempt: 1,
      mode: 'normal',
    }));
    const attemptDirectory = readdirSync(join(runPaths.contextAbs, 'team_leader', 'fix'))
      .find((entry) => entry.startsWith('attempt-'));
    if (attemptDirectory === undefined) throw new Error('Missing Team Leader attempt directory');
    const auditRecords = readFileSync(
      join(runPaths.contextAbs, 'team_leader', 'fix', attemptDirectory, 'decision-recovery.jsonl'),
      'utf8',
    ).trim().split('\n').map((line) => JSON.parse(line) as {
      type: string;
      attempt: number;
      mode: string;
      boundaryId: string;
    });
    expect(auditRecords.map((record) => [record.type, record.attempt, record.mode])).toEqual([
      ['started', 1, 'normal'],
      ['rejected', 1, 'normal'],
      ['started', 2, 'normal'],
      ['rejected', 2, 'normal'],
      ['started', 3, 'strict'],
      ['accepted', 3, 'strict'],
      ['started', 1, 'normal'],
      ['accepted', 1, 'normal'],
    ]);
    expect(new Set(auditRecords.map((record) => record.boundaryId))).toEqual(new Set([
      `${attemptDirectory.slice('attempt-'.length)}:feedback:1`,
      `${attemptDirectory.slice('attempt-'.length)}:feedback:2`,
    ]));
  });
});
