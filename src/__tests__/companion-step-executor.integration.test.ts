import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowState } from '../core/models/types.js';
import type { CompanionDiffReader } from '../core/workflow/companion/diff-reader.js';
import { StepExecutor, type StepExecutorDeps } from '../core/workflow/engine/StepExecutor.js';
import { createStructuredOutputNormalizerRegistry } from '../core/workflow/engine/structured-output-normalizer.js';
import type { RunPaths } from '../core/workflow/run/run-paths.js';
import { executeAgent } from '../agents/agent-usecases.js';
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

function deps(input: {
  cwd: string;
  paths: RunPaths;
  companionEnabled: boolean;
  companionDiffReader: CompanionDiffReader;
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
    },
    companionProviders: { reviewer: { provider: 'mock' } },
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
    vi.mocked(executeAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: prompt });
      return {
        persona: 'coder',
        status: 'done',
        content: 'implemented',
        sessionId: 'session-1',
        timestamp: new Date('2026-08-14T00:00:00.000Z'),
      };
    });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
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
});
