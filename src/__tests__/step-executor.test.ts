import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StepExecutor, type StepExecutorDeps } from '../core/workflow/engine/StepExecutor.js';
import { createStructuredOutputNormalizerRegistry } from '../core/workflow/engine/structured-output-normalizer.js';
import type { AgentResponse, WorkflowState } from '../core/models/types.js';
import type { RunPaths } from '../core/workflow/run/run-paths.js';
import {
  makeStep,
  makeWorkflowResumePointEntry,
} from './test-helpers.js';
import { createTeamLeaderPlanningStep } from '../core/workflow/engine/team-leader-common.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

vi.mock('../core/workflow/findings/contract-intake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/findings/contract-intake.js')>();
  return {
    ...actual,
    ingestFindingContractResults: vi.fn().mockResolvedValue({ status: 'updated' }),
  };
});

import { executeAgent } from '../agents/agent-usecases.js';
import { ingestFindingContractResults } from '../core/workflow/findings/contract-intake.js';
import { createRawFindingsStructuredOutput } from '../core/workflow/findings/manager-agent.js';
import { RawFindingsOutputValidationJsonSchema } from '../core/models/finding-schemas.js';
import { createFindingLedgerStore, type FindingManagerValidationReport } from '../core/workflow/findings/store.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { verifiedSourceQuoteFields } from './helpers/finding-evidence.js';
import { authorizeFindingLedgerFixture } from './helpers/finding-lifecycle-fixture.js';

