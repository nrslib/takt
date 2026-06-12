import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeAgent } from '../agents/agent-usecases.js';
import type { StructuredCaller } from '../agents/structured-caller.js';
import { ArpeggioRunner, type ArpeggioRunnerDeps } from '../core/workflow/engine/ArpeggioRunner.js';
import { ParallelRunner, type ParallelRunnerDeps } from '../core/workflow/engine/ParallelRunner.js';
import type { AgentResponse, WorkflowState, WorkflowStep } from '../core/models/index.js';
import { makeRule, makeStep } from './test-helpers.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

const tmpDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-runner-rule-env-'));
  tmpDirs.push(dir);
  return dir;
}

function makeState(): WorkflowState {
  return {
    workflowName: 'test-workflow',
    currentStep: 'reviewers',
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

function makeAgentResponse(content: string): AgentResponse {
  return {
    persona: 'test-agent',
    status: 'done',
    content,
    timestamp: new Date('2026-06-12T00:00:00.000Z'),
  };
}

function makeStructuredCaller(evaluateCondition: ReturnType<typeof vi.fn>): StructuredCaller {
  return {
    evaluateCondition,
    judgeStatus: vi.fn(),
    decomposeTask: vi.fn(),
    requestMoreParts: vi.fn(),
  };
}

function queueAgentResponse(content: string): void {
  vi.mocked(executeAgent).mockImplementationOnce(async (_persona, instruction, options) => {
    options.onPromptResolved?.({
      systemPrompt: 'system prompt',
      userInstruction: instruction,
    });
    return makeAgentResponse(content);
  });
}

afterEach(() => {
  vi.resetAllMocks();
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('runner rule evaluation childProcessEnv propagation', () => {
  it('passes childProcessEnv to parallel parent ai() rule evaluation', async () => {
    const childProcessEnv = { TAKT_OBSERVABILITY: '{"enabled":true}' };
    const evaluateCondition = vi.fn().mockResolvedValue(0);
    const structuredCaller = makeStructuredCaller(evaluateCondition);
    const deps: ParallelRunnerDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({ cwd: '/tmp/project' }),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({}),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'claude', model: 'claude-sonnet' }),
      } as unknown as ParallelRunnerDeps['optionsBuilder'],
      stepExecutor: {
        buildInstruction: vi.fn((step: WorkflowStep) => `instruction:${step.name}`),
        emitStepReports: vi.fn(),
        persistPreviousResponseSnapshot: vi.fn(),
      } as unknown as ParallelRunnerDeps['stepExecutor'],
      engineOptions: {
        projectCwd: '/tmp/project',
        childProcessEnv,
      },
      getCwd: () => '/tmp/project',
      getReportDir: () => '.takt/runs/test/reports',
      getWorkflowName: () => 'test-workflow',
      getInteractive: () => false,
      observabilityEnabled: false,
      detectRuleIndex: () => -1,
      structuredCaller,
      runQualityGates: vi.fn().mockResolvedValue({ ok: true }),
    };
    const step = makeStep({
      name: 'reviewers',
      instruction: 'Run parallel reviewers',
      parallel: [
        makeStep({ name: 'review-a', persona: 'review-a', instruction: 'Run review-a' }),
        makeStep({ name: 'review-b', persona: 'review-b', instruction: 'Run review-b' }),
      ],
      rules: [
        makeRule('ai("all reviewers passed")', 'COMPLETE', {
          isAiCondition: true,
          aiConditionText: 'all reviewers passed',
        }),
      ],
    });
    queueAgentResponse('review-a approved');
    queueAgentResponse('review-b approved');

    await new ParallelRunner(deps).runParallelStep(step, makeState(), 'test task', 5, vi.fn());

    expect(evaluateCondition).toHaveBeenCalledWith(
      expect.stringContaining('review-a approved'),
      [{ index: 0, text: 'all reviewers passed' }],
      expect.objectContaining({ childProcessEnv }),
    );
  });

  it('passes childProcessEnv to arpeggio ai() rule evaluation', async () => {
    const tmpDir = createTempDir();
    const csvPath = join(tmpDir, 'data.csv');
    const templatePath = join(tmpDir, 'template.md');
    writeFileSync(csvPath, 'name\nAlice', 'utf-8');
    writeFileSync(templatePath, 'Process {line:1}', 'utf-8');
    const childProcessEnv = { TAKT_OBSERVABILITY: '{"enabled":true}' };
    const evaluateCondition = vi.fn().mockResolvedValue(0);
    const deps: ArpeggioRunnerDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({ cwd: tmpDir }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'claude', model: 'claude-sonnet' }),
      } as unknown as ArpeggioRunnerDeps['optionsBuilder'],
      stepExecutor: {
        persistPreviousResponseSnapshot: vi.fn(),
      } as unknown as ArpeggioRunnerDeps['stepExecutor'],
      getCwd: () => tmpDir,
      getWorkflowName: () => 'test-workflow',
      getInteractive: () => false,
      childProcessEnv,
      observabilityEnabled: false,
      detectRuleIndex: () => -1,
      structuredCaller: makeStructuredCaller(evaluateCondition),
    };
    const step = makeStep({
      name: 'process',
      persona: 'processor',
      instruction: 'Run arpeggio',
      arpeggio: {
        source: 'csv',
        sourcePath: csvPath,
        batchSize: 1,
        concurrency: 1,
        templatePath,
        merge: { strategy: 'concat' },
        maxRetries: 0,
        retryDelayMs: 0,
      },
      rules: [
        makeRule('ai("processing completed")', 'COMPLETE', {
          isAiCondition: true,
          aiConditionText: 'processing completed',
        }),
      ],
    });
    queueAgentResponse('Processed Alice');

    await new ArpeggioRunner(deps).runArpeggioStep(step, makeState());

    expect(evaluateCondition).toHaveBeenCalledWith(
      'Processed Alice',
      [{ index: 0, text: 'processing completed' }],
      expect.objectContaining({ childProcessEnv }),
    );
  });
});
