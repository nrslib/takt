import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { AgentResponse, WorkflowConfig, WorkflowState, WorkflowStep } from '../core/models/index.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { runSingleWorkflowIteration, runWorkflowToCompletion } from '../core/workflow/engine/WorkflowRunLoop.js';
import { runQualityGates as runRealQualityGates } from '../core/workflow/quality-gates/qualityGateRunner.js';
import type { QualityGateRunResult, RunQualityGatesOptions } from '../core/workflow/quality-gates/types.js';
import { makeResponse, makeRule, makeStep } from './engine-test-helpers.js';
import { collectMetricPoints, metricPoint } from './observability-metrics-test-helpers.js';

type CommandGateRunResult = QualityGateRunResult;
type RunQualityGatesFn = (options: RunQualityGatesOptions) => Promise<QualityGateRunResult>;

function makeConfig(step: WorkflowStep): WorkflowConfig {
  return {
    name: 'command-gate-workflow',
    description: 'Command gate workflow',
    maxSteps: 5,
    initialStep: step.name,
    steps: [step],
  };
}

function makeFailureResponse(content: string): AgentResponse {
  return makeResponse({
    persona: 'quality-gate',
    status: 'done',
    content,
  });
}

function makeDeps(
  state: WorkflowState,
  step: WorkflowStep,
  runStep: ReturnType<typeof vi.fn>,
  runQualityGates: RunQualityGatesFn,
) {
  return {
    state,
    options: {},
    getWorkflowName: () => 'command-gate-workflow',
    getCurrentWorkflowStack: () => undefined,
    getCwd: () => '/worktree',
    getMaxSteps: () => 5,
    getReportDir: () => '/worktree/.takt/runs/test/reports',
    abortRequested: () => false,
    getStep: () => step,
    applyRuntimeEnvironment: vi.fn(),
    loopDetectorCheck: () => ({ count: 1, isLoop: false }),
    cycleDetectorRecordAndCheck: () => ({ triggered: false, cycleCount: 0 }),
    resolveDoneTransition: vi.fn(() => ({ nextStep: 'COMPLETE' })),
    runLoopMonitorJudge: vi.fn(),
    runStep,
    runQualityGates,
    buildInstruction: vi.fn((_step: WorkflowStep, stepIteration: number) => {
      const previous = state.lastOutput?.content;
      return previous ? `instruction ${stepIteration}\n${previous}` : `instruction ${stepIteration}`;
    }),
    buildPhase1Instruction: vi.fn((_step: WorkflowStep, instruction: string) => instruction),
    resolveStepProviderModel: vi.fn(() => ({
      provider: undefined,
      model: undefined,
    })),
    resolveRuntimeForStep: vi.fn(),
    setActiveStep: vi.fn(),
    addUserInput: vi.fn(),
    emit: vi.fn(),
    updateMaxSteps: vi.fn(),
    persistPreviousResponseSnapshot: vi.fn((targetState: WorkflowState, stepName: string, stepIteration: number, content: string) => {
      targetState.previousResponseSourcePath = `.takt/runs/test/context/previous_responses/${stepName}.${stepIteration}.snapshot.md`;
      targetState.lastOutput = {
        persona: stepName,
        status: 'done',
        content,
        timestamp: new Date(),
      };
    }),
  };
}

