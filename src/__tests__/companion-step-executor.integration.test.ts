import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowState } from '../core/models/types.js';
import type { CompanionDiffReader } from '../core/workflow/companion/diff-reader.js';
import { CompanionReviewQueue } from '../core/workflow/companion/review-queue.js';
import { CompanionStepRuntime } from '../core/workflow/companion/step-runtime.js';
import { StepExecutor, type StepExecutorDeps } from '../core/workflow/engine/StepExecutor.js';
import { createStructuredOutputNormalizerRegistry } from '../core/workflow/engine/structured-output-normalizer.js';
import type { RunPaths } from '../core/workflow/run/run-paths.js';
import { executeAgent } from '../agents/agent-usecases.js';
import { callMock, resetScenario, setMockScenario } from '../infra/mock/index.js';
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

  it('delivers moderator-accepted findings in a follow-up prompt after draining reviews', async () => {
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
            finding: 'Remove the unsafe assignment.',
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
      companionDiffReader: reviewableDiffReader(),
      emitEvent: vi.fn(),
    });
    const onStream = vi.fn();
    const onActivity = vi.fn();
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
    const createRuntime = vi.spyOn(CompanionStepRuntime, 'create');

    const result = await new StepExecutor(executorDeps)
      .runNormalStep(step, workflowState, 'task', 5, vi.fn(), 'Implement.');

    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({
      onStream,
      onActivity,
    }));
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
    expect(coderPrompts[1]).toContain('BEGIN COMPANION EVIDENCE');
    expect(coderPrompts[1]).toContain('Remove the unsafe assignment.');
    expect(result.response).toMatchObject({ status: 'done', content: 'fixed' });
    expect(workflowState.companion).toEqual({
      completionSettled: true,
      followUpRounds: 1,
    });
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

      const result = await new StepExecutor(deps({
        cwd,
        paths,
        companionEnabled: true,
        companionDiffReader: reviewableDiffReader(),
        emitEvent: vi.fn(),
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
    },
  );
});
