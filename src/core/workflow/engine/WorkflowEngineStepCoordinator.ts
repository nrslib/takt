import type {
  AgentResponse,
  FallbackContext,
  LoopMonitorConfig,
  WorkflowMaxSteps,
  WorkflowState,
  WorkflowStep,
} from '../../models/types.js';
import { getAllParallelSubSteps } from '../../models/types.js';
import { isDelegatedWorkflowStep, isSystemWorkflowStep, isWorkflowCallStep } from '../step-kind.js';
import type {
  RuntimeStepResolution,
  StepRunResult,
  WorkflowEngineOptions,
  WorkflowStepExecutionEventContext,
} from '../types.js';
import type { PreparedNormalStepExecution } from './StepExecutor.js';
import type { WorkflowCallExecutionToken } from './WorkflowCallRunner.js';
import { determineRuleTransition, type WorkflowRuleTransition } from './transitions.js';
import { RuleDetectionExhaustedError } from '../evaluation/RuleDetectionExhaustedError.js';

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
      runtime?: RuntimeStepResolution,
      preparedExecution?: PreparedNormalStepExecution,
    ) => Promise<StepRunResult>;
    prepareNormalStepExecution: (
      step: WorkflowStep,
      state: WorkflowState,
      task: string,
      maxSteps: WorkflowMaxSteps,
      stepIteration: number,
      runtime?: RuntimeStepResolution,
    ) => Promise<PreparedNormalStepExecution>;
    buildInstruction: (
      step: WorkflowStep,
      stepIteration: number,
      state: WorkflowState,
      task: string,
      maxSteps: WorkflowMaxSteps,
      fallbackContext?: FallbackContext,
    ) => string;
    buildPhase1Instruction: (instruction: string, step: WorkflowStep, runtime?: RuntimeStepResolution) => string;
    drainReportFiles: () => Array<{
      step: WorkflowStep;
      filePath: string;
      fileName: string;
      context: WorkflowStepExecutionEventContext;
    }>;
  };
  parallelRunner: {
    runParallelStep: (
      step: WorkflowStep,
      state: WorkflowState,
      task: string,
      maxSteps: WorkflowMaxSteps,
      updateSession: (persona: string, sessionId: string | undefined) => void,
      runtime?: RuntimeStepResolution,
      activeStepIteration?: number,
    ) => Promise<StepRunResult>;
  };
  arpeggioRunner: {
    runArpeggioStep: (
      step: WorkflowStep,
      state: WorkflowState,
      runtime?: RuntimeStepResolution,
      activeStepIteration?: number,
    ) => Promise<StepRunResult>;
  };
  teamLeaderRunner: {
    runTeamLeaderStep: (
      step: WorkflowStep,
      state: WorkflowState,
      task: string,
      maxSteps: WorkflowMaxSteps,
      updateSession: (persona: string, sessionId: string | undefined) => void,
      runtime?: RuntimeStepResolution,
      activeStepIteration?: number,
    ) => Promise<StepRunResult>;
  };
  systemStepExecutor: {
    run: (
      step: WorkflowStep,
      state: WorkflowState,
      runtime?: RuntimeStepResolution,
    ) => Promise<AgentResponse>;
  };
  loopMonitorJudgeRunner: {
    run: (
      monitor: LoopMonitorConfig,
      cycleCount: number,
      triggeringStep: WorkflowStep,
      triggeringRuntime: RuntimeStepResolution | undefined,
      fallbackNextStep: string,
    ) => Promise<string>;
  };
  workflowCallRunner: {
    run: (
      step: WorkflowStep & { call: string },
      execution: WorkflowCallExecutionToken,
      runtime?: RuntimeStepResolution,
    ) => Promise<StepRunResult>;
    resolveRuntime: (step: WorkflowStep & { call: string }) => RuntimeStepResolution;
  };
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
  emitReport: (
    step: WorkflowStep,
    filePath: string,
    fileName: string,
    context: WorkflowStepExecutionEventContext,
  ) => void;
  recordParticipation: (
    step: WorkflowStep,
    reportNames: readonly string[],
    parallelParentStepName?: string,
  ) => void;
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
    stepIteration?: number,
    preparedExecution?: PreparedNormalStepExecution,
    workflowCallExecution?: WorkflowCallExecutionToken,
  ): Promise<StepRunResult> {
    const updateSession = this.deps.updatePersonaSession;
    let result: StepRunResult;

    if (step.parallel && getAllParallelSubSteps(step.parallel).length > 0) {
      result = await this.deps.parallelRunner.runParallelStep(
        step,
        this.deps.state,
        this.deps.task,
        this.deps.getMaxSteps(),
        updateSession,
        runtime,
        stepIteration,
      );
    } else if (step.arpeggio) {
      result = await this.deps.arpeggioRunner.runArpeggioStep(
        step,
        this.deps.state,
        runtime,
        stepIteration,
      );
    } else if (step.teamLeader) {
      result = await this.deps.teamLeaderRunner.runTeamLeaderStep(
        step,
        this.deps.state,
        this.deps.task,
        this.deps.getMaxSteps(),
        updateSession,
        runtime,
        stepIteration,
      );
    } else if (isSystemWorkflowStep(step)) {
      result = {
        response: await this.deps.systemStepExecutor.run(step, this.deps.state, runtime),
        instruction: '',
      };
    } else if (isWorkflowCallStep(step)) {
      if (workflowCallExecution === undefined) {
        throw new Error(`workflow_call step "${step.name}" execution was not activated`);
      }
      result = await this.deps.workflowCallRunner.run(step, workflowCallExecution, runtime);
    } else {
      result = await this.deps.stepExecutor.runNormalStep(
        step,
        this.deps.state,
        this.deps.task,
        this.deps.getMaxSteps(),
        updateSession,
        prebuiltInstruction,
        runtime,
        preparedExecution,
      );
    }

    const reports = this.deps.stepExecutor.drainReportFiles();
    for (const { step: reportedStep, filePath, fileName, context } of reports) {
      this.deps.emitReport(reportedStep, filePath, fileName, context);
    }
    const reportedSteps = new Set<WorkflowStep>([
      step,
      ...reports.map(({ step: reportedStep }) => reportedStep),
    ]);
    for (const participatedStep of reportedSteps) {
      const parallelParentStepName = step.parallel !== undefined
        && getAllParallelSubSteps(step.parallel).some((subStep) => subStep === participatedStep)
        ? step.name
        : undefined;
      this.deps.recordParticipation(
        participatedStep,
        reports
          .filter((report) => report.step === participatedStep)
          .map((report) => report.fileName),
        parallelParentStepName,
      );
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
    throw new RuleDetectionExhaustedError(step.name);
  }

  buildInstruction(
    step: WorkflowStep,
    stepIteration: number,
    fallbackContext?: FallbackContext,
  ): string {
    return this.deps.stepExecutor.buildInstruction(
      step,
      stepIteration,
      this.deps.state,
      this.deps.task,
      this.deps.getMaxSteps(),
      fallbackContext,
    );
  }

  async prepareNormalStepExecution(
    step: WorkflowStep,
    stepIteration: number,
    runtime?: RuntimeStepResolution,
  ): Promise<PreparedNormalStepExecution | undefined> {
    if (
      isDelegatedWorkflowStep(step)
      || isSystemWorkflowStep(step)
      || isWorkflowCallStep(step)
    ) {
      return undefined;
    }
    return this.deps.stepExecutor.prepareNormalStepExecution(
      step,
      this.deps.state,
      this.deps.task,
      this.deps.getMaxSteps(),
      stepIteration,
      runtime,
    );
  }

  buildPhase1Instruction(step: WorkflowStep, instruction: string, runtime?: RuntimeStepResolution): string {
    return this.deps.stepExecutor.buildPhase1Instruction(instruction, step, runtime);
  }

  runLoopMonitorJudge(
    monitor: LoopMonitorConfig,
    cycleCount: number,
    triggeringStep: WorkflowStep,
    triggeringRuntime: RuntimeStepResolution | undefined,
    fallbackNextStep: string,
  ): Promise<string> {
    return this.deps.loopMonitorJudgeRunner.run(monitor, cycleCount, triggeringStep, triggeringRuntime, fallbackNextStep);
  }
}