describe('WorkflowRunLoop command quality gates', () => {
  it('should rerun the same step with command gate feedback before resolving the done transition', async () => {
    const step = makeStep('implement', {
      qualityGates: [
        'Review the implementation before finishing',
        {
          type: 'command',
          name: 'quality-check',
          command: './.takt/quality-gates/check.sh',
        },
      ],
      rules: [makeRule('Implementation complete', 'COMPLETE')],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const firstResponse = makeResponse({ persona: 'implement', content: 'first implementation' });
    const secondResponse = makeResponse({ persona: 'implement', content: 'fixed implementation' });
    const failureResponse = makeFailureResponse([
      'Quality gate failed: quality-check',
      'Type: command',
      'Command: ./.takt/quality-gates/check.sh',
      'Exit code: 1',
      'Output log: .takt/quality-gates/logs/quality-check.log',
      'Stdout:',
      'unit failed',
      '',
      'Stderr:',
      'lint failed',
    ].join('\n'));
    const instructions: string[] = [];
    const runStep = vi
      .fn()
      .mockImplementationOnce(async (_step: WorkflowStep, instruction: string) => {
        instructions.push(instruction);
        state.stepOutputs.set(step.name, firstResponse);
        state.lastOutput = firstResponse;
        return { response: firstResponse, instruction };
      })
      .mockImplementationOnce(async (_step: WorkflowStep, instruction: string) => {
        instructions.push(instruction);
        state.stepOutputs.set(step.name, secondResponse);
        state.lastOutput = secondResponse;
        return { response: secondResponse, instruction };
      });
    const runQualityGates = vi
      .fn<() => Promise<CommandGateRunResult>>()
      .mockResolvedValueOnce({ ok: false, response: failureResponse })
      .mockResolvedValueOnce({ ok: true });
    const deps = makeDeps(state, step, runStep, runQualityGates);

    const result = await runWorkflowToCompletion(deps);

    expect(result.state.status).toBe('completed');
    expect(runQualityGates).toHaveBeenCalledTimes(2);
    expect(runQualityGates).toHaveBeenNthCalledWith(1, {
      qualityGates: step.qualityGates,
      projectRoot: '/worktree',
      step,
      childProcessEnv: undefined,
      observabilityEnabled: false,
      runId: undefined,
      workflowName: 'command-gate-workflow',
    });
    expect(deps.resolveDoneTransition).toHaveBeenCalledTimes(1);
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(instructions[1]).toContain('Quality gate failed: quality-check');
    expect(instructions[1]).toContain('Output log: .takt/quality-gates/logs/quality-check.log');
    expect(instructions[1]).toContain('Stdout:\nunit failed');
    expect(instructions[1]).toContain('Stderr:\nlint failed');
    expect(deps.persistPreviousResponseSnapshot).toHaveBeenCalledWith(
      state,
      'implement',
      1,
      failureResponse.content,
    );
  });

  it('should run command gates before completing a rule return value', async () => {
    const step = makeStep('reviewers', {
      qualityGates: [
        {
          type: 'command',
          name: 'quality-check',
          command: './.takt/quality-gates/check.sh',
        },
      ],
      rules: [{ condition: 'need_replan', returnValue: 'need_replan' }],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const firstResponse = makeResponse({ persona: 'reviewers', content: 'invalid manager output' });
    const secondResponse = makeResponse({ persona: 'reviewers', content: 'invalid manager output after retry' });
    const failureResponse = makeFailureResponse('Quality gate failed: quality-check');
    const runStep = vi
      .fn()
      .mockImplementationOnce(async (_step: WorkflowStep, instruction: string) => {
        state.stepOutputs.set(step.name, firstResponse);
        state.lastOutput = firstResponse;
        return { response: firstResponse, instruction };
      })
      .mockImplementationOnce(async (_step: WorkflowStep, instruction: string) => {
        state.stepOutputs.set(step.name, secondResponse);
        state.lastOutput = secondResponse;
        return { response: secondResponse, instruction };
      });
    const runQualityGates = vi
      .fn<() => Promise<CommandGateRunResult>>()
      .mockResolvedValueOnce({ ok: false, response: failureResponse })
      .mockResolvedValueOnce({ ok: true });
    const deps = makeDeps(state, step, runStep, runQualityGates);
    deps.resolveDoneTransition.mockReturnValue({ returnValue: 'need_replan' });

    const result = await runWorkflowToCompletion(deps);

    expect(result.state.status).toBe('completed');
    expect(result.returnValue).toBe('need_replan');
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(runQualityGates).toHaveBeenCalledTimes(2);
    expect(deps.resolveDoneTransition).toHaveBeenCalledTimes(1);
  });

  it('should snapshot command gate metadata for the next prompt source path with sanitized output', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'takt-command-gate-snapshot-'));
    try {
      const step = makeStep('implement', {
        qualityGates: [
          {
            type: 'command',
            name: 'quality-check',
            command: './.takt/quality-gates/check.sh',
          },
        ],
        rules: [makeRule('Implementation complete', 'COMPLETE')],
      });
      const state = createInitialState(makeConfig(step), { projectCwd: tmpDir });
      const response = makeResponse({ persona: 'implement', content: 'implementation done' });
      const failureResponse = makeFailureResponse([
        'Quality gate failed: quality-check',
        'Type: command',
        'Command: ./.takt/quality-gates/check.sh',
        'Exit code: 1',
        'Output log: .takt/quality-gates/logs/quality-check.log',
        'Stdout:',
        'unit failed',
        '',
        'Stderr:',
        'lint failed',
      ].join('\n'));
      const runStep = vi.fn(async (_step: WorkflowStep, instruction: string) => {
        state.stepOutputs.set(step.name, response);
        state.lastOutput = response;
        return { response, instruction };
      });
      const runQualityGates = vi
        .fn<() => Promise<CommandGateRunResult>>()
        .mockResolvedValueOnce({ ok: false, response: failureResponse });
      const deps = makeDeps(state, step, runStep, runQualityGates);
      deps.persistPreviousResponseSnapshot = vi.fn((
        targetState: WorkflowState,
        stepName: string,
        stepIteration: number,
        content: string,
      ) => {
        const relPath = `.takt/runs/test/context/previous_responses/${stepName}.${stepIteration}.snapshot.md`;
        const absPath = join(tmpDir, relPath);
        mkdirSync(join(tmpDir, '.takt/runs/test/context/previous_responses'), { recursive: true });
        writeFileSync(absPath, content, 'utf-8');
        writeFileSync(join(tmpDir, '.takt/runs/test/context/previous_responses/latest.md'), content, 'utf-8');
        targetState.previousResponseSourcePath = relPath;
      });

      const result = await runSingleWorkflowIteration(deps);

      expect(result.nextStep).toBe('implement');
      expect(state.previousResponseSourcePath).toBe('.takt/runs/test/context/previous_responses/implement.1.snapshot.md');
      expect(existsSync(join(tmpDir, state.previousResponseSourcePath!))).toBe(true);
      const snapshot = readFileSync(join(tmpDir, state.previousResponseSourcePath!), 'utf-8');
      expect(snapshot).toContain('Output log: .takt/quality-gates/logs/quality-check.log');
      expect(snapshot).toContain('Stdout:\nunit failed');
      expect(readFileSync(join(tmpDir, '.takt/runs/test/context/previous_responses/latest.md'), 'utf-8')).toContain('Stderr:\nlint failed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not build the phase-1 instruction for the step span when observability is disabled', async () => {
    const step = makeStep('implement', {
      rules: [makeRule('Implementation complete', 'COMPLETE')],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const response = makeResponse({ persona: 'implement', content: 'implementation done' });
    const runStep = vi.fn(async (_step: WorkflowStep, instruction: string) => {
      state.stepOutputs.set(step.name, response);
      state.lastOutput = response;
      return { response, instruction };
    });
    const runQualityGates = vi
      .fn<() => Promise<CommandGateRunResult>>()
      .mockResolvedValue({ ok: true });
    const deps = makeDeps(state, step, runStep, runQualityGates);

    await runSingleWorkflowIteration(deps);

    // options.observability is undefined (disabled): the shadow-span instruction
    // must not be built — it is only consumed by the (disabled) span and would be
    // a redundant second buildPhase1Instruction call.
    expect(deps.buildPhase1Instruction).not.toHaveBeenCalled();
  });

  it('does not record loop metrics when observability is disabled', async () => {
    const step = makeStep('implement', {
      rules: [makeRule('Implementation complete', 'COMPLETE')],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const response = makeResponse({ persona: 'implement', content: 'implementation done' });
    const runStep = vi.fn(async (_step: WorkflowStep, instruction: string) => {
      state.stepOutputs.set(step.name, response);
      state.lastOutput = response;
      return { response, instruction };
    });
    const runQualityGates = vi
      .fn<() => Promise<CommandGateRunResult>>()
      .mockResolvedValue({ ok: true });
    const deps = makeDeps(state, step, runStep, runQualityGates);
    deps.options = {
      observability: { enabled: false },
      observabilityRunId: 'run-1',
      projectCwd: '/worktree',
    };
    deps.loopDetectorCheck = () => ({ shouldWarn: true, count: 2, isLoop: true });

    const points = await collectMetricPoints(async () => {
      await runSingleWorkflowIteration(deps);
    });

    expect(points.filter((point) => point.name === 'takt.workflow.loops_detected')).toEqual([]);
  });

  it('records loop metrics from a full workflow run when observability is enabled', async () => {
    const step = makeStep('implement', {
      rules: [makeRule('Implementation complete', 'COMPLETE')],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const response = makeResponse({ persona: 'implement', content: 'implementation done' });
    const runStep = vi.fn(async (_step: WorkflowStep, instruction: string) => {
      state.stepOutputs.set(step.name, response);
      state.lastOutput = response;
      return { response, instruction };
    });
    const runQualityGates = vi
      .fn<() => Promise<CommandGateRunResult>>()
      .mockResolvedValue({ ok: true });
    const deps = makeDeps(state, step, runStep, runQualityGates);
    deps.options = {
      observability: { enabled: true },
      observabilityRunId: 'run-1',
      projectCwd: '/worktree',
    };
    deps.loopDetectorCheck = () => ({ shouldWarn: true, count: 2, isLoop: true });

    const points = await collectMetricPoints(async () => {
      await runWorkflowToCompletion(deps);
    });

    expect(metricPoint(points, 'takt.workflow.loops_detected', {
      'takt.run.id': 'run-1',
      'takt.workflow.name': 'command-gate-workflow',
      'takt.step.name': 'implement',
    })?.value).toBe(1);
  });

  it('records loop metrics from a single workflow iteration when observability is enabled', async () => {
    const step = makeStep('implement', {
      rules: [makeRule('Implementation complete', 'COMPLETE')],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const response = makeResponse({ persona: 'implement', content: 'implementation done' });
    const runStep = vi.fn(async (_step: WorkflowStep, instruction: string) => {
      state.stepOutputs.set(step.name, response);
      state.lastOutput = response;
      return { response, instruction };
    });
    const runQualityGates = vi
      .fn<() => Promise<CommandGateRunResult>>()
      .mockResolvedValue({ ok: true });
    const deps = makeDeps(state, step, runStep, runQualityGates);
    deps.options = {
      observability: { enabled: true },
      observabilityRunId: 'run-1',
      projectCwd: '/worktree',
    };
    deps.loopDetectorCheck = () => ({ shouldWarn: true, count: 2, isLoop: true });

    const points = await collectMetricPoints(async () => {
      await runSingleWorkflowIteration(deps);
    });

    expect(metricPoint(points, 'takt.workflow.loops_detected', {
      'takt.run.id': 'run-1',
      'takt.workflow.name': 'command-gate-workflow',
      'takt.step.name': 'implement',
    })?.value).toBe(1);
  });

  it('records command quality gate metrics from a full workflow run when observability is enabled', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'takt-workflow-quality-gate-metrics-'));
    try {
      const step = makeStep('implement', {
        qualityGates: [
          {
            type: 'command',
            name: 'workflow-gate',
            command: 'node -e "process.exit(0)"',
          },
        ],
        rules: [makeRule('Implementation complete', 'COMPLETE')],
      });
      const state = createInitialState(makeConfig(step), { projectCwd: tmpDir });
      const response = makeResponse({ persona: 'implement', content: 'implementation done' });
      const runStep = vi.fn(async (_step: WorkflowStep, instruction: string) => {
        state.stepOutputs.set(step.name, response);
        state.lastOutput = response;
        return { response, instruction };
      });
      const deps = makeDeps(state, step, runStep, runRealQualityGates);
      deps.getCwd = () => tmpDir;
      deps.options = {
        observability: { enabled: true },
        observabilityRunId: 'run-1',
        projectCwd: tmpDir,
      };

      const points = await collectMetricPoints(async () => {
        await runWorkflowToCompletion(deps);
      });

      expect(metricPoint(points, 'takt.quality_gate.results', {
        'takt.run.id': 'run-1',
        'takt.workflow.name': 'command-gate-workflow',
        'takt.step.name': 'implement',
        'takt.quality_gate.name': 'workflow-gate',
        'takt.quality_gate.result': 'pass',
      })?.value).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('records command quality gate metrics from a single workflow iteration when observability is enabled', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'takt-single-quality-gate-metrics-'));
    try {
      const step = makeStep('implement', {
        qualityGates: [
          {
            type: 'command',
            name: 'single-iteration-gate',
            command: 'node -e "process.exit(0)"',
          },
        ],
        rules: [makeRule('Implementation complete', 'COMPLETE')],
      });
      const state = createInitialState(makeConfig(step), { projectCwd: tmpDir });
      const response = makeResponse({ persona: 'implement', content: 'implementation done' });
      const runStep = vi.fn(async (_step: WorkflowStep, instruction: string) => {
        state.stepOutputs.set(step.name, response);
        state.lastOutput = response;
        return { response, instruction };
      });
      const deps = makeDeps(state, step, runStep, runRealQualityGates);
      deps.getCwd = () => tmpDir;
      deps.options = {
        observability: { enabled: true },
        observabilityRunId: 'run-1',
        projectCwd: tmpDir,
      };

      const points = await collectMetricPoints(async () => {
        await runSingleWorkflowIteration(deps);
      });

      expect(metricPoint(points, 'takt.quality_gate.results', {
        'takt.run.id': 'run-1',
        'takt.workflow.name': 'command-gate-workflow',
        'takt.step.name': 'implement',
        'takt.quality_gate.name': 'single-iteration-gate',
        'takt.quality_gate.result': 'pass',
      })?.value).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not record cycle metrics when observability is disabled', async () => {
    const step = makeStep('implement', {
      rules: [makeRule('Implementation complete', 'implement')],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const response = makeResponse({ persona: 'implement', content: 'implementation done' });
    const runStep = vi.fn(async (_step: WorkflowStep, instruction: string) => {
      state.stepOutputs.set(step.name, response);
      state.lastOutput = response;
      return { response, instruction };
    });
    const runQualityGates = vi
      .fn<() => Promise<CommandGateRunResult>>()
      .mockResolvedValue({ ok: true });
    const deps = makeDeps(state, step, runStep, runQualityGates);
    deps.options = {
      observability: { enabled: false },
      observabilityRunId: 'run-1',
      projectCwd: '/worktree',
    };
    deps.resolveDoneTransition.mockReturnValue({ nextStep: 'implement' });
    deps.cycleDetectorRecordAndCheck = () => ({
      triggered: true,
      monitor: {
        cycle: ['implement', 'implement'],
        threshold: 2,
        judge: {
          rules: [{ condition: 'continue', next: 'COMPLETE' }],
        },
      },
      cycleCount: 2,
    });
    deps.runLoopMonitorJudge.mockResolvedValue('COMPLETE');

    const points = await collectMetricPoints(async () => {
      await runWorkflowToCompletion(deps);
    });

    expect(points.filter((point) => point.name === 'takt.workflow.cycles_detected')).toEqual([]);
  });

  it('records cycle metrics when a loop monitor cycle triggers and observability is enabled', async () => {
    const step = makeStep('implement', {
      rules: [makeRule('Implementation complete', 'implement')],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const response = makeResponse({ persona: 'implement', content: 'implementation done' });
    const runStep = vi.fn(async (_step: WorkflowStep, instruction: string) => {
      state.stepOutputs.set(step.name, response);
      state.lastOutput = response;
      return { response, instruction };
    });
    const runQualityGates = vi
      .fn<() => Promise<CommandGateRunResult>>()
      .mockResolvedValue({ ok: true });
    const deps = makeDeps(state, step, runStep, runQualityGates);
    deps.options = {
      observability: { enabled: true },
      observabilityRunId: 'run-1',
      projectCwd: '/worktree',
    };
    deps.resolveDoneTransition.mockReturnValue({ nextStep: 'implement' });
    deps.cycleDetectorRecordAndCheck = () => ({
      triggered: true,
      monitor: {
        cycle: ['implement', 'implement'],
        threshold: 2,
        judge: {
          rules: [{ condition: 'continue', next: 'COMPLETE' }],
        },
      },
      cycleCount: 2,
    });
    deps.runLoopMonitorJudge.mockResolvedValue('COMPLETE');

    const points = await collectMetricPoints(async () => {
      await runWorkflowToCompletion(deps);
    });

    expect(metricPoint(points, 'takt.workflow.cycles_detected', {
      'takt.run.id': 'run-1',
      'takt.workflow.name': 'command-gate-workflow',
      'takt.step.name': 'implement',
    })?.value).toBe(1);
  });

  it('should return the current step from runSingleIteration when a command gate fails', async () => {
    const step = makeStep('implement', {
      qualityGates: [
        {
          type: 'command',
          name: 'quality-check',
          command: './.takt/quality-gates/check.sh',
        },
      ],
      rules: [makeRule('Implementation complete', 'COMPLETE')],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const response = makeResponse({ persona: 'implement', content: 'implementation done' });
    const failureResponse = makeFailureResponse('Quality gate failed: quality-check');
    const runStep = vi.fn(async (_step: WorkflowStep, instruction: string) => {
      state.stepOutputs.set(step.name, response);
      state.lastOutput = response;
      return { response, instruction };
    });
    const runQualityGates = vi
      .fn<() => Promise<CommandGateRunResult>>()
      .mockResolvedValueOnce({ ok: false, response: failureResponse });
    const deps = makeDeps(state, step, runStep, runQualityGates);

    const result = await runSingleWorkflowIteration(deps);

    expect(result.nextStep).toBe('implement');
    expect(result.isComplete).toBe(false);
    expect(state.status).toBe('running');
    expect(state.currentStep).toBe('implement');
    expect(state.lastOutput?.content).toBe('Quality gate failed: quality-check');
    expect(deps.resolveDoneTransition).not.toHaveBeenCalled();
  });

  it('should run command gates before completing a rule return value in runSingleIteration', async () => {
    const step = makeStep('reviewers', {
      qualityGates: [
        {
          type: 'command',
          name: 'quality-check',
          command: './.takt/quality-gates/check.sh',
        },
      ],
      rules: [{ condition: 'need_replan', returnValue: 'need_replan' }],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const response = makeResponse({ persona: 'reviewers', content: 'invalid manager output' });
    const runStep = vi.fn(async (_step: WorkflowStep, instruction: string) => {
      state.stepOutputs.set(step.name, response);
      state.lastOutput = response;
      return { response, instruction };
    });
    const runQualityGates = vi
      .fn<() => Promise<CommandGateRunResult>>()
      .mockResolvedValueOnce({ ok: true });
    const deps = makeDeps(state, step, runStep, runQualityGates);
    deps.resolveDoneTransition.mockReturnValue({ returnValue: 'need_replan' });

    const result = await runSingleWorkflowIteration(deps);

    expect(result.nextStep).toBe('COMPLETE');
    expect(result.isComplete).toBe(true);
    expect(result.returnValue).toBe('need_replan');
    expect(state.status).toBe('completed');
    expect(runQualityGates).toHaveBeenCalledTimes(1);
    expect(deps.resolveDoneTransition).toHaveBeenCalledTimes(1);
  });

  it('should keep runSingleIteration on the current step when command gates fail before a rule return value', async () => {
    const step = makeStep('reviewers', {
      qualityGates: [
        {
          type: 'command',
          name: 'quality-check',
          command: './.takt/quality-gates/check.sh',
        },
      ],
      rules: [{ condition: 'need_replan', returnValue: 'need_replan' }],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const response = makeResponse({ persona: 'reviewers', content: 'invalid manager output' });
    const failureResponse = makeFailureResponse('Quality gate failed: quality-check');
    const runStep = vi.fn(async (_step: WorkflowStep, instruction: string) => {
      state.stepOutputs.set(step.name, response);
      state.lastOutput = response;
      return { response, instruction };
    });
    const runQualityGates = vi
      .fn<() => Promise<CommandGateRunResult>>()
      .mockResolvedValueOnce({ ok: false, response: failureResponse });
    const deps = makeDeps(state, step, runStep, runQualityGates);

    const result = await runSingleWorkflowIteration(deps);

    expect(result.nextStep).toBe('reviewers');
    expect(result.isComplete).toBe(false);
    expect(result.returnValue).toBeUndefined();
    expect(state.status).toBe('running');
    expect(state.lastOutput?.content).toBe('Quality gate failed: quality-check');
    expect(deps.resolveDoneTransition).not.toHaveBeenCalled();
  });
});
