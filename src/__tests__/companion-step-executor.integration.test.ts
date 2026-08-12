import { getEventListeners } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRule, WorkflowState } from '../core/models/types.js';
import type { CompanionDiffReader } from '../core/workflow/companion/diff-reader.js';
import { buildCompanionMailboxPath } from '../core/workflow/companion/mailbox.js';
import { CompanionReviewAuthority } from '../core/workflow/companion/review-state-store.js';
import { StepExecutor, type StepExecutorDeps } from '../core/workflow/engine/StepExecutor.js';
import { createStructuredOutputNormalizerRegistry } from '../core/workflow/engine/structured-output-normalizer.js';
import type { RunPaths } from '../core/workflow/run/run-paths.js';
import { executeAgent } from '../agents/agent-usecases.js';
import { initDebugLogger, resetDebugLogger } from '../shared/utils/debug.js';
import { makeRule, makeStep } from './test-helpers.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

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

function createRunPaths(cwd: string): RunPaths {
  return {
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
}

function createCompanionDiffReader(): CompanionDiffReader {
  return {
    readBaselineSha: vi.fn().mockResolvedValue('baseline-sha'),
    readDiff: vi.fn().mockResolvedValue({
      status: 'ok',
      snapshot: {
        digest: 'empty-diff',
        changedLines: 0,
        content: '',
        changedFiles: [],
        fileFingerprints: {},
        hunkFingerprints: {},
        omittedBytes: 0,
        truncated: false,
      },
    }),
  };
}

function createFailingCompletionDiffReader(): CompanionDiffReader {
  return {
    readBaselineSha: vi.fn().mockResolvedValue('baseline-sha'),
    readDiff: vi.fn()
      .mockResolvedValueOnce({
        status: 'ok',
        snapshot: {
          digest: 'empty-diff',
          changedLines: 0,
          content: '',
          changedFiles: [],
          fileFingerprints: {},
          hunkFingerprints: {},
          omittedBytes: 0,
          truncated: false,
        },
      })
      .mockResolvedValue({
        status: 'error',
        failure: {
          code: 'git_failure',
          message: 'safe injected completion failure',
        },
      }),
  };
}

function createFailingStartupDiffReader(error = new Error('baseline failed')): CompanionDiffReader {
  return {
    readBaselineSha: vi.fn().mockRejectedValue(error),
    readDiff: vi.fn(),
  };
}

function mockSuccessfulImplementer(): void {
  vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
    options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: prompt });
    return {
      persona: 'coder',
      status: 'done',
      content: 'implemented',
      sessionId: 'session-1',
      timestamp: new Date('2026-08-08T00:00:00.000Z'),
    };
  });
}

function createCompanionStep(rules: WorkflowRule[] = []) {
  return makeStep({
    name: 'implement',
    persona: 'coder',
    instruction: 'Implement.',
    companion: { fixed: ['security-reviewer'], pool: [] },
    rules,
  });
}