function makeState(): WorkflowState {
  return {
    workflowName: 'test-workflow',
    currentStep: 'implement',
    iteration: 3,
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

describe('StepExecutor', () => {
  let cwd: string;
  let runPaths: RunPaths;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'step-executor-'));
    runPaths = {
      slug: 'test-run',
      runRootRel: '.takt/runs/test-run',
      reportsRel: '.takt/runs/test-run/reports',
      contextRel: '.takt/runs/test-run/context',
      contextKnowledgeRel: '.takt/runs/test-run/context/knowledge',
      contextPolicyRel: '.takt/runs/test-run/context/policy',
      contextPreviousResponsesRel: '.takt/runs/test-run/context/previous_responses',
      logsRel: '.takt/runs/test-run/logs',
      metaRel: '.takt/runs/test-run/meta.json',
      runRootAbs: join(cwd, '.takt/runs/test-run'),
      reportsAbs: join(cwd, '.takt/runs/test-run/reports'),
      contextAbs: join(cwd, '.takt/runs/test-run/context'),
      contextKnowledgeAbs: join(cwd, '.takt/runs/test-run/context/knowledge'),
      contextPolicyAbs: join(cwd, '.takt/runs/test-run/context/policy'),
      contextPreviousResponsesAbs: join(cwd, '.takt/runs/test-run/context/previous_responses'),
      logsAbs: join(cwd, '.takt/runs/test-run/logs'),
      metaAbs: join(cwd, '.takt/runs/test-run/meta.json'),
    };
    mkdirSync(runPaths.contextPreviousResponsesAbs, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('phase:start には structured_output 用に差し替えた実 instruction を渡す', async () => {
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'system prompt',
        userInstruction: prompt,
      });
      return {
        persona: 'coder',
        status: 'done',
        content: '```json\n{"result":"ok"}\n```',
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      };
    });

    const onPhaseStart = vi.fn();
    const step = makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Plan the next follow-up action.',
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'implement' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      onPhaseStart,
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    };
    const executor = new StepExecutor(deps);
    const state = makeState();

    const { instruction } = await executor.runNormalStep(
      step,
      state,
      'test task',
      5,
      vi.fn(),
      'Plan the next follow-up action.',
      undefined,
    );

    expect(onPhaseStart).toHaveBeenCalledWith(
      step,
      1,
      'execute',
      instruction,
      {
        systemPrompt: 'system prompt',
        userInstruction: instruction,
      },
      'implement:3:1:1',
      3,
    );
    expect(onPhaseStart).not.toHaveBeenCalledWith(
      step,
      1,
      'execute',
      'Plan the next follow-up action.',
      expect.anything(),
      undefined,
      3,
    );
  });

  it('active normal reviewerをfree-formで実行し、reviewer phase確定後に独立normalizer phaseを取り込む', async () => {
    const reviewerTimestamp = new Date('2026-07-29T01:00:00.000Z');
    const normalizedRawFinding = {
      rawExcerpt: 'A concrete defect.',
      candidate: {
        rawFindingId: null,
        relation: null,
        targetFindingId: null,
        familyTag: null,
        severity: null,
        title: null,
        description: 'A concrete defect.',
        suggestion: null,
        target: { kind: 'code', paths: ['src/example.ts'] },
        evidenceRequests: [],
      },
    };
    const reviewerResponse: AgentResponse = {
      persona: 'reviewer',
      status: 'done',
      content: '## Finding\n- **Issue:** A concrete defect.',
      sessionId: 'reviewer-session',
      timestamp: reviewerTimestamp,
    };
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'reviewer system',
        userInstruction: prompt,
      });
      return reviewerResponse;
    });

    const normalizeFindingIntake = vi.fn(async (_report, options) => {
      options.onPromptResolved?.({
        systemPrompt: 'normalizer system',
        userInstruction: 'normalizer prompt',
      });
      return {
        persona: 'default',
        status: 'done' as const,
        content: JSON.stringify({ rawFindings: [normalizedRawFinding] }),
        structuredOutput: { rawFindings: [normalizedRawFinding] },
        sessionId: 'discard-normalizer-session',
        timestamp: new Date('2026-07-29T01:00:01.000Z'),
      };
    });
    const onPhaseStart = vi.fn();
    const onPhaseComplete = vi.fn();
    const updatePersonaSession = vi.fn();
    const recordSynthesizedAgentUsage = vi.fn();
    const step = makeStep({
      name: 'review',
      persona: 'reviewer',
      instruction: 'Review.',
      outputContracts: [
        { name: 'review.md', format: 'review', formatRef: 'review-finding-contract' },
      ],
    });
    const findingContractContext = {
      ledgerSummary: '{"findings":[]}',
      reportLedgerSummary: '{"ids":[]}',
      hasOpenFindings: false,
      hasWaivedFindings: false,
      hasDismissedFindings: false,
      reviewer: {
        mode: 'freeform' as const,
        reviewScopeSnapshotId: 'snapshot-1',
      },
    };
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({
          cwd,
          reportDir: runPaths.reportsRel,
          language: 'en',
          lastResponse: reviewerResponse.content,
          getSessionId: () => undefined,
          resolveSessionKey: () => 'reviewer:mock',
          buildResumeOptions: () => ({}),
          buildNewSessionReportOptions: () => ({}),
          buildFallbackReportOptions: () => undefined,
          resolveReportFallbackProviderModel: () => undefined,
          updatePersonaSession: vi.fn(),
          resolveStepProviderModel: () => ({ provider: 'mock', model: 'reviewer-model' }),
        }),
        resolveStepProviderModel: vi.fn().mockReturnValue({
          provider: 'claude',
          model: 'sonnet',
        }),
        buildFindingContractInstructionContext: vi.fn().mockReturnValue(findingContractContext),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => 'en',
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'review' }],
      getWorkflowName: () => 'test-workflow',
      getTask: () => 'test task',
      getCurrentWorkflowStack: () => [
        makeWorkflowResumePointEntry({ step: 'review' }),
      ],
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      structuredCaller: {
        normalizeFindingIntake,
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      } as unknown as StepExecutorDeps['structuredCaller'],
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      intakeNormalize: {
        provider: 'mock',
        model: 'normalizer-model',
      },
      findingContract: {
        ledgerPath: '.takt/findings/ledger.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'Reconcile.',
          outputContract: 'Return JSON.',
        },
      },
      findingLedgerStore: {} as StepExecutorDeps['findingLedgerStore'],
      refreshFindingsState: vi.fn(),
      emitEvent: vi.fn(),
      recordSynthesizedAgentUsage,
      getRunId: () => 'test-run',
      getFindingCallNamespace: () => '',
      onPhaseStart,
      onPhaseComplete,
    };
    const executor = new StepExecutor(deps);
    const state = makeState();
    const prepared = executor.prepareNormalStepExecution(
      step,
      state,
      'test task',
      5,
      1,
    );

    expect(prepared.executableStep.structuredOutput).toBeUndefined();
    const result = await executor.runNormalStep(
      step,
      state,
      'test task',
      5,
      updatePersonaSession,
      undefined,
      undefined,
      prepared,
    );

    expect(normalizeFindingIntake).toHaveBeenCalledOnce();
    expect(normalizeFindingIntake).toHaveBeenCalledWith(
      reviewerResponse.content,
      expect.objectContaining({
        provider: 'mock',
        model: 'normalizer-model',
      }),
    );
    expect(result.response).toMatchObject({
      content: reviewerResponse.content,
      sessionId: reviewerResponse.sessionId,
      timestamp: reviewerTimestamp,
      structuredOutput: { rawFindings: [normalizedRawFinding] },
    });
    expect(updatePersonaSession).toHaveBeenCalledWith(
      expect.any(String),
      'reviewer-session',
    );
    expect(updatePersonaSession.mock.invocationCallOrder[0]).toBeLessThan(
      normalizeFindingIntake.mock.invocationCallOrder[0]!,
    );
    expect(onPhaseComplete.mock.calls.map(([phaseStep]) => phaseStep.name))
      .toEqual(['review', 'review:intake-normalize']);
    expect(onPhaseStart.mock.calls.map(([phaseStep]) => phaseStep.name))
      .toEqual(['review', 'review:intake-normalize']);
    expect(recordSynthesizedAgentUsage).toHaveBeenCalledWith(
      'review:intake-normalize',
      expect.objectContaining({ provider: 'mock', model: 'normalizer-model' }),
      true,
      undefined,
    );
    expect(ingestFindingContractResults).toHaveBeenCalledOnce();
    expect(
      vi.mocked(ingestFindingContractResults).mock.calls[0]?.[0]
        .subResults[0]?.reviewerRawResourceEnvelope,
    ).toMatchObject({
      itemCount: 1,
      itemSourceBytes: [expect.any(Number)],
    });
  });

  it('normalizerがprompt callback前にfail-fastしても合成phaseのstart/error/usageを記録する', async () => {
    const onPhaseStart = vi.fn();
    const onPhaseComplete = vi.fn();
    const recordSynthesizedAgentUsage = vi.fn();
    const executor = new StepExecutor({
      structuredCaller: {
        normalizeFindingIntake: vi.fn(async () => {
          throw new Error('normalizer failed');
        }),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      intakeNormalize: { provider: 'mock', model: 'normalizer-model' },
      getLanguage: () => 'en',
      getWorkflowName: () => 'test-workflow',
      observabilityEnabled: () => false,
      recordSynthesizedAgentUsage,
      onPhaseStart,
      onPhaseComplete,
    } as unknown as StepExecutorDeps);
    const step = makeStep({
      name: 'review',
      persona: 'reviewer',
      instruction: 'Review.',
    });

    await expect(executor.normalizeFindingIntakeReport(step, {
      persona: 'reviewer',
      status: 'done',
      content: 'Review report.',
      timestamp: new Date('2026-07-29T00:00:00.000Z'),
    }, 3)).rejects.toThrow('normalizer failed');

    expect(onPhaseStart).toHaveBeenCalledOnce();
    expect(onPhaseStart).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'review:intake-normalize' }),
      1,
      'execute',
      expect.stringContaining('Review report.'),
      expect.objectContaining({
        systemPrompt: '',
        userInstruction: expect.stringContaining('Review report.'),
      }),
      'review:intake-normalize:3:1:1',
      3,
    );
    expect(onPhaseComplete).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'review:intake-normalize' }),
      1,
      'execute',
      '',
      'error',
      'normalizer failed',
      'review:intake-normalize:3:1:1',
      3,
    );
    expect(recordSynthesizedAgentUsage).toHaveBeenCalledWith(
      'review:intake-normalize',
      expect.objectContaining({ provider: 'mock', model: 'normalizer-model' }),
      false,
      undefined,
    );
  });

  it('単独 reviewer は snapshot A/B 不一致を拒否し、non-open confirmation の意味を変えず audit-only で取り込む', async () => {
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src/fixed.ts'), 'const fixed = true;\n');
    initializeGitFixture(cwd, ['src/fixed.ts']);
    const evidence = verifiedSourceQuoteFields(cwd, 'src/fixed.ts', 1);
    const structuredOutput = createRawFindingsStructuredOutput(evidence.snapshotId);
    const reviewerRawFindings = [{
      rawExcerpt: 'Confirmed fixed.',
      candidate: {
        rawFindingId: 'confirmation-resolved',
        familyTag: 'bug',
        severity: 'high',
        title: 'Confirmed fixed',
        description: 'The previously reported issue remains fixed.',
        suggestion: null,
        relation: 'resolution_confirmation',
        targetFindingId: 'F-0001',
        target: { kind: 'code', paths: ['src/fixed.ts'] },
        evidenceRequests: [{
          kind: 'file_quote',
          path: 'src/fixed.ts',
          startLine: 1,
          endLine: 1,
          verbatimExcerpt: evidence.verbatimExcerpt,
        }],
      },
    }];
    expect(structuredOutput.validationSchema).toBe(RawFindingsOutputValidationJsonSchema);
    const findingContractContext = {
      ledgerSummary: { findings: [] },
      reportLedgerSummary: { ids: [] },
      hasOpenFindings: false,
      hasWaivedFindings: false,
      hasDismissedFindings: false,
      reviewer: {
        mode: 'structured',
        rawFindingsStructuredOutput: structuredOutput,
        reviewScopeSnapshotId: evidence.snapshotId,
      },
    };
    let agentCallCount = 0;
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'system prompt',
        userInstruction: prompt,
      });
      if (agentCallCount++ > 0) {
        return {
          persona: 'reviewer',
          status: 'done',
          content: '[]',
          timestamp: new Date('2026-07-22T00:00:01.000Z'),
        };
      }
      return {
        persona: 'reviewer',
        status: 'done',
        content: 'Confirmed fixed.',
        structuredOutput: { rawFindings: reviewerRawFindings },
        timestamp: new Date('2026-07-22T00:00:00.000Z'),
      };
    });
    const step = makeStep({
      name: 'review',
      persona: 'reviewer',
      instruction: 'Review the implementation.',
      outputContracts: [{ name: 'findings.json', format: 'json', formatRef: 'review-finding-contract' }],
    });
    const buildAgentOptions = vi.fn().mockReturnValue({});
    const buildFindingContractInstructionContext = vi.fn().mockReturnValue(findingContractContext);
    const reportDir = '.takt/runs/test-run/reports';
    mkdirSync(join(cwd, reportDir), { recursive: true });
    const findingLedgerStore = createFindingLedgerStore({
      projectCwd: cwd,
      runId: 'test-run',
      reportDir: join(cwd, reportDir),
      workflowName: 'test-workflow',
      ledgerPath: '.takt/findings/ledger.json',
      rawFindingsPath: '.takt/findings/raw',
    });
    await findingLedgerStore.updateLedger(() => ({
      ledger: authorizeFindingLedgerFixture({
        workflowName: 'test-workflow',
        nextId: 2,
        updatedAt: '2026-07-22T00:00:00.000Z',
        findings: [{
        id: 'F-0001',
        status: 'resolved',
        lifecycle: 'resolved',
        revision: 1,
        severity: 'high',
        title: 'Fixed issue',
        evidenceIds: [],
        reviewers: ['reviewer'],
        rawFindingIds: ['raw-existing'],
        firstSeen: { runId: 'old-run', stepName: 'review', timestamp: '2026-07-21T00:00:00.000Z' },
        lastSeen: { runId: 'old-run', stepName: 'review', timestamp: '2026-07-21T00:00:00.000Z' },
      }],
      evidenceRecords: [],
      rawFindings: [{
        rawFindingId: 'raw-existing',
        stepName: 'review',
        reviewer: 'reviewer',
        familyTag: 'bug',
        severity: 'high',
        title: 'Fixed issue',
        description: 'Previously reported issue.',
        suggestion: 'Keep the issue fixed.',
        relation: 'new',
        targetFindingId: null,
        evidence: [],
      }],
      conflicts: [],
        interpretations: [],
      }),
      result: undefined,
    }));
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions,
        buildPhaseRunnerContext: vi.fn().mockReturnValue({
          cwd,
          reportDir,
          language: 'en',
          lastResponse: 'No findings.',
          getSessionId: () => undefined,
          resolveSessionKey: () => 'reviewer:claude',
          buildResumeOptions: () => ({}),
          buildNewSessionReportOptions: () => ({}),
          buildFallbackReportOptions: () => undefined,
          resolveReportFallbackProviderModel: () => undefined,
          updatePersonaSession: vi.fn(),
          resolveStepProviderModel: () => ({ provider: 'claude', model: 'claude-sonnet' }),
        }),
        buildFindingContractInstructionContext,
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'claude', model: 'claude-sonnet' }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => reportDir,
      getRunPaths: () => runPaths,
      getLanguage: () => 'en',
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'review' }],
      getWorkflowName: () => 'test-workflow',
      getTask: () => 'review task',
      getCurrentWorkflowStack: () => [
        makeWorkflowResumePointEntry({ step: 'review' }),
      ],
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      structuredCaller: {
        evaluateCondition: vi.fn(), judgeStatus: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      findingContract: {
        ledgerPath: '.takt/findings/ledger.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: { persona: 'findings-manager', instruction: 'Reconcile.', outputContract: 'Return JSON.' },
      },
      findingLedgerStore,
      refreshFindingsState: vi.fn(),
      emitEvent: vi.fn(),
      recordSynthesizedAgentUsage: vi.fn(),
      getRunId: () => 'test-run',
      getFindingCallNamespace: () => '',
      onPhaseComplete: vi.fn(),
    };

    const executor = new StepExecutor(deps);
    const state = makeState();

    buildFindingContractInstructionContext.mockReturnValueOnce({
      ...findingContractContext,
      reviewer: {
        ...findingContractContext.reviewer!,
        reviewScopeSnapshotId: 'prompt-snapshot-B',
      },
    });
    const mismatchedPreparedExecution = executor.prepareNormalStepExecution(
      step,
      state,
      'review task',
      5,
      1,
    );
    expect(mismatchedPreparedExecution.findingContractContext?.reviewer?.reviewScopeSnapshotId)
      .toBe('prompt-snapshot-B');

    await expect(executor.runNormalStep(
      step,
      state,
      'review task',
      5,
      vi.fn(),
    )).rejects.toThrow('requires prepared execution input');

    const preparedExecution = executor.prepareNormalStepExecution(
      step,
      state,
      'review task',
      5,
      1,
    );

    const {
      findingContractContext: _findingContractContext,
      ...preparedExecutionWithoutFindingContractContext
    } = preparedExecution;
    await expect(executor.runNormalStep(
      step,
      state,
      'review task',
      5,
      vi.fn(),
      undefined,
      undefined,
      preparedExecutionWithoutFindingContractContext,
    )).rejects.toThrow(`Prepared reviewer step "${step.name}" is missing finding contract context`);

    const findingContractContextWithoutStructuredOutput = {
      ...findingContractContext,
      reviewer: undefined,
    };
    await expect(executor.runNormalStep(
      step,
      state,
      'review task',
      5,
      vi.fn(),
      undefined,
      undefined,
      {
        ...preparedExecution,
        findingContractContext: findingContractContextWithoutStructuredOutput,
      },
    )).rejects.toThrow(`Prepared reviewer step "${step.name}" is missing reviewer context`);

    await expect(executor.runNormalStep(
      step,
      state,
      'review task',
      5,
      vi.fn(),
      undefined,
      undefined,
      {
        ...preparedExecution,
        executableStep: {
          ...preparedExecution.executableStep,
          structuredOutput: createRawFindingsStructuredOutput(evidence.snapshotId),
        },
      },
    )).rejects.toThrow(`Prepared reviewer step "${step.name}" has mismatched structured output`);

    const actualContractIntake = await vi.importActual<typeof import('../core/workflow/findings/contract-intake.js')>(
      '../core/workflow/findings/contract-intake.js',
    );
    vi.mocked(ingestFindingContractResults).mockImplementationOnce(actualContractIntake.ingestFindingContractResults);
    const result = await executor.runNormalStep(
      step,
      state,
      'review task',
      5,
      vi.fn(),
      undefined,
      undefined,
      preparedExecution,
    );

    expect(buildFindingContractInstructionContext).toHaveBeenCalledWith(step, 'structured');
    expect(buildAgentOptions).toHaveBeenCalledWith(expect.objectContaining({
      structuredOutput,
    }), undefined);
    expect(result.instruction).not.toContain(evidence.snapshotId);
    expect(result.instruction).toContain(JSON.stringify(structuredOutput.schema, null, 2));
    expect(agentCallCount).toBe(2);
    expect(vi.mocked(executeAgent).mock.calls.some(
      ([, instruction]) => instruction.includes('Some of your raw findings have contradictory relation/targetFindingId labeling'),
    )).toBe(false);
    expect(ingestFindingContractResults).toHaveBeenCalledOnce();
    const intake = vi.mocked(ingestFindingContractResults).mock.calls[0]![0];
    expect(intake.subResults[0]?.relationClarification).toBeUndefined();
    expect(intake.subResults[0]?.reviewerRawResourceEnvelope).toMatchObject({
      itemCount: 1,
      itemSourceBytes: [expect.any(Number)],
      jsonBytes: expect.any(Number),
    });
    expect(intake.subResults[0]?.response.structuredOutput?.rawFindings).toEqual(reviewerRawFindings);
    const savedLedger = findingLedgerStore.loadLedger();
    expect(savedLedger.findings.find((finding) => finding.id === 'F-0001')?.status).toBe('resolved');
    expect(savedLedger.findings.every((finding) => finding.provisional === undefined)).toBe(true);
    const report = JSON.parse(readFileSync(
      join(cwd, reportDir, 'findings-manager-validation.review.json'),
      'utf-8',
    )) as FindingManagerValidationReport;
    expect(report.unsupportedRawFindings?.some(
      (entry) => entry.rawFindingId.endsWith(':confirmation-resolved'),
    )).toBe(true);
    expect(report.rawNormalizations?.find(
      (entry) => entry.rawFindingId.endsWith(':confirmation-resolved'),
    )?.ambiguityCodes).toContain('confirmation-target-not-open');
    expect(report.interpretationStats?.managerCalls).toBe(0);
  });

  it('provider が未解決なら structured_output を fail fast にする', () => {
    const step = makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Plan the next follow-up action.',
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: undefined, model: undefined }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'implement' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    };
    const executor = new StepExecutor(deps);

    expect(() => executor.buildPhase1Instruction(
      'Plan the next follow-up action.',
      step,
      undefined,
    )).toThrow(/structured_output.*provider is not resolved/i);
  });

  it('非native structured_output fallback は解決済みワークフロー言語を使う', () => {
    const executor = new StepExecutor({
      optionsBuilder: {
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
      },
      getLanguage: () => 'ja',
    } as unknown as StepExecutorDeps);
    const step = makeStep({
      structuredOutput: { schema: { type: 'object', properties: {}, required: [] } },
    });

    expect(executor.buildPhase1Instruction('指示', step)).toContain(
      '次の JSON schema に一致する fenced JSON block をちょうど1つ返してください',
    );
  });

  it('Team Leader親には完全な前回出力と Finding Contract ledger summary を同じ実 instruction 経路で渡す', () => {
    const previousTail = 'TAIL_FINDING: keep this review finding';
    const step = createTeamLeaderPlanningStep(makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Plan from {previous_response}',
      passPreviousResponse: true,
      teamLeader: {
        maxConcurrency: 2,
        timeoutMs: 1000,
      },
    }));
    const state = makeState();
    state.lastOutput = {
      persona: 'review',
      status: 'done',
      content: `${'x'.repeat(2500)}\n${previousTail}`,
      timestamp: new Date(),
    };
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildFindingContractInstructionContext: vi.fn().mockReturnValue({
          ledgerSummary: { openFinding: 'LEDGER_SUMMARY: preserve this' },
          reportLedgerSummary: {},
          hasOpenFindings: true,
          hasWaivedFindings: false,
          hasDismissedFindings: false,
        }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => 'en',
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'implement' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      structuredCaller: {
        evaluateCondition: vi.fn(), judgeStatus: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      refreshFindingsState: vi.fn(),
      emitEvent: vi.fn(),
      getRunId: () => 'run',
      getFindingCallNamespace: () => '',
    };

    const instruction = new StepExecutor(deps).buildInstruction(step, 1, state, 'implement feature', 5);

    expect(instruction).toContain(previousTail);
    expect(instruction).toContain('x'.repeat(2500));
    expect(instruction).toContain('LEDGER_SUMMARY: preserve this');
  });

  it('明示nullでは既定の Finding Contract context を注入しない', () => {
    const buildFindingContractInstructionContext = vi.fn().mockReturnValue({
      ledgerSummary: 'OUT_OF_SCOPE_FINDING',
      reportLedgerSummary: {},
      hasOpenFindings: true,
      hasWaivedFindings: false,
      hasDismissedFindings: false,
    });
    const step = makeStep({ name: 'fix.part', instruction: 'Scoped worker instruction' });
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildFindingContractInstructionContext,
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => 'en',
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'fix.part' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      structuredCaller: {
        evaluateCondition: vi.fn(), judgeStatus: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      refreshFindingsState: vi.fn(),
      emitEvent: vi.fn(),
      getRunId: () => 'run',
      getFindingCallNamespace: () => '',
    };

    const instruction = new StepExecutor(deps).buildInstruction(
      step,
      1,
      makeState(),
      'task',
      5,
      undefined,
      { mode: 'omit' },
    );

    expect(buildFindingContractInstructionContext).not.toHaveBeenCalled();
    expect(instruction).not.toContain('OUT_OF_SCOPE_FINDING');
    expect(instruction).not.toContain('full-ledger.json');
  });

  it('非対応 provider の structured_output fallback で required 欠落を失敗にする', async () => {
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'system prompt',
        userInstruction: prompt,
      });
      return {
        persona: 'coder',
        status: 'done',
        content: '```json\n{}\n```',
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      };
    });

    const step = makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Plan the next follow-up action.',
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'implement' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    };
    const executor = new StepExecutor(deps);
    const state = makeState();

    await expect(
      executor.runNormalStep(
        step,
        state,
        'test task',
        5,
        vi.fn(),
        'Plan the next follow-up action.',
        undefined,
      ),
    ).rejects.toThrow('Step "implement" requires structured_output for provider "cursor": $.result is required');
  });

  it('非対応 provider の structured_output fallback で additionalProperties false を強制する', async () => {
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'system prompt',
        userInstruction: prompt,
      });
      return {
        persona: 'coder',
        status: 'done',
        content: '```json\n{"result":"ok","extra":true}\n```',
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      };
    });

    const step = makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Plan the next follow-up action.',
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'implement' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    };
    const executor = new StepExecutor(deps);
    const state = makeState();

    await expect(
      executor.runNormalStep(
        step,
        state,
        'test task',
        5,
        vi.fn(),
        'Plan the next follow-up action.',
        undefined,
      ),
    ).rejects.toThrow(
      'Step "implement" requires structured_output for provider "cursor": $.extra is not allowed by the schema',
    );
  });

  it('非対応 provider の structured_output fallback で oneOf と format を含む schema を受け付ける', async () => {
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'system prompt',
        userInstruction: prompt,
      });
      return {
        persona: 'coder',
        status: 'done',
        content: '```json\n{"result":"user@example.com"}\n```',
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      };
    });

    const step = makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Plan the next follow-up action.',
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            result: {
              oneOf: [
                { type: 'string', format: 'email' },
                { type: 'null' },
              ],
            },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'implement' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    };
    const executor = new StepExecutor(deps);
    const state = makeState();

    const { response } = await executor.runNormalStep(
      step,
      state,
      'test task',
      5,
      vi.fn(),
      'Plan the next follow-up action.',
      undefined,
    );

    expect(response.structuredOutput).toEqual({
      result: 'user@example.com',
    });
  });

  it('native structured output 対応 provider でも structuredOutput 欠落を通さない', async () => {
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'system prompt',
        userInstruction: prompt,
      });
      return {
        persona: 'coder',
        status: 'done',
        content: 'plain text response',
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      };
    });

    const step = makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Plan the next follow-up action.',
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'claude', model: 'sonnet' }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'implement' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    };
    const executor = new StepExecutor(deps);
    const state = makeState();

    await expect(
      executor.runNormalStep(
        step,
        state,
        'test task',
        5,
        vi.fn(),
        'Plan the next follow-up action.',
        undefined,
      ),
    ).rejects.toThrow('Step "implement" requires structured_output for provider "claude"');
  });

  it('native structured output 対応 provider でも required 欠落を通さない', async () => {
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'system prompt',
        userInstruction: prompt,
      });
      return {
        persona: 'coder',
        status: 'done',
        content: 'plain text response',
        structuredOutput: {},
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      };
    });

    const step = makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Plan the next follow-up action.',
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'claude', model: 'sonnet' }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'implement' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    };
    const executor = new StepExecutor(deps);
    const state = makeState();

    await expect(
      executor.runNormalStep(
        step,
        state,
        'test task',
        5,
        vi.fn(),
        'Plan the next follow-up action.',
        undefined,
      ),
    ).rejects.toThrow('Step "implement" requires structured_output for provider "claude": $.result is required');
  });

  it('native structured output 対応 provider でも additionalProperties false を強制する', async () => {
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'system prompt',
        userInstruction: prompt,
      });
      return {
        persona: 'coder',
        status: 'done',
        content: 'plain text response',
        structuredOutput: {
          result: 'ok',
          extra: true,
        },
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      };
    });

    const step = makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Plan the next follow-up action.',
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({}),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'claude', model: 'sonnet' }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'implement' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    };
    const executor = new StepExecutor(deps);
    const state = makeState();

    await expect(
      executor.runNormalStep(
        step,
        state,
        'test task',
        5,
        vi.fn(),
        'Plan the next follow-up action.',
        undefined,
      ),
    ).rejects.toThrow(
      'Step "implement" requires structured_output for provider "claude": $.extra is not allowed by the schema',
    );
  });
});
