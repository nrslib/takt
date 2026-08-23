import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionReviewMode, WorkflowState } from '../core/models/types.js';
import type { CompanionDiffReader } from '../core/workflow/companion/diff-reader.js';
import { CompanionReviewQueue } from '../core/workflow/companion/review-queue.js';
import { CompanionStepRuntime } from '../core/workflow/companion/step-runtime.js';
import { StepExecutor, type StepExecutorDeps } from '../core/workflow/engine/StepExecutor.js';
import { buildInactivityAbortSignal } from '../core/workflow/engine/abort-signal.js';
import {
  recordWorkflowStepProviderActivity,
  recordWorkflowStepProviderEventActivity,
} from '../core/workflow/engine/step-deadline.js';
import { createStructuredOutputNormalizerRegistry } from '../core/workflow/engine/structured-output-normalizer.js';
import type { RunPaths } from '../core/workflow/run/run-paths.js';
import { executeAgent } from '../agents/agent-usecases.js';
import { callMock, resetScenario, setMockScenario } from '../infra/mock/index.js';
import { loadWorkflowByIdentifier } from '../infra/config/index.js';
import type { LegacyProviderEnvironmentInput } from '../infra/config/runtime-provider/environment.js';
import { resolveRuntimeEnvironment } from '../infra/config/runtime-provider/provider-environment.js';
import { executeTaskWithResult } from '../features/tasks/execute/taskExecution.js';
import type { WorkflowExecutionEvent } from '../features/tasks/execute/types.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { makeStep } from './test-helpers.js';

vi.mock('../agents/agent-usecases.js', () => ({ executeAgent: vi.fn() }));

function state(): WorkflowState {
  return {
    workflowName: 'test-workflow',
    currentStep: 'implement',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    restoredStepIterationNames: new Set(),
    dynamicParallelSelections: new Map(),
    dynamicFacetSelections: new Map(),
    status: 'running',
  };
}

function runPaths(cwd: string): RunPaths {
  const runRootAbs = join(cwd, '.takt/runs/test-run');
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
    runRootAbs,
    reportsAbs: join(runRootAbs, 'reports'),
    contextAbs: join(runRootAbs, 'context'),
    contextKnowledgeAbs: join(runRootAbs, 'context/knowledge'),
    contextPolicyAbs: join(runRootAbs, 'context/policy'),
    contextPreviousResponsesAbs: join(runRootAbs, 'context/previous_responses'),
    logsAbs: join(runRootAbs, 'logs'),
    metaAbs: join(runRootAbs, 'meta.json'),
  };
}

