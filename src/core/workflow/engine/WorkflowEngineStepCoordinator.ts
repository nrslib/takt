import type { AgentResponse, LoopMonitorConfig, WorkflowMaxSteps, WorkflowState, WorkflowStep } from '../../models/types.js';
import { getWorkflowStepKind, isSystemWorkflowStep, isWorkflowCallStep } from '../step-kind.js';
import type { RuntimeStepResolution, WorkflowEngineOptions } from '../types.js';
import { determineRuleTransition, type WorkflowRuleTransition } from './transitions.js';

interface WorkflowEngineStepCoordinatorDeps {
  config: {
    steps: WorkflowStep[];
  };
  state: WorkflowState;
  task: string;
  getMaxSteps: () => WorkflowMaxSteps;
  getOptions: () => WorkflowEngineOptions;
  stepExecutor: {
    runNormalStep: (
      step: WorkflowStep,
      state: WorkflowState,
      task: string,
      maxSteps: WorkflowMaxSteps,
      updateSession: (persona: string, sessionId: string | undefined) => void,
      prebuiltInstruction?: string,
    ) => Promise<{ response: AgentResponse; instruction: string }>;
    buildInstruction: (
      step: WorkflowStep,
      stepIteration: number,
      state: WorkflowState,
      task: string,
      maxSteps: WorkflowMaxSteps,
    ) => string;
    buildPhase1Instruction: (instruction: string, step: WorkflowStep) => string;
    drainReportFiles: () => Array<{ step: WorkflowStep; filePath: string; fileName: string }>;
  };
  parallelRunner: {
    runParallelStep: (
      step: WorkflowStep,
      state: WorkflowState,
      task: string,
      maxSteps: WorkflowMaxSteps,
      updateSession: (persona: string, sessionId: string | undefined) => void,
    ) => Promise<{ response: AgentResponse; instruction: string }>;
  };
  arpeggioRunner: {
    runArpeggioStep: (
      step: WorkflowStep,
      state: WorkflowState,
    ) => Promise<{ response: AgentResponse; instruction: string }>;
  };
  teamLeaderRunner: {
    runTeamLeaderStep: (
      step: WorkflowStep,
      state: WorkflowState,
      task: string,
      maxSteps: WorkflowMaxSteps,
      updateSession: (persona: string, sessionId: string | undefined) => void,
    ) => Promise<{ response: AgentResponse; instruction: string }>;
  };
  systemStepExecutor: {
    run: (step: WorkflowStep, state: WorkflowState) => Promise<AgentResponse>;
  };
  loopMonitorJudgeRunner: {
    run: (
      monitor: LoopMonitorConfig,
      cycleCount: number,
      triggeringStep: WorkflowStep,
      triggeringRuntime?: RuntimeStepResolution,
    ) => Promise<string>;
  };
  workflowCallRunner: {
    run: (
      step: WorkflowStep & { call: string },
      runtime?: RuntimeStepResolution,
    ) => Promise<{ response: AgentResponse; instruction: string }>;
    resolveRuntime: (step: WorkflowStep & { call: string }) => RuntimeStepResolution;
  };
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
  emitReport: (step: WorkflowStep, filePath: string, fileName: string) => void;
}

export class WorkflowEngineStepCoordinator {
  constructor(private readonly deps: WorkflowEngineStepCoordinatorDeps) {}

  getStep(name: string): WorkflowStep {
    const step = this.deps.config.steps.find((candidate) => candidate.name === name);
    if (!step) {
      throw new Error(`Unknown step: ${name}`);
    }
    return step;
  }

  resolveRuntimeForStep(step: WorkflowStep): RuntimeStepResolution | undefined {
    if (isWorkflowCallStep(step)) {
      return this.deps.workflowCallRunner.resolveRuntime(step);
    }
    return undefined;
  }

  async runStep(
    step: WorkflowStep,
    prebuiltInstruction?: string,
    runtime?: RuntimeStepResolution,
  ): Promise<{ response: AgentResponse; instruction: string }> {
    const updateSession = this.deps.updatePersonaSession;
    let result: { response: AgentResponse; instruction: string };

    if (step.parallel && step.parallel.length > 0) {
      result = await this.deps.parallelRunner.runParallelStep(
        step,
        this.deps.state,
        this.deps.task,
        this.deps.getMaxSteps(),
        updateSession,
      );
    } else if (step.arpeggio) {
      result = await this.deps.arpeggioRunner.runArpeggioStep(step, this.deps.state);
    } else if (step.teamLeader) {
      result = await this.deps.teamLeaderRunner.runTeamLeaderStep(
        step,
        this.deps.state,
        this.deps.task,
        this.deps.getMaxSteps(),
        updateSession,
      );
    } else if (isSystemWorkflowStep(step)) {
      result = {
        response: await this.deps.systemStepExecutor.run(step, this.deps.state),
        instruction: '',
      };
    } else if (isWorkflowCallStep(step)) {
      result = await this.deps.workflowCallRunner.run(step, runtime);
    } else {
      result = await this.deps.stepExecutor.runNormalStep(
        step,
        this.deps.state,
        this.deps.task,
        this.deps.getMaxSteps(),
        updateSession,
        prebuiltInstruction,
      );
    }

    for (const { step: reportedStep, filePath, fileName } of this.deps.stepExecutor.drainReportFiles()) {
      this.deps.emitReport(reportedStep, filePath, fileName);
    }
    return result;
  }

  resolveNextStepFromDone(step: WorkflowStep, response: AgentResponse): string {
    const transition = this.resolveTransitionFromDone(step, response);
    if (transition.nextStep) {
      return transition.nextStep;
    }
    throw new Error(`Step "${step.name}" resolved to a return transition where a next step is required`);
  }

  resolveTransitionFromDone(step: WorkflowStep, response: AgentResponse): WorkflowRuleTransition {
    if (response.status !== 'done') {
      throw new Error(`Unhandled response status: ${response.status}`);
    }
    if (response.matchedRuleIndex != null && step.rules) {
      const transition = determineRuleTransition(step, response.matchedRuleIndex);
      if (transition && (transition.nextStep || transition.returnValue || transition.requiresUserInput)) {
        return transition;
      }
    }
    throw new Error(`No matching rule found for step "${step.name}" (status: ${response.status}, kind: ${getWorkflowStepKind(step)})`);
  }

  buildInstruction(step: WorkflowStep, stepIteration: number): string {
    return this.deps.stepExecutor.buildInstruction(
      step,
      stepIteration,
      this.deps.state,
      this.deps.task,
      this.deps.getMaxSteps(),
    );
  }

  buildPhase1Instruction(step: WorkflowStep, instruction: string): string {
    return this.deps.stepExecutor.buildPhase1Instruction(instruction, step);
  }

  runLoopMonitorJudge(
    monitor: LoopMonitorConfig,
    cycleCount: number,
    triggeringStep: WorkflowStep,
    triggeringRuntime?: RuntimeStepResolution,
  ): Promise<string> {
    return this.deps.loopMonitorJudgeRunner.run(monitor, cycleCount, triggeringStep, triggeringRuntime);
  }
}