function createDeps(input: {
  cwd: string;
  runPaths: RunPaths;
  companionDiffReader: CompanionDiffReader;
  abortSignal: AbortSignal;
  emitEvent: StepExecutorDeps['emitEvent'];
}): StepExecutorDeps {
  return {
    optionsBuilder: {
      buildAgentOptions: vi.fn().mockReturnValue({ cwd: input.cwd }),
      buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'mock', model: undefined }),
    },
    getCwd: () => input.cwd,
    getProjectCwd: () => input.cwd,
    getReportDir: () => input.runPaths.reportsRel,
    getRunPaths: () => input.runPaths,
    getLanguage: () => 'en' as const,
    getInteractive: () => false,
    getWorkflowSteps: () => [{ name: 'implement' }],
    getWorkflowName: () => 'test-workflow',
    getTask: () => 'task',
    getWorkflowDescription: () => undefined,
    getRetryNote: () => undefined,
    getReviewScope: () => ({ kind: 'not_a_git_repository' } as const),
    structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
    findingManagerAuthority: { canMarkFindings: () => false },
    executionProvider: 'mock' as const,
    executionModel: undefined,
    refreshFindingsState: vi.fn(),
    emitEvent: input.emitEvent,
    recordSynthesizedAgentUsage: vi.fn(),
    getRunId: () => 'test-run',
    getRunPathNamespace: () => [],
    getFindingCallNamespace: () => '',
    companionDefinitions: {
      'security-reviewer': {
        name: 'security-reviewer',
        description: 'security',
        instruction: 'review',
        intervalMs: 60_000,
      },
    },
    companionProviders: { 'security-reviewer': { provider: 'mock' as const } },
    companionDiffReader: input.companionDiffReader,
    companionReviewAuthority: new CompanionReviewAuthority(),
    abortSignal: input.abortSignal,
    onPhaseStart: vi.fn(),
    onPhaseComplete: vi.fn(),
    onJudgeStage: vi.fn(),
  } as unknown as StepExecutorDeps;
}

