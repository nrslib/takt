import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamLeaderRunner } from '../core/workflow/engine/TeamLeaderRunner.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { createOperationJournalStore } from '../core/workflow/operations/operation-journal-store.js';
import type {
  AgentResponse,
  FindingContractConfig,
  FindingLedger,
  WorkflowState,
  WorkflowStep,
} from '../core/models/types.js';
import type { RuntimeStepResolution } from '../core/workflow/types.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import { evaluateWhenExpression } from '../core/workflow/evaluation/when-evaluator.js';

const { executeAgentMock } = vi.hoisted(() => ({ executeAgentMock: vi.fn() }));

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: executeAgentMock,
}));

const temporaryDirectories: string[] = [];

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
    const operationStore = createOperationJournalStore(runPaths.operationJournalAbs);
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
        sessionId: 'worker-session-1',
        structuredOutput: {
          findingOutcomes: [{ findingId: 'F-0001', outcome: 'disputed', evidence: ['inspected source'] }],
          changedPaths: ['src/first.ts'],
          checks: [{ command: 'npm test', status: 'passed' }],
          summary: 'first claim needs evidence correction',
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
        content: 'CORRECTED_FIRST_CLAIM',
        sessionId: 'worker-session-2',
        structuredOutput: {
          findingOutcomes: [{ findingId: 'F-0001', outcome: 'addressed', evidence: ['src/first.ts:10'] }],
          changedPaths: ['src/first.ts'],
          checks: [{ command: 'npm test', status: 'passed' }],
          summary: 'first claim needs evidence correction',
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
      blockers: [] as string[],
      fixCoverage: parts.map((part) => {
        const findingId = part.findingContract.findingIds[0];
        if (!findingId) throw new Error(`Missing finding assignment: ${part.id}`);
        return {
          findingId,
          disposition: 'addressed' as const,
          supportingPartIds: [part.id],
          verificationPartIds: [part.id === 'repair-first' ? verificationPart.id : part.id],
        };
      }),
    };
    const rawDecisionResponse = (structuredOutput: Record<string, unknown>): AgentResponse => ({
      persona: 'leader',
      status: 'done',
      content: JSON.stringify(structuredOutput),
      structuredOutput,
      timestamp: new Date(),
    });
    const structuredCaller = {
      judgeStatus: vi.fn(),
      evaluateCondition: vi.fn(),
      decomposeTask: vi.fn(async (_instruction, _max, options) => {
        options.onPromptResolved?.({ systemPrompt: 'system', userInstruction: 'leader instruction' });
        return { parts };
      }),
      requestDecompositionRawResponse: vi.fn(async (_instruction, _max, options) => {
        options.onPromptResolved?.({ systemPrompt: 'system', userInstruction: 'leader instruction' });
        return rawDecisionResponse({ parts });
      }),
      requestMoreParts: vi.fn()
        .mockResolvedValue({ done: true, reasoning: 'unused', parts: [] }),
      requestMorePartsRawResponse: vi.fn()
        .mockResolvedValueOnce(rawDecisionResponse({
          decision: 'continue',
          reasoning: 'invalid coverage',
          parts: [verificationPart],
          fixCoverage: [{
            findingId: 'F-0001',
            disposition: 'addressed',
            supportingPartIds: ['repair-first'],
            verificationPartIds: ['repair-first'],
          }],
          blockers: [],
        }))
        .mockResolvedValueOnce(rawDecisionResponse({
          ...completeDecision,
          reasoning: 'unsupported disposition',
          fixCoverage: completeDecision.fixCoverage.map((coverage) => (
            coverage.findingId === 'F-0001'
              ? { ...coverage, disposition: 'disputed' }
              : coverage
          )),
        }))
        .mockResolvedValueOnce(rawDecisionResponse({
          decision: 'continue',
          reasoning: 'verify first',
          parts: [verificationPart],
          fixCoverage: [],
          blockers: [],
        }))
        .mockResolvedValueOnce(rawDecisionResponse(completeDecision)),
    };
    let leaderContext: unknown;
    let completeRuleMatched = false;
    let postExecutionCalls = 0;
    let workflowStepIterations: Record<string, number> = { fix: 1 };
    const stepExecutor = {
      buildInstruction: vi.fn((step: WorkflowStep, _iteration, _state, _task, _max, _fallback, context) => {
        if (!step.name.includes('.')) leaderContext = context;
        return step.name.includes('.') ? step.instruction : 'leader instruction';
      }),
      buildPhase1Instruction: vi.fn((instruction: string) => instruction),
      normalizeStructuredOutput: vi.fn((_step, response: AgentResponse) => response),
      normalizeStructuredOutputWithDiagnostics: vi.fn((_step, response: AgentResponse) => ({
        response,
        invalidDetail: undefined,
      })),
      applyPostExecutionPhases: vi.fn(async (_step, state: WorkflowState, _iteration, response: AgentResponse) => {
        postExecutionCalls += 1;
        if (postExecutionCalls === 1) {
          throw new Error('simulated crash after accepted Team Leader boundaries');
        }
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
    const runnerDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({ cwd }),
        buildBaseOptions: vi.fn().mockReturnValue({}),
        buildResumeOptions: vi.fn((_step, sessionId) => ({
          cwd,
          sessionId,
          permissionMode: 'readonly',
          allowedTools: [],
        })),
        buildNewSessionReportOptions: vi.fn().mockReturnValue({
          cwd,
          permissionMode: 'readonly',
          allowedTools: [],
        }),
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
      getCurrentWorkflowStack: () => [{
        workflow: 'workflow',
        step: 'fix',
        kind: 'agent',
        step_iterations: workflowStepIterations,
      }],
      findingContract,
      findingLedgerStore: ledgerStore,
      operationJournal: {
        store: operationStore,
        journalRunSlug: runPaths.slug,
        claimToken: 'claim-a',
      },
      observabilityEnabled: false,
      emitEvent: vi.fn(),
    } as unknown as ConstructorParameters<typeof TeamLeaderRunner>[0];
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
    state.stepIterations.set('fix', 1);

    const firstRunner = new TeamLeaderRunner(runnerDeps);
    await expect(
      firstRunner.runTeamLeaderStep(step, state, 'task', 20, vi.fn(), undefined, 1),
    ).rejects.toThrow('simulated crash after accepted Team Leader boundaries');
    const callsBeforeResume = {
      worker: executeAgentMock.mock.calls.length,
      decomposition: structuredCaller.requestDecompositionRawResponse.mock.calls.length,
      decision: structuredCaller.requestMorePartsRawResponse.mock.calls.length,
    };
    workflowStepIterations = {
      fix: 1,
      'fix.repair-first': 1,
      'fix.repair-second': 1,
      'fix.verify-first': 1,
    };
    const resumedRunner = new TeamLeaderRunner({
      ...runnerDeps,
      operationJournal: {
        store: createOperationJournalStore(runPaths.operationJournalAbs),
        journalRunSlug: runPaths.slug,
        claimToken: 'claim-b',
        sourceClaimToken: 'claim-a',
      },
    });
    const result = await resumedRunner.runTeamLeaderStep(
      step,
      state,
      'task',
      20,
      vi.fn(),
      undefined,
      1,
    );

    expect(executeAgentMock).toHaveBeenCalledTimes(callsBeforeResume.worker);
    expect(structuredCaller.requestDecompositionRawResponse).toHaveBeenCalledTimes(callsBeforeResume.decomposition);
    expect(structuredCaller.requestMorePartsRawResponse).toHaveBeenCalledTimes(callsBeforeResume.decision);

    expect(result.response.structuredOutput).toEqual({
      decision: 'complete',
      reasoning: 'all covered',
      fixCoverage: expect.any(Array),
    });
    result.commitTransition?.({ kind: 'next_step', nextStep: 'COMPLETE' });
    expect(completeRuleMatched).toBe(true);
    expect(result.response.content).not.toContain('FIRST_RAW');
    expect(result.response.content).not.toContain('SECOND_RAW');
    expect(leaderContext).toEqual({ mode: 'omit' });
    const decompositionOptions = structuredCaller.requestDecompositionRawResponse.mock.calls[0]?.[2];
    expect(decompositionOptions?.findingContract.actionableFindings).toContain('F-0001');
    expect(decompositionOptions?.findingContract.actionableFindings).toContain('F-0002');
    expect(decompositionOptions?.findingContract.actionableFindings).not.toContain('R-0001');
    expect(decompositionOptions?.findingContract.actionableFindings).not.toContain('R-0002');
    const firstWorkerInstruction = executeAgentMock.mock.calls[0]?.[1] as string;
    const secondWorkerInstruction = executeAgentMock.mock.calls[1]?.[1] as string;
    const correctionInstruction = executeAgentMock.mock.calls[2]?.[1] as string;
    expect(firstWorkerInstruction).toContain('## Finding Contract Part Assignment');
    expect(firstWorkerInstruction).toContain('src/first.ts');
    expect(firstWorkerInstruction).not.toContain('src/second.ts');
    expect(firstWorkerInstruction).toContain('F-0001');
    expect(firstWorkerInstruction).toContain('R-0001');
    expect(firstWorkerInstruction).not.toContain('F-0002');
    expect(firstWorkerInstruction).not.toContain('R-0002');
    expect(secondWorkerInstruction).toContain('src/second.ts');
    expect(correctionInstruction).toContain('完了済み worker part の申告訂正専用フェーズ');
    expect(correctionInstruction).toContain('evidence.disputed_file_line');
    expect(executeAgentMock.mock.calls[2]?.[2]).toEqual(expect.objectContaining({
      sessionId: 'worker-session-1',
      permissionMode: 'readonly',
      allowedTools: [],
    }));
    expect(secondWorkerInstruction).toContain('F-0002');
    expect(secondWorkerInstruction).toContain('R-0002');
    expect(secondWorkerInstruction).not.toContain('F-0001');
    expect(secondWorkerInstruction).not.toContain('R-0001');
    expect(firstWorkerInstruction).not.toContain('.takt/finding-ledger.json');
    expect(executeAgentMock).toHaveBeenCalledTimes(4);
    expect(state.stepIterations.get('fix.repair-first')).toBe(1);
    expect(state.stepIterations.get('fix.repair-second')).toBe(1);
    expect(state.stepIterations.get('fix.verify-first')).toBe(1);
    expect(structuredCaller.requestMorePartsRawResponse).toHaveBeenCalledTimes(4);
    const firstFeedbackOptions = structuredCaller.requestMorePartsRawResponse.mock.calls[0]?.[3];
    const secondFeedbackOptions = structuredCaller.requestMorePartsRawResponse.mock.calls[1]?.[3];
    const thirdFeedbackOptions = structuredCaller.requestMorePartsRawResponse.mock.calls[2]?.[3];
    const fourthFeedbackOptions = structuredCaller.requestMorePartsRawResponse.mock.calls[3]?.[3];
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
      .find((entry) => (
        entry.startsWith('attempt-')
        && existsSync(join(
          runPaths.contextAbs,
          'team_leader',
          'fix',
          entry,
          'finding-contract-recovery.jsonl',
        ))
      ));
    if (attemptDirectory === undefined) throw new Error('Missing Team Leader attempt directory');
    const auditRecords = readFileSync(
      join(runPaths.contextAbs, 'team_leader', 'fix', attemptDirectory, 'finding-contract-recovery.jsonl'),
      'utf8',
    ).trim().split('\n').map((line) => JSON.parse(line) as {
      type: string;
      attempt: number;
      mode: string;
      boundaryId: string;
      attemptToken: string;
      rawOutputDigest?: { hash: string };
      normalizedOutputDigest?: { hash: string };
    });
    expect(auditRecords.map((record) => [record.type, record.attempt, record.mode])).toEqual([
      ['started', 1, 'normal'],
      ['accepted', 1, 'normal'],
      ['rejected', 0, 'strict'],
      ['started', 1, 'strict'],
      ['accepted', 1, 'strict'],
      ['started', 1, 'normal'],
      ['rejected', 1, 'normal'],
      ['started', 2, 'normal'],
      ['rejected', 2, 'strict'],
      ['started', 3, 'strict'],
      ['accepted', 3, 'strict'],
      ['started', 1, 'normal'],
      ['accepted', 1, 'normal'],
    ]);
    expect(new Set(auditRecords.map((record) => record.boundaryId))).toEqual(new Set([
      'decomposition',
      'part:repair-first:completion',
      'feedback:1',
      'feedback:2',
    ]));
    expect(auditRecords.every((record) => record.attemptToken.length > 0)).toBe(true);
    expect(auditRecords.filter((record) => record.type === 'accepted')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rawOutputDigest: expect.objectContaining({ hash: expect.any(String) }),
          normalizedOutputDigest: expect.objectContaining({ hash: expect.any(String) }),
        }),
      ]),
    );
    const [operation] = operationStore.listParents();
    if (operation === undefined) throw new Error('Missing Team Leader operation');
    expect(operation.stage).toBe('completed');
    expect(operation.owner).toEqual({ generation: 1, claimToken: 'claim-b' });
    expect(new Set(operation.children.map((child) => child.id))).toEqual(new Set([
      'decomposition',
      'part:repair-first:completion',
      'part:repair-second:completion',
      'part:verify-first:completion',
      'feedback:1',
      'feedback:2',
    ]));
    expect(operation.children.every((child) => child.stage === 'completed')).toBe(true);
    expect(
      operation.children.find((child) => child.id === 'part:repair-first:completion')?.attempts,
    ).toHaveLength(3);
  }, 30_000);

  it('redispatches a rate-limited part with the fallback provider instead of replaying it', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-finding-contract-rate-limit-'));
    temporaryDirectories.push(cwd);
    const runPaths = buildRunPaths(cwd, 'run-rate-limit');
    mkdirSync(runPaths.contextAbs, { recursive: true });
    const operationStore = createOperationJournalStore(runPaths.operationJournalAbs);
    const fullLedger = makeLedger();
    const ledger: FindingLedger = {
      ...fullLedger,
      findings: fullLedger.findings.filter((finding) => finding.id === 'F-0002'),
      rawFindings: fullLedger.rawFindings.filter(
        (finding) => finding.rawFindingId === 'R-0002',
      ),
    };
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
    const part = {
      id: 'repair',
      title: 'Repair',
      instruction: 'repair finding',
      findingContract: {
        findingIds: ['F-0002'],
        role: 'repair' as const,
        writePaths: ['src/second.ts'],
        readPaths: [],
      },
    };
    executeAgentMock
      .mockResolvedValueOnce({
        persona: 'coder',
        status: 'rate_limited',
        content: 'rate limited',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'coder',
        status: 'done',
        content: 'fixed',
        structuredOutput: {
          findingOutcomes: [{
            findingId: 'F-0002',
            outcome: 'addressed',
            evidence: ['src/second.ts:20'],
          }],
          changedPaths: ['src/second.ts'],
          checks: [{ command: 'npm test', status: 'passed' }],
          summary: 'fixed with fallback provider',
        },
        timestamp: new Date(),
      });
    const rawResponse = (structuredOutput: Record<string, unknown>): AgentResponse => ({
      persona: 'leader',
      status: 'done',
      content: JSON.stringify(structuredOutput),
      structuredOutput,
      timestamp: new Date(),
    });
    const structuredCaller = {
      judgeStatus: vi.fn(),
      evaluateCondition: vi.fn(),
      decomposeTask: vi.fn(),
      requestDecompositionRawResponse: vi.fn(async (_instruction, _max, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'system',
          userInstruction: 'leader instruction',
        });
        return rawResponse({ parts: [part] });
      }),
      requestMoreParts: vi.fn(),
      requestMorePartsRawResponse: vi.fn(async () => rawResponse({
        decision: 'complete',
        reasoning: 'fixed',
        parts: [],
        blockers: [],
        fixCoverage: [{
          findingId: 'F-0002',
          disposition: 'addressed',
          supportingPartIds: ['repair'],
          verificationPartIds: ['repair'],
        }],
      })),
    };
    const stepExecutor = {
      buildInstruction: vi.fn((currentStep: WorkflowStep) => (
        currentStep.name.includes('.') ? currentStep.instruction : 'leader instruction'
      )),
      buildPhase1Instruction: vi.fn((instruction: string) => instruction),
      normalizeStructuredOutputWithDiagnostics: vi.fn((_step, response: AgentResponse) => ({
        response,
        invalidDetail: undefined,
      })),
      applyPostExecutionPhases: vi.fn(async (
        _step,
        _state,
        _iteration,
        response: AgentResponse,
      ) => response),
      persistPreviousResponseSnapshot: vi.fn(),
      emitStepReports: vi.fn(),
    };
    const resolveProvider = (runtime?: RuntimeStepResolution) => (
      runtime?.providerInfo ?? {
        provider: 'codex' as const,
        model: 'gpt-5',
        providerSource: 'step' as const,
        modelSource: 'step' as const,
      }
    );
    const optionsBuilder = {
      buildAgentOptions: vi.fn((_step, runtime?: RuntimeStepResolution) => ({
        cwd,
        resolvedProvider: resolveProvider(runtime).provider,
        resolvedModel: resolveProvider(runtime).model,
      })),
      buildBaseOptions: vi.fn().mockReturnValue({}),
      buildResumeOptions: vi.fn(),
      buildNewSessionReportOptions: vi.fn(),
      buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
      resolveMcpServersForStep: vi.fn().mockReturnValue(undefined),
      resolveStepProviderModel: vi.fn((_step, runtime?: RuntimeStepResolution) => (
        resolveProvider(runtime)
      )),
    };
    const runner = new TeamLeaderRunner({
      optionsBuilder,
      stepExecutor,
      engineOptions: { projectCwd: cwd, structuredCaller, language: 'ja' },
      getCwd: () => cwd,
      getWorkflowName: () => 'workflow',
      getInteractive: () => false,
      getRunPaths: () => runPaths,
      getCurrentWorkflowStack: () => [],
      findingContract,
      findingLedgerStore: ledgerStore,
      operationJournal: {
        store: operationStore,
        journalRunSlug: runPaths.slug,
        claimToken: 'claim-a',
      },
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
        maxConcurrency: 1,
        timeoutMs: 1000,
        partPersona: 'coder',
        partEdit: true,
      },
    };
    const state = makeState();
    state.stepIterations.set('fix', 1);

    const rateLimited = await runner.runTeamLeaderStep(
      step,
      state,
      'task',
      20,
      vi.fn(),
      undefined,
      1,
    );
    expect(rateLimited.response.status).toBe('rate_limited');
    const [rateLimitedOperation] = operationStore.listParents();
    if (rateLimitedOperation === undefined) {
      throw new Error('Missing rate-limited Team Leader operation');
    }
    expect(operationStore.getChild(
      rateLimitedOperation.id,
      'part:repair:completion',
    ).stage).toBe('running');
    state.stepIterations.set('fix', 1);

    const fallbackRuntime: RuntimeStepResolution = {
      providerInfo: {
        provider: 'claude-sdk',
        model: 'claude-sonnet',
        providerSource: 'step',
        modelSource: 'step',
      },
      fallback: {
        reason: 'rate_limited',
        reasonDetail: 'rate limited',
        originalIteration: 1,
        previousProvider: 'codex',
        previousModel: 'gpt-5',
        currentProvider: 'claude-sdk',
        currentModel: 'claude-sonnet',
        stepName: 'fix',
        reportDir: runPaths.reportsAbs,
      },
    };
    const completed = await runner.runTeamLeaderStep(
      step,
      state,
      'task',
      20,
      vi.fn(),
      fallbackRuntime,
      1,
    );

    expect(completed.response.status).toBe('done');
    expect(executeAgentMock).toHaveBeenCalledTimes(2);
    expect(optionsBuilder.buildAgentOptions.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        providerInfo: expect.objectContaining({ provider: 'claude-sdk' }),
      }),
    );
    expect(structuredCaller.requestDecompositionRawResponse).toHaveBeenCalledTimes(1);
    const [operation] = operationStore.listParents();
    expect(
      operation?.children.find((child) => child.id === 'part:repair:completion')?.stage,
    ).toBe('completed');
  }, 30_000);
});