function diffReader(): CompanionDiffReader {
  return {
    readBaselineSha: vi.fn().mockResolvedValue('baseline'),
    readDiff: vi.fn().mockResolvedValue({
      status: 'ok',
      snapshot: {
        digest: 'empty',
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

function reviewableDiffReader(): CompanionDiffReader {
  return {
    readBaselineSha: vi.fn().mockResolvedValue('baseline'),
    readDiff: vi.fn().mockResolvedValue({
      status: 'ok',
      snapshot: {
        digest: 'digest-1',
        changedLines: 1,
        content: '+const unsafe = true;\n',
        changedFiles: ['src/a.ts'],
        fileFingerprints: { 'src/a.ts': 'file-1' },
        hunkFingerprints: { 'src/a.ts:1-1': 'hunk-1' },
        omittedBytes: 0,
        truncated: false,
      },
    }),
  };
}

function deps(input: {
  cwd: string;
  paths: RunPaths;
  companionEnabled: boolean;
  companionReviewMode?: CompanionReviewMode;
  companionDiffReader: CompanionDiffReader;
  emitEvent: StepExecutorDeps['emitEvent'];
}): StepExecutorDeps {
  return {
    optionsBuilder: {
      buildAgentOptions: vi.fn().mockReturnValue({
        cwd: input.cwd,
        resolvedExecution: {
          provider: 'mock',
          model: undefined,
          providerOptions: undefined,
          permissionMode: 'edit',
        },
      }),
      buildProviderCallCallbacks: vi.fn().mockReturnValue({ finish: vi.fn() }),
      buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'mock', model: undefined }),
    },
    getCwd: () => input.cwd,
    getProjectCwd: () => input.cwd,
    getReportDir: () => input.paths.reportsRel,
    getRunPaths: () => input.paths,
    getFailureDir: () => join(input.paths.runRootAbs, 'failures'),
    getLanguage: () => 'en',
    getInteractive: () => false,
    getWorkflowSteps: () => [{ name: 'implement' }],
    getWorkflowName: () => 'test-workflow',
    getTask: () => 'task',
    getWorkflowDescription: () => undefined,
    getRetryNote: () => undefined,
    getReviewScope: () => ({ kind: 'not_a_git_repository' }),
    structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
    executionProvider: 'mock',
    executionModel: undefined,
    emitEvent: input.emitEvent,
    recordSynthesizedAgentUsage: vi.fn(),
    getRunId: () => 'test-run',
    getRunPathNamespace: () => [],
    companionEnabled: input.companionEnabled,
    companionReviewMode: input.companionReviewMode ?? 'completion',
    companionDefinitions: {
      reviewer: {
        name: 'reviewer',
        description: 'review',
        instruction: 'review',
        intervalMs: 60_000,
      },
      moderator: {
        name: 'moderator',
        description: 'moderate',
        instruction: 'moderate',
        intervalMs: 60_000,
      },
    },
    companionProviders: {
      reviewer: { provider: 'mock' },
      moderator: { provider: 'mock' },
    },
    companionDiffReader: input.companionDiffReader,
    onPhaseStart: vi.fn(),
    onPhaseComplete: vi.fn(),
    onJudgeStage: vi.fn(),
  } as unknown as StepExecutorDeps;
}

describe('companion StepExecutor lifecycle', () => {
  let cwd: string;
  let paths: RunPaths;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'companion-step-executor-'));
    paths = runPaths(cwd);
    mkdirSync(paths.contextPreviousResponsesAbs, { recursive: true });
    vi.mocked(executeAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: prompt });
      return callMock(options.internalAgentName ?? persona ?? 'default', prompt, options);
    });
  });

  afterEach(() => {
    resetScenario();
    rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('does not create or wait for a runtime when companion is disabled', async () => {
    const reader = diffReader();
    const emitEvent = vi.fn();
    const workflowState = state();
    const step = makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Implement.',
      companion: { fixed: ['reviewer'], pool: [] },
      rules: [],
    });

    const result = await new StepExecutor(deps({
      cwd,
      paths,
      companionEnabled: false,
      companionDiffReader: reader,
      emitEvent,
    })).runNormalStep(step, workflowState, 'task', 5, vi.fn(), 'Implement.');

    expect(result.response.status).toBe('done');
    expect(workflowState.companion).toBeUndefined();
    expect(reader.readBaselineSha).not.toHaveBeenCalled();
    expect(reader.readDiff).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledWith('companion:review_skipped', expect.objectContaining({
      reason: 'companion_disabled',
    }));
  });

  it('propagates runtime.yaml live mode from the task entry to a live commit review', async () => {
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'value.ts'), 'export const value = 1;\n', 'utf8');
    initializeGitFixture(cwd, ['src/value.ts']);
    mkdirSync(join(cwd, '.takt', 'workflows'), { recursive: true });
    mkdirSync(join(cwd, '.takt', 'companions'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'companions', 'reviewer.yaml'), [
      'name: reviewer',
      'description: Review implementation changes',
      'interval_ms: 60000',
    ].join('\n'), 'utf8');
    writeFileSync(join(cwd, '.takt', 'runtime.yaml'), [
      'version: 1',
      'companion:',
      '  enabled: true',
      '  review_mode: live',
      'provider:',
      '  defaults:',
      '    profile: default',
      '  profiles:',
      '    default:',
      '      provider: mock',
      '      model: mock-model',
      '    reviewer:',
      '      provider: mock',
      '      model: mock-model',
      '  targets:',
      '    companions:',
      '      reviewer:',
      '        profile: reviewer',
    ].join('\n'), 'utf8');
    writeFileSync(join(cwd, '.takt', 'workflows', 'task-live.yaml'), [
      'name: task-live',
      'initial_step: implement',
      'max_steps: 1',
      'steps:',
      '  - name: implement',
      '    persona: coder',
      '    instruction: Implement the requested change.',
      '    edit: true',
      '    allow_git_commit: true',
      '    companion: [reviewer]',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n'), 'utf8');

    expect(loadWorkflowByIdentifier('task-live', cwd)?.steps[0]).toMatchObject({
      companion: { fixed: ['reviewer'] },
      allowGitCommit: true,
    });
    const resolvedEnvironment = resolveRuntimeEnvironment({
      projectCwd: cwd,
      executionCwd: cwd,
      legacy: {
        provider: undefined,
        providerSource: 'default',
        model: undefined,
        modelSource: 'default',
        personaProviders: undefined,
        providerRouting: undefined,
        autoRouting: undefined,
        providerOptions: undefined,
      } satisfies LegacyProviderEnvironmentInput,
      legacySignals: [],
    });
    expect(resolvedEnvironment.companionEnabled).toBe(true);
    expect(resolvedEnvironment.companionReviewMode).toBe('live');
    setMockScenario([{
      persona: 'reviewer',
      status: 'done',
      content: 'reviewed',
      structuredOutput: { findings: [], notes: null },
    }]);
    let coderReleased!: () => void;
    const coderGate = new Promise<void>((resolve) => { coderReleased = resolve; });
    let coderReturned = false;
    vi.mocked(executeAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: prompt });
      if (persona === 'coder') {
        writeFileSync(join(cwd, 'src', 'value.ts'), 'export const value = 2;\n', 'utf8');
        options?.onStream?.({
          type: 'tool_use',
          data: {
            tool: 'Bash',
            input: { command: 'git commit -am "change"' },
            id: 'commit-1',
          },
        });
        await coderGate;
        coderReturned = true;
        return {
          persona: 'coder',
          status: 'done',
          content: 'implemented',
          timestamp: new Date(),
        };
      }
      return callMock(options?.internalAgentName ?? persona ?? 'default', prompt, options);
    });
    const events: WorkflowExecutionEvent[] = [];
    let taskPromise: ReturnType<typeof executeTaskWithResult> | undefined;

    try {
      taskPromise = executeTaskWithResult({
        task: 'Implement the requested change.',
        cwd,
        projectCwd: cwd,
        workflowIdentifier: 'task-live',
        outputMode: 'silent',
        eventSink: (event) => { events.push(event); },
      });
      let taskError: unknown;
      const taskOutcome = taskPromise.then(
        (result) => ({ result }),
        (error: unknown) => {
          taskError = error;
          return { error };
        },
      );

      await vi.waitFor(async () => {
        if (taskError !== undefined) throw taskError;
        expect(events).toEqual(expect.arrayContaining([
          expect.objectContaining({
            type: 'companion',
            action: 'review_round',
            reviewMode: 'live',
            trigger: 'commit',
          }),
        ]));
      }, { timeout: 30_000 });
      expect(coderReturned).toBe(false);
      coderReleased();
      const outcome = await taskOutcome;
      if ('error' in outcome) throw outcome.error;
      const result = outcome.result;

      expect(result.success).toBe(true);
      expect(events.filter((event) => (
        event.type === 'companion' && event.action === 'review_round'
      ))).toHaveLength(1);
    } finally {
      coderReleased();
      await taskPromise?.catch(() => undefined);
    }
  });

  it('delivers moderator-accepted findings in a follow-up prompt after draining reviews', async () => {
    const finding = 'Remove the unsafe assignment.';
    setMockScenario([
      { persona: 'coder', status: 'done', content: 'implemented' },
      {
        persona: 'reviewer',
        status: 'done',
        content: 'reviewed',
        structuredOutput: {
          findings: [{
            severity: 'must_fix',
            file: 'src/a.ts',
            line: 1,
            finding,
          }],
          notes: null,
        },
      },
      {
        persona: 'moderator',
        status: 'done',
        content: 'moderated',
        structuredOutput: {
          findings: [{ action: 'accept', sourceIndex: 0 }],
        },
      },
      { persona: 'coder', status: 'done', content: 'fixed' },
    ]);
    const drain = vi.spyOn(CompanionReviewQueue.prototype, 'drain');
    const workflowState = state();
    const step = makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Implement.',
      companion: { fixed: ['reviewer'], pool: [], moderator: 'moderator' },
      rules: [],
    });

    const executorDeps = deps({
      cwd,
      paths,
      companionEnabled: true,
      companionReviewMode: 'completion',
      companionDiffReader: reviewableDiffReader(),
      emitEvent: vi.fn(),
    });
    const onStream = vi.fn();
    const onActivity = vi.fn();
    const companionCallbackPairs: Array<{
      onStream: ReturnType<typeof vi.fn>;
      onActivity: ReturnType<typeof vi.fn>;
    }> = [];
    vi.mocked(executorDeps.optionsBuilder.buildAgentOptions).mockReturnValue({
      cwd,
      onStream,
      onActivity,
      resolvedExecution: {
        provider: 'mock',
        model: undefined,
        providerOptions: undefined,
        permissionMode: 'edit',
      },
    });
    vi.mocked(executorDeps.optionsBuilder.buildProviderCallCallbacks)
      .mockImplementation(() => {
        const callbacks = { onStream: vi.fn(), onActivity: vi.fn() };
        companionCallbackPairs.push(callbacks);
        return { ...callbacks, finish: vi.fn() };
      });
    const createRuntime = vi.spyOn(CompanionStepRuntime, 'create');

    const result = await new StepExecutor(executorDeps)
      .runNormalStep(step, workflowState, 'task', 5, vi.fn(), 'Implement.');

    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({
      buildProviderCallCallbacks: expect.any(Function),
    }));
    expect(vi.mocked(executorDeps.optionsBuilder.buildAgentOptions).mock.invocationCallOrder[0])
      .toBeLessThan(createRuntime.mock.invocationCallOrder[0]!);
    const runtimeInput = createRuntime.mock.calls[0]?.[0];
    expect(runtimeInput).toMatchObject({ reviewMode: 'completion' });
    expect(runtimeInput).not.toHaveProperty('onStream');
    expect(runtimeInput).not.toHaveProperty('onActivity');
    const executionUnitKeys = vi.mocked(executorDeps.optionsBuilder.buildProviderCallCallbacks)
      .mock.calls.map((call) => call[3]);
    expect(executionUnitKeys).toHaveLength(2);
    expect(new Set(executionUnitKeys).size).toBe(2);
    for (const key of executionUnitKeys) {
      expect(JSON.parse(key)).toEqual([
        'companion',
        'implement',
        expect.any(String),
        expect.stringMatching(/^(reviewer|moderator)$/),
        expect.any(Number),
      ]);
    }
    expect(companionCallbackPairs).toHaveLength(2);
    expect(companionCallbackPairs.every((callbacks) => callbacks.onStream !== onStream)).toBe(true);
    expect(companionCallbackPairs.every((callbacks) => callbacks.onActivity !== onActivity)).toBe(true);
    createRuntime.mockRestore();

    const executeAgentMock = vi.mocked(executeAgent);
    const coderCallIndices = executeAgentMock.mock.calls
      .flatMap(([persona], index) => persona === 'coder' ? [index] : []);
    const coderPrompts = coderCallIndices.map((index) => executeAgentMock.mock.calls[index]![1]);
    expect(drain).toHaveBeenCalled();
    expect(coderPrompts).toHaveLength(2);
    expect(drain.mock.invocationCallOrder[0]).toBeLessThan(
      executeAgentMock.mock.invocationCallOrder[coderCallIndices[1]!]!,
    );
    expect(coderPrompts[1]).toContain(finding);
    expect(result.response).toMatchObject({ status: 'done', content: 'fixed' });
    expect(workflowState.companion).toEqual({
      completionSettled: true,
      followUpRounds: 1,
    });
  });

  it('discards a failed queue attempt unfinished tool before retrying with a new execution unit', async () => {
    vi.useFakeTimers();
    const deadline = buildInactivityAbortSignal(100, undefined);
    try {
      setMockScenario([
        { persona: 'coder', status: 'done', content: 'implemented' },
        {
          persona: 'reviewer',
          status: 'error',
          content: 'provider retry',
        },
        {
          persona: 'reviewer',
          status: 'error',
          content: 'queue retry',
          streamEvents: [{
            type: 'tool_use',
            tool: 'Read',
            id: 'unfinished-tool',
            input: { path: 'src/a.ts' },
          }],
        },
        {
          persona: 'reviewer',
          status: 'done',
          content: 'reviewed',
          structuredOutput: { findings: [], notes: null },
        },
      ]);
      const executorDeps = deps({
        cwd,
        paths,
        companionEnabled: true,
        companionDiffReader: reviewableDiffReader(),
        emitEvent: vi.fn(),
      });
      vi.mocked(executorDeps.optionsBuilder.buildProviderCallCallbacks)
        .mockImplementation((_, __, ___, executionUnitKey) => ({
          onStream: (event) => recordWorkflowStepProviderEventActivity(
            deadline.recordActivity,
            executionUnitKey,
            event,
          ),
          onActivity: (activity) => recordWorkflowStepProviderActivity(
            deadline.recordActivity,
            executionUnitKey,
            activity,
          ),
          finish: () => deadline.recordActivity({
            kind: 'execution_unit_finished',
            executionUnitKey,
          }),
        }));
      const step = makeStep({
        name: 'implement',
        persona: 'coder',
        instruction: 'Implement.',
        companion: { fixed: ['reviewer'], pool: [] },
        rules: [],
      });

      await new StepExecutor(executorDeps)
        .runNormalStep(step, state(), 'task', 5, vi.fn(), 'Implement.');

      const executionUnitKeys = vi.mocked(executorDeps.optionsBuilder.buildProviderCallCallbacks)
        .mock.calls.map((call) => call[3]);
      expect(executionUnitKeys).toHaveLength(3);
      expect(executionUnitKeys[0]).toBe(executionUnitKeys[1]);
      expect(executionUnitKeys[2]).not.toBe(executionUnitKeys[1]);
      expect(JSON.parse(executionUnitKeys[0]!)).toEqual([
        'companion',
        'implement',
        'reviewer',
        'reviewer',
        1,
      ]);
      expect(JSON.parse(executionUnitKeys[2]!)).toEqual([
        'companion',
        'implement',
        'reviewer',
        'reviewer',
        2,
      ]);

      await vi.advanceTimersByTimeAsync(99);
      expect(deadline.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(deadline.signal.aborted).toBe(true);
    } finally {
      deadline.dispose();
      vi.useRealTimers();
    }
  });

  it.each(['error', 'rate_limited', 'blocked'] as const)(
    'records a %s companion follow-up failure and continues with the latest success',
    async (status) => {
      setMockScenario([
        { persona: 'coder', status: 'done', content: 'implemented' },
        {
          persona: 'reviewer',
          status: 'done',
          content: 'reviewed',
          structuredOutput: {
            findings: [{
              severity: 'should_fix',
              file: 'src/a.ts',
              line: 1,
              finding: 'Fix the accepted defect.',
            }],
            notes: null,
          },
        },
        {
          persona: 'moderator',
          status: 'done',
          content: 'moderated',
          structuredOutput: {
            findings: [{ action: 'accept', sourceIndex: 0 }],
          },
        },
        {
          persona: 'coder',
          status,
          content: `follow-up ${status}`,
          ...(status === 'error'
            ? { error: 'follow-up failed: token=secret at /private/project/file.ts' }
            : {}),
        },
      ]);
      const executeAgentMock = vi.mocked(executeAgent);
      executeAgentMock.mockImplementation(async (persona, prompt, options) => {
        options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: prompt });
        const response = await callMock(options.internalAgentName ?? persona ?? 'default', prompt, options);
        return persona === 'coder' && response.status === status
          ? { ...response, sessionId: undefined }
          : response;
      });
      const workflowState = state();
      const step = makeStep({
        name: 'implement',
        persona: 'coder',
        instruction: 'Implement.',
        companion: { fixed: ['reviewer'], pool: [], moderator: 'moderator' },
        rules: [],
      });

      const emitEvent = vi.fn();
      const result = await new StepExecutor(deps({
        cwd,
        paths,
        companionEnabled: true,
        companionDiffReader: reviewableDiffReader(),
        emitEvent,
      })).runNormalStep(step, workflowState, 'task', 5, vi.fn(), 'Implement.');

      expect(result.response).toMatchObject({ status: 'done', content: 'implemented' });
      const coderCalls = executeAgentMock.mock.calls.filter(([persona]) => persona === 'coder');
      expect(coderCalls).toHaveLength(2);
      expect(coderCalls[1]?.[2]?.sessionId).toBeDefined();
      expect(result.response.sessionId).toBe(coderCalls[1]?.[2]?.sessionId);
      expect(workflowState.stepOutputs.get('implement')).toBe(result.response);
      expect(workflowState.lastOutput).toBe(result.response);
      expect(workflowState.companion).toEqual({
        completionSettled: false,
        completionFailure: true,
        followUpRounds: 1,
        reason: status === 'error'
          ? 'follow-up failed: token=[REDACTED] at [path]'
          : `follow-up ${status}`,
      });
      const reason = status === 'error'
        ? 'follow-up failed: token=[REDACTED] at [path]'
        : `follow-up ${status}`;
      expect(emitEvent.mock.calls.filter(([event]) => event === 'companion:complete')).toEqual([
        ['companion:complete', {
          step: 'implement',
          completionSettled: false,
          completionFailure: true,
          followUpRounds: 1,
          reason,
        }],
      ]);
    },
  );

  it('continues completion retry when the fail-soft companion completion event throws', async () => {
    setMockScenario([
      { persona: 'coder', status: 'done', content: 'initial review' },
      {
        persona: 'reviewer',
        status: 'done',
        content: 'reviewed',
        structuredOutput: {
          findings: [{
            severity: 'should_fix',
            file: 'src/a.ts',
            line: 1,
            finding: 'Fix the accepted defect.',
          }],
          notes: null,
        },
      },
      {
        persona: 'moderator',
        status: 'done',
        content: 'moderated',
        structuredOutput: {
          findings: [{ action: 'accept', sourceIndex: 0 }],
        },
      },
      {
        persona: 'coder',
        status: 'error',
        content: 'follow-up failed',
        error: 'follow-up failed',
      },
      {
        persona: 'review-completion-judge',
        status: 'done',
        content: 'incomplete',
        structuredOutput: {
          complete: false,
          reason: 'consumer not checked',
          missing_paths: [{
            path: 'src/a.ts',
            reason: 'retry the review',
          }],
        },
      },
      { persona: 'coder', status: 'done', content: 'retry review complete' },
      {
        persona: 'review-completion-judge',
        status: 'done',
        content: 'complete',
        structuredOutput: {
          complete: true,
          reason: 'closed',
          missing_paths: [],
        },
      },
    ]);
    let companionCompleteEmissions = 0;
    const emitEvent = vi.fn((event: string) => {
      if (event === 'companion:complete' && companionCompleteEmissions++ === 0) {
        throw new Error('companion completion audit failed');
      }
    });
    const workflowState = state();
    const step = makeStep({
      name: 'implement',
      persona: 'coder',
      instruction: 'Implement.',
      companion: { fixed: ['reviewer'], pool: [], moderator: 'moderator' },
      completionRetry: {
        minRetry: 0,
        maxRetry: 1,
        retryInstruction: 'Recheck the identified gaps.',
      },
      rules: [],
    });

    const result = await new StepExecutor(deps({
      cwd,
      paths,
      companionEnabled: true,
      companionDiffReader: reviewableDiffReader(),
      emitEvent,
    })).runNormalStep(step, workflowState, 'task', 5, vi.fn(), 'Implement.');

    expect(result.response).toMatchObject({ status: 'done', content: 'retry review complete' });
    expect(workflowState.companion).toEqual({
      completionSettled: true,
      followUpRounds: 0,
    });
    const terminalEvents = emitEvent.mock.calls.filter(([event]) => event === 'companion:complete');
    expect(terminalEvents).toEqual([
      ['companion:complete', {
        step: 'implement',
        completionSettled: false,
        completionFailure: true,
        followUpRounds: 1,
        reason: 'follow-up failed',
      }],
      ['companion:complete', {
        step: 'implement',
        completionSettled: true,
        completionFailure: false,
        followUpRounds: 0,
      }],
    ]);
    const firstCompleteOrder = emitEvent.mock.invocationCallOrder[
      emitEvent.mock.calls.findIndex(([event]) => event === 'companion:complete')
    ]!;
    const retryStartOrder = emitEvent.mock.invocationCallOrder[
      emitEvent.mock.calls.findIndex(([event]) => event === 'review_completion:retry:start')
    ]!;
    const lastCompleteIndex = emitEvent.mock.calls.findLastIndex(
      ([event]) => event === 'companion:complete',
    );
    expect(firstCompleteOrder).toBeLessThan(retryStartOrder);
    expect(retryStartOrder).toBeLessThan(emitEvent.mock.invocationCallOrder[lastCompleteIndex]!);
  });
});