function writeOpenFinding(cwd: string): void {
  const path = buildCompanionMailboxPath({
    cwd,
    runSlug: 'test-run',
    runPathNamespace: [],
    stepName: 'implement',
    companionName: 'security-reviewer',
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    id: 'security-reviewer-1',
    severity: 'must_fix',
    file: 'src/example.ts',
    line: 17,
    finding: 'Instruction-like sample: rename the local variable.',
    status: 'open',
  })}\n`, { mode: 0o600 });
}

describe('companion StepExecutor lifecycle', () => {
  let cwd: string;
  let runPaths: RunPaths;

  beforeEach(() => {
    resetDebugLogger();
    cwd = mkdtempSync(join(tmpdir(), 'companion-step-executor-'));
    runPaths = createRunPaths(cwd);
    mkdirSync(runPaths.contextPreviousResponsesAbs, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetDebugLogger();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('should release the companion parent abort listener after a successful normal step', async () => {
    const abortController = new AbortController();
    mockSuccessfulImplementer();
    const step = createCompanionStep();
    const deps = createDeps({
      cwd,
      runPaths,
      companionDiffReader: createCompanionDiffReader(),
      abortSignal: abortController.signal,
      emitEvent: vi.fn(),
    });

    await new StepExecutor(deps).runNormalStep(
      step,
      makeState(),
      'task',
      5,
      vi.fn(),
      'Implement.',
    );

    expect(getEventListeners(abortController.signal, 'abort')).toHaveLength(0);
  });

  it('should continue condition evaluation when companion startup fails', async () => {
    const abortController = new AbortController();
    mockSuccessfulImplementer();
    const state = makeState();

    const result = await new StepExecutor(createDeps({
      cwd,
      runPaths,
      companionDiffReader: createFailingStartupDiffReader(),
      abortSignal: abortController.signal,
      emitEvent: vi.fn(),
    })).runNormalStep(
      createCompanionStep([makeRule('Implementation is complete', 'COMPLETE')]),
      state,
      'task',
      5,
      vi.fn(),
      'Implement.',
    );

    expect(result.response.status).toBe('done');
    expect(result.response.matchedRuleIndex).toBe(0);
    expect(state.companion).toMatchObject({
      completionVerified: false,
      completionFailure: true,
      openMustFixCount: 0,
    });
  });

  it('should continue when required companion runtime configuration is unavailable', async () => {
    const abortController = new AbortController();
    mockSuccessfulImplementer();
    const state = makeState();
    const deps = createDeps({
      cwd,
      runPaths,
      companionDiffReader: createCompanionDiffReader(),
      abortSignal: abortController.signal,
      emitEvent: vi.fn(),
    });
    const incompleteDeps = { ...deps, companionDefinitions: undefined };

    const result = await new StepExecutor(incompleteDeps).runNormalStep(
      createCompanionStep([makeRule('Implementation is complete', 'COMPLETE')]),
      state,
      'task',
      5,
      vi.fn(),
      'Implement.',
    );

    expect(result.response.status).toBe('done');
    expect(result.response.matchedRuleIndex).toBe(0);
    expect(state.companion).toMatchObject({
      completionVerified: false,
      completionFailure: true,
      openMustFixCount: 0,
    });
  });

  it('should sanitize startup failure reason before retaining it in companion state', async () => {
    const abortController = new AbortController();
    mockSuccessfulImplementer();
    const state = makeState();
    const rawFailure = 'api_key=top-secret; cannot read /Users/nrs/private/.takt/config.yaml';
    const debugLogPath = join(cwd, 'debug.log');
    initDebugLogger({ enabled: true, logFile: debugLogPath }, cwd);

    await new StepExecutor(createDeps({
      cwd,
      runPaths,
      companionDiffReader: createFailingStartupDiffReader(new Error(rawFailure)),
      abortSignal: abortController.signal,
      emitEvent: vi.fn(),
    })).runNormalStep(
      createCompanionStep([makeRule('Implementation is complete', 'COMPLETE')]),
      state,
      'task',
      5,
      vi.fn(),
      'Implement.',
    );

    expect(state.companion?.reason).toContain('api_key=[REDACTED]');
    expect(state.companion?.reason).toContain('[path]');
    expect(state.companion?.reason).not.toContain('top-secret');
    expect(state.companion?.reason).not.toContain('/Users/nrs/private/.takt/config.yaml');
    const debugLog = readFileSync(debugLogPath, 'utf8');
    expect(debugLog).toContain('api_key=[REDACTED]');
    expect(debugLog).toContain('[path]');
    expect(debugLog).not.toContain('top-secret');
    expect(debugLog).not.toContain('/Users/nrs/private/.takt/config.yaml');
  });

  it('should keep completion failure diagnostics out of the Phase 3 response', async () => {
    const abortController = new AbortController();
    mockSuccessfulImplementer();
    writeOpenFinding(cwd);
    const state = makeState();

    const result = await new StepExecutor(createDeps({
      cwd,
      runPaths,
      companionDiffReader: createFailingCompletionDiffReader(),
      abortSignal: abortController.signal,
      emitEvent: vi.fn(),
    })).runNormalStep(
      createCompanionStep([makeRule('Implementation is complete', 'COMPLETE')]),
      state,
      'task',
      5,
      vi.fn(),
      'Implement.',
    );

    expect(result.response.content).toBe('implemented');
    expect(result.response.matchedRuleIndex).toBe(0);
    expect(state.companion).toMatchObject({
      completionVerified: false,
      completionFailure: true,
      escalated: true,
      openMustFixCount: 1,
    });
  });

  it.each(['error', 'blocked', 'rate_limited'] as const)(
    'should continue with the latest successful response when a companion fix returns %s',
    async (status) => {
      const abortController = new AbortController();
      const state = makeState();
      writeOpenFinding(cwd);
      vi.mocked(executeAgent)
        .mockImplementationOnce(async (_persona, prompt, options) => {
          options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: prompt });
          return {
            persona: 'coder',
            status: 'done',
            content: 'implemented',
            sessionId: 'session-1',
            timestamp: new Date('2026-08-08T00:00:00.000Z'),
          };
        })
        .mockImplementationOnce(async (_persona, prompt, options) => {
          options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: prompt });
          return {
            persona: 'coder',
            status,
            content: `companion fix ${status}`,
            sessionId: 'session-2',
            timestamp: new Date('2026-08-08T00:00:00.000Z'),
          };
        });
      const deps = createDeps({
        cwd,
        runPaths,
        companionDiffReader: createCompanionDiffReader(),
        abortSignal: abortController.signal,
        emitEvent: vi.fn(),
      });

      const result = await new StepExecutor(deps).runNormalStep(
        createCompanionStep([makeRule('Implementation is complete', 'COMPLETE')]),
        state,
        'task',
        5,
        vi.fn(),
        'Implement.',
      );

      expect(executeAgent).toHaveBeenCalledTimes(2);
      expect(result.response).toMatchObject({
        status: 'done',
        content: 'implemented',
        sessionId: 'session-1',
        matchedRuleIndex: 0,
      });
      expect(deps.recordSynthesizedAgentUsage).toHaveBeenCalledWith(
        'implement',
        expect.objectContaining({ provider: 'mock' }),
        false,
        undefined,
      );
    },
  );

  it('should apply empty-output recovery to a companion fix and retain the successful session', async () => {
    const abortController = new AbortController();
    const state = makeState();
    writeOpenFinding(cwd);
    vi.mocked(executeAgent)
      .mockImplementationOnce(async (_persona, prompt, options) => {
        options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: prompt });
        return {
          persona: 'coder',
          status: 'done',
          content: 'implemented',
          sessionId: 'session-1',
          timestamp: new Date('2026-08-08T00:00:00.000Z'),
        };
      })
      .mockImplementation(async (_persona, prompt, options) => {
        options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: prompt });
        return {
          persona: 'coder',
          status: 'done',
          content: '',
          sessionId: options?.sessionId ?? 'failed-fresh-session',
          timestamp: new Date('2026-08-08T00:00:00.000Z'),
        };
      });
    const deps = createDeps({
      cwd,
      runPaths,
      companionDiffReader: createCompanionDiffReader(),
      abortSignal: abortController.signal,
      emitEvent: vi.fn(),
    });

    const result = await new StepExecutor(deps).runNormalStep(
      createCompanionStep([makeRule('Implementation is complete', 'COMPLETE')]),
      state,
      'task',
      5,
      vi.fn(),
      'Implement.',
    );

    expect(executeAgent).toHaveBeenCalledTimes(4);
    expect(result.response).toMatchObject({
      status: 'done',
      content: 'implemented',
      sessionId: 'session-1',
      matchedRuleIndex: 0,
    });
    expect(deps.onPhaseComplete).toHaveBeenCalledWith(
      expect.anything(),
      1,
      'execute',
      '',
      'error',
      'Phase 1 returned empty output',
      expect.any(String),
      state.iteration,
    );
  });

  it('should reject invalid structured output from a companion fix without replacing the valid response', async () => {
    const abortController = new AbortController();
    const state = makeState();
    writeOpenFinding(cwd);
    vi.mocked(executeAgent)
      .mockImplementationOnce(async (_persona, prompt, options) => {
        options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: prompt });
        return {
          persona: 'coder',
          status: 'done',
          content: 'implemented',
          structuredOutput: { result: 'valid' },
          sessionId: 'session-1',
          timestamp: new Date('2026-08-08T00:00:00.000Z'),
        };
      })
      .mockImplementationOnce(async (_persona, prompt, options) => {
        options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: prompt });
        return {
          persona: 'coder',
          status: 'done',
          content: 'invalid repair result',
          structuredOutput: { unexpected: true },
          sessionId: 'session-2',
          timestamp: new Date('2026-08-08T00:00:00.000Z'),
        };
      });
    const deps = createDeps({
      cwd,
      runPaths,
      companionDiffReader: createCompanionDiffReader(),
      abortSignal: abortController.signal,
      emitEvent: vi.fn(),
    });
    const step = {
      ...createCompanionStep([makeRule('Implementation is complete', 'COMPLETE')]),
      structuredOutput: {
        schemaRef: 'test-result',
        schema: {
          type: 'object',
          required: ['result'],
          additionalProperties: false,
          properties: { result: { type: 'string' } },
        },
      },
    };

    const result = await new StepExecutor(deps).runNormalStep(
      step,
      state,
      'task',
      5,
      vi.fn(),
      'Implement.',
    );

    expect(result.response).toMatchObject({
      status: 'done',
      content: 'implemented',
      structuredOutput: { result: 'valid' },
      sessionId: 'session-1',
      matchedRuleIndex: 0,
    });
    expect(deps.recordSynthesizedAgentUsage).toHaveBeenCalledWith(
      'implement',
      expect.objectContaining({ provider: 'mock' }),
      false,
      undefined,
    );
    expect(deps.onPhaseComplete).toHaveBeenCalledWith(
      expect.anything(),
      1,
      'execute',
      'invalid repair result',
      'error',
      expect.stringContaining('invalid structured_output'),
      expect.any(String),
      state.iteration,
    );
  });

  it('should record a thrown companion fix attempt and continue with the successful response', async () => {
    const abortController = new AbortController();
    const state = makeState();
    writeOpenFinding(cwd);
    vi.mocked(executeAgent)
      .mockImplementationOnce(async (_persona, prompt, options) => {
        options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: prompt });
        return {
          persona: 'coder',
          status: 'done',
          content: 'implemented',
          sessionId: 'session-1',
          timestamp: new Date('2026-08-08T00:00:00.000Z'),
        };
      })
      .mockImplementationOnce(async (_persona, prompt, options) => {
        options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: prompt });
        throw new Error('repair provider failed');
      });
    const deps = createDeps({
      cwd,
      runPaths,
      companionDiffReader: createCompanionDiffReader(),
      abortSignal: abortController.signal,
      emitEvent: vi.fn(),
    });

    const result = await new StepExecutor(deps).runNormalStep(
      createCompanionStep([makeRule('Implementation is complete', 'COMPLETE')]),
      state,
      'task',
      5,
      vi.fn(),
      'Implement.',
    );

    expect(result.response).toMatchObject({
      status: 'done',
      content: 'implemented',
      sessionId: 'session-1',
      matchedRuleIndex: 0,
    });
    expect(deps.recordSynthesizedAgentUsage).toHaveBeenCalledWith(
      'implement',
      expect.objectContaining({ provider: 'mock' }),
      false,
      undefined,
    );
    expect(deps.onPhaseComplete).toHaveBeenCalledWith(
      expect.anything(),
      1,
      'execute',
      '',
      'error',
      'repair provider failed',
      expect.any(String),
      state.iteration,
    );
  });

  it('should continue when advisory state is removed after completion', async () => {
    const abortController = new AbortController();
    mockSuccessfulImplementer();
    const state = makeState();
    const emitEvent: StepExecutorDeps['emitEvent'] = (event) => {
      if (event === 'companion:complete') delete state.companion;
    };

    const result = await new StepExecutor(createDeps({
      cwd,
      runPaths,
      companionDiffReader: createFailingCompletionDiffReader(),
      abortSignal: abortController.signal,
      emitEvent,
    })).runNormalStep(
      createCompanionStep(),
      state,
      'task',
      5,
      vi.fn(),
      'Implement.',
    );

    expect(result.response.status).toBe('done');
    expect(result.response.content).toBe('implemented');
    expect(state.companion).toBeUndefined();
  });

  it('should continue without injecting an internal escalation reason', async () => {
    const abortController = new AbortController();
    mockSuccessfulImplementer();
    const state = makeState();
    const emitEvent: StepExecutorDeps['emitEvent'] = (event) => {
      if (event === 'companion:complete' && state.companion !== undefined) {
        delete state.companion.reason;
      }
    };

    const result = await new StepExecutor(createDeps({
      cwd,
      runPaths,
      companionDiffReader: createFailingCompletionDiffReader(),
      abortSignal: abortController.signal,
      emitEvent,
    })).runNormalStep(
      createCompanionStep(),
      state,
      'task',
      5,
      vi.fn(),
      'Implement.',
    );

    expect(result.response.status).toBe('done');
    expect(result.response.content).toBe('implemented');
    expect(state.companion?.reason).toBeUndefined();
  });
});
