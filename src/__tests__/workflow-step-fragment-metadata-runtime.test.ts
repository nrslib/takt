import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/evaluation/index.js')>();
  return {
    ...actual,
    RuleEvaluator: class {
      evaluate() {
        return { index: 0, method: 'auto_select' as const };
      }
    },
  };
});

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: 'done', method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import type { WorkflowConfig, WorkflowResumePoint } from '../core/models/types.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { getWorkflowReference } from '../core/workflow/workflow-reference.js';
import { runAgent } from '../agents/runner.js';
import { resolveWorkflowCallTarget } from '../infra/config/loaders/workflowCallResolver.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import {
  getAttachedWorkflowTrustInfo,
  getWorkflowSourcePath,
} from '../shared/workflowConfigMetadata.js';
import {
  applyDefaultMocks,
  makeResponse,
} from './engine-test-helpers.js';
import { writeStepFragmentTestFile as write } from './helpers/step-fragment-test-helpers.js';

function engineConfig(engine: WorkflowEngine): WorkflowConfig {
  return (engine as unknown as { config: WorkflowConfig }).config;
}

describe('workflow step fragment metadata runtime contract', () => {
  let projectDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    projectDir = mkdtempSync(join(tmpdir(), 'takt-step-fragment-metadata-runtime-'));
  });

  afterEach(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  it('preserves source, trust, opaque resume identity, and relative workflow calls across resume', async () => {
    write(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: ./children/child.yaml',
      '',
    ].join('\n'));
    const childPath = write(projectDir, '.takt/workflows/children/child.yaml', [
      'name: child',
      'subworkflow:',
      '  callable: true',
      '  returns: [success]',
      'initial_step: done',
      'max_steps: 10',
      'steps:',
      '  - name: done',
      '    instruction: done',
      '    rules:',
      '      - condition: when(true)',
      '        return: success',
      '',
    ].join('\n'));
    const parentPath = write(projectDir, '.takt/workflows/parent.yaml', [
      'name: parent',
      'initial_step: delegate',
      'max_steps: 10',
      'steps:',
      '  - name: delegate',
      '    uses: delegate',
      '    rules:',
      '      - condition: success',
      '        next: COMPLETE',
      '      - condition: ABORT',
      '        next: ABORT',
      '',
    ].join('\n'));
    const loaded = loadWorkflowFromFile(parentPath, projectDir);
    const createEngine = (resumePoint?: WorkflowResumePoint) => new WorkflowEngine(loaded, projectDir, 'test task', {
      projectCwd: projectDir,
      provider: 'mock',
      model: 'mock-model',
      workflowCallResolver: ({ parentWorkflow, step, projectCwd, lookupCwd }) =>
        resolveWorkflowCallTarget(parentWorkflow, step, projectCwd, lookupCwd),
      ...(resumePoint === undefined ? {} : {
        startStep: resumePoint.stack[0]?.step,
        initialIteration: resumePoint.iteration,
        resumePoint,
      }),
    });
    const engine = createEngine();
    const config = engineConfig(engine);
    const delegate = config.steps.find((step) => step.name === 'delegate');

    if (!delegate || delegate.kind !== 'workflow_call') {
      throw new Error('Expected the fragment to resolve to a workflow_call step');
    }

    const child = resolveWorkflowCallTarget(config, delegate, projectDir);
    let savedResumePoint: WorkflowResumePoint | undefined;
    const abortReasons: string[] = [];
    const completedSteps: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));
    engine.on('step:complete', (step) => completedSteps.push(step.name));
    engine.on('step:start', (step) => {
      if (step.name === 'done') {
        savedResumePoint = engine.getResumePoint();
      }
    });
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      return makeResponse({
        persona: 'done',
        content: 'done',
        structuredOutput: { rawFindings: [] },
      });
    });
    const firstState = await engine.run();
    if (savedResumePoint === undefined) {
      throw new Error(`Expected a resume point while the child workflow is running (step: ${firstState.currentStep}, status: ${firstState.status}, calls: ${vi.mocked(runAgent).mock.calls.length}, abort: ${abortReasons.join(' ')})`);
    }

    const resumedEngine = createEngine(savedResumePoint);
    const resumedChildStepIterations: number[] = [];
    resumedEngine.on('step:start', (step, _iteration, _instruction, _providerInfo, _workflowName, _resumeStepName, stepIteration) => {
      if (step.name === 'done' && stepIteration !== undefined) {
        resumedChildStepIterations.push(stepIteration);
      }
    });
    const resumedState = await resumedEngine.run();

    expect(getWorkflowSourcePath(config)).toBe(parentPath);
    expect(getAttachedWorkflowTrustInfo(config)).toMatchObject({
      source: 'project',
      isProjectTrustRoot: true,
      isProjectWorkflowRoot: true,
    });
    expect(child).not.toBeNull();
    expect(getWorkflowSourcePath(child!)).toBe(childPath);
    expect(getAttachedWorkflowTrustInfo(child!)).toMatchObject({
      source: 'project',
      isProjectTrustRoot: true,
      isProjectWorkflowRoot: true,
    });
    expect(firstState.status, `${abortReasons.join(' ')}; completed: ${completedSteps.join(', ')}`).toBe('completed');
    expect(savedResumePoint.stack).toHaveLength(2);
    expect(savedResumePoint.stack[0]?.workflow_ref).toBe(getWorkflowReference(config));
    expect(savedResumePoint.stack[0]?.workflow_ref).not.toContain(parentPath);
    expect(savedResumePoint.stack[1]?.workflow_ref).toBe(getWorkflowReference(child!));
    expect(savedResumePoint.stack[1]?.step).toBe('done');
    expect(savedResumePoint.stack[1]?.step_iterations).toMatchObject({ done: 1 });
    expect(resumedState.status).toBe('completed');
    expect(resumedChildStepIterations).toEqual([1]);
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
  });

});
