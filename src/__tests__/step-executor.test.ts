import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StepExecutor, type StepExecutorDeps } from '../core/workflow/engine/StepExecutor.js';
import type { WorkflowState } from '../core/models/types.js';
import type { RunPaths } from '../core/workflow/run/run-paths.js';
import { makeStep } from './test-helpers.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

import { executeAgent } from '../agents/agent-usecases.js';

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
        buildPhaseRunnerContext: vi.fn(),
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
      detectRuleIndex: vi.fn().mockReturnValue(-1),
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
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

    expect(instruction).toContain('Return exactly one fenced JSON block');
    expect(onPhaseStart).toHaveBeenCalledWith(
      step,
      1,
      'execute',
      expect.stringContaining('Return exactly one fenced JSON block'),
      {
        systemPrompt: 'system prompt',
        userInstruction: expect.stringContaining('Return exactly one fenced JSON block'),
      },
      undefined,
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
        buildPhaseRunnerContext: vi.fn(),
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
      detectRuleIndex: vi.fn().mockReturnValue(-1),
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
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
        buildPhaseRunnerContext: vi.fn(),
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
      detectRuleIndex: vi.fn().mockReturnValue(-1),
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
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
        buildPhaseRunnerContext: vi.fn(),
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
      detectRuleIndex: vi.fn().mockReturnValue(-1),
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
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
        buildPhaseRunnerContext: vi.fn(),
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
      detectRuleIndex: vi.fn().mockReturnValue(-1),
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
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
        buildPhaseRunnerContext: vi.fn(),
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
      detectRuleIndex: vi.fn().mockReturnValue(-1),
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
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
        buildPhaseRunnerContext: vi.fn(),
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
      detectRuleIndex: vi.fn().mockReturnValue(-1),
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
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
        buildPhaseRunnerContext: vi.fn(),
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
      detectRuleIndex: vi.fn().mockReturnValue(-1),
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
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
