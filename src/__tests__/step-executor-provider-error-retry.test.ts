import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse, WorkflowConfig, WorkflowState } from '../core/models/index.js';
import { buildRunPaths, type RunPaths } from '../core/workflow/run/run-paths.js';
import { StepExecutor, type StepExecutorDeps } from '../core/workflow/engine/StepExecutor.js';
import { createStructuredOutputNormalizerRegistry } from '../core/workflow/engine/structured-output-normalizer.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { AGENT_FAILURE_CATEGORIES } from '../shared/types/agent-failure.js';
import { makeStep } from './test-helpers.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

import { executeAgent } from '../agents/agent-usecases.js';

const PARSE_ERROR_MESSAGE = 'provider stream parse error: Failed to parse item: invalid stdout line';

function makeState(): WorkflowState {
  return {
    workflowName: 'test-workflow',
    currentStep: 'review',
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

function makeParseErrorResponse(): AgentResponse {
  return {
    persona: 'reviewer',
    status: 'error',
    content: '',
    error: PARSE_ERROR_MESSAGE,
    failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR,
    timestamp: new Date('2026-09-17T00:00:00.000Z'),
  };
}

function queueAgentResponse(response: AgentResponse): void {
  vi.mocked(executeAgent).mockImplementationOnce(async (_persona, instruction, options) => {
    options.onPromptResolved?.({
      systemPrompt: 'system prompt',
      userInstruction: instruction,
    });
    return response;
  });
}

function makeNormalDeps(cwd: string, runPaths: RunPaths): StepExecutorDeps {
  return {
    optionsBuilder: {
      buildAgentOptions: vi.fn().mockReturnValue({
        cwd,
        projectCwd: cwd,
        resolvedProvider: 'opencode',
        resolvedModel: 'opencode/big-pickle',
        sessionId: 'session-1',
      }),
      buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
      resolveStepProviderModel: vi.fn().mockReturnValue({
        provider: 'opencode',
        model: 'opencode/big-pickle',
      }),
    } as unknown as StepExecutorDeps['optionsBuilder'],
    getCwd: () => cwd,
    getProjectCwd: () => cwd,
    getReportDir: () => '.takt/runs/test-run/reports',
    getRunPaths: () => runPaths,
    getFailureDir: () => join(runPaths.runRootAbs, 'failures'),
    getLanguage: () => undefined,
    getInteractive: () => false,
    getWorkflowSteps: () => [{ name: 'review' }],
    getWorkflowName: () => 'test-workflow',
    getTask: () => 'task',
    getWorkflowDescription: () => undefined,
    getWorkflowRules: () => undefined,
    getRetryNote: () => undefined,
    getReviewScope: () => ({ kind: 'not_a_git_repository' } as const),
    structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
    emitEvent: vi.fn(),
    recordSynthesizedAgentUsage: vi.fn(),
    getRunId: () => 'test-run',
    getRunPathNamespace: () => [],
    companionEnabled: false,
    companionReviewMode: 'completion',
    executionProvider: 'opencode',
    executionModel: 'opencode/big-pickle',
  };
}

describe('StepExecutor provider error fresh retry', () => {
  let cwd: string;
  let runPaths: RunPaths;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'step-executor-provider-error-retry-'));
    runPaths = buildRunPaths(cwd, 'test-run');
    mkdirSync(runPaths.contextPreviousResponsesAbs, { recursive: true });
    vi.clearAllMocks();
    vi.mocked(executeAgent).mockReset();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('retries a normal step once in a fresh session after a provider stream parse error', async () => {
    const step = makeStep({
      name: 'review',
      persona: 'reviewer',
      personaDisplayName: 'reviewer',
      instruction: 'Review',
    });
    const sessionKey = '["reviewer","opencode","opencode/big-pickle"]';
    const state = makeState();
    state.personaSessions.set(sessionKey, 'session-1');
    const updatePersonaSession = vi.fn((key: string, sessionId: string | undefined) => {
      if (sessionId === undefined) state.personaSessions.delete(key);
      else state.personaSessions.set(key, sessionId);
    });
    queueAgentResponse(makeParseErrorResponse());
    queueAgentResponse({
      persona: 'reviewer',
      status: 'done',
      content: 'approved',
      sessionId: 'session-fresh',
      timestamp: new Date('2026-09-17T00:00:00.000Z'),
    });

    const result = await new StepExecutor(makeNormalDeps(cwd, runPaths))
      .runNormalStep(step, state, 'task', 5, updatePersonaSession);

    expect(result.response.status).toBe('done');
    expect(result.response.content).toBe('approved');
    expect(vi.mocked(executeAgent).mock.calls.map((call) => call[2].sessionId)).toEqual([
      'session-1',
      undefined,
    ]);
    expect(updatePersonaSession).toHaveBeenNthCalledWith(1, sessionKey, undefined);
    expect(updatePersonaSession).toHaveBeenLastCalledWith(sessionKey, 'session-fresh');
    expect(state.personaSessions.get(sessionKey)).toBe('session-fresh');
  });
});

describe('WorkflowEngine provider error fresh retry', () => {
  let projectCwd: string;

  beforeEach(() => {
    projectCwd = mkdtempSync(join(tmpdir(), 'engine-provider-error-retry-'));
    vi.clearAllMocks();
    vi.mocked(executeAgent).mockReset();
  });

  afterEach(() => {
    rmSync(projectCwd, { recursive: true, force: true });
  });

  it('aborts as step_error when a normal step fails with a parse error twice in a row', async () => {
    const config: WorkflowConfig = {
      name: 'provider-error-retry',
      description: 'provider error fresh retry test',
      initialStep: 'work',
      maxSteps: 1,
      steps: [{
        name: 'work',
        persona: 'coder',
        personaDisplayName: 'Coder',
        instruction: 'Execute the task',
        provider: 'mock',
        rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
      }],
    };
    const engine = new WorkflowEngine(
      config,
      projectCwd,
      'Trigger a provider parse failure',
      {
        projectCwd,
        provider: 'mock',
        reportDirName: 'provider-error-retry',
      },
    );
    let abortKind: string | undefined;
    engine.on('workflow:abort', (_state, _reason, kind) => {
      abortKind = kind;
    });
    queueAgentResponse(makeParseErrorResponse());
    queueAgentResponse(makeParseErrorResponse());

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortKind).toBe('step_error');
    expect(vi.mocked(executeAgent).mock.calls.map((call) => call[2].sessionId)).toEqual([
      undefined,
      undefined,
    ]);
  });
});
