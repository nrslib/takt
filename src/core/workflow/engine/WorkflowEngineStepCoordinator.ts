import type { AgentResponse, LoopMonitorConfig, WorkflowMaxSteps, WorkflowState, WorkflowStep } from '../../models/types.js';
import { ABORT_STEP, FINDING_CONFLICT_ADJUDICATION_STEP } from '../constants.js';
import { FINDING_CONFLICT_ADJUDICATION_RULE_INDEX } from '../findings/adjudication-step.js';
import { isSystemWorkflowStep, isWorkflowCallStep } from '../step-kind.js';
import type { RuntimeStepResolution, StepRunResult, WorkflowEngineOptions } from '../types.js';
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
    ) => Promise<StepRunResult>;
    buildInstruction: (
      step: WorkflowStep,
      stepIteration: number,
      state: WorkflowState,
      task: string,
      maxSteps: WorkflowMaxSteps,
    ) => string;
    buildPhase1Instruction: (instruction: string, step: WorkflowStep, runtime?: RuntimeStepResolution) => string;
    drainReportFiles: () => Array<{ step: WorkflowStep; filePath: string; fileName: string }>;
  };
  parallelRunner: {
    runParallelStep: (
      step: WorkflowStep,
      state: WorkflowState,
      task: string,
      maxSteps: WorkflowMaxSteps,
      updateSession: (persona: string, sessionId: string | undefined) => void,
      runtime?: RuntimeStepResolution,
    ) => Promise<StepRunResult>;
  };
  arpeggioRunner: {
    runArpeggioStep: (
      step: WorkflowStep,
      state: WorkflowState,
      runtime?: RuntimeStepResolution,
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
      runtime?: RuntimeStepResolution,
    ) => Promise<StepRunResult>;
    resolveRuntime: (step: WorkflowStep & { call: string }) => RuntimeStepResolution;
  };
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
  emitReport: (step: WorkflowStep, filePath: string, fileName: string) => void;
  /** Present only when the workflow has an effective finding_contract and the finding-conflict-adjudication step was injected (see WorkflowEngine). */
  findingConflictAdjudicationRunner?: {
    run: (step: WorkflowStep, state: WorkflowState, runtime?: RuntimeStepResolution) => Promise<StepRunResult>;
    /** Origin the runner last resolved (state.previousStep or the pending attempt's durable originStep — origin-step requirement). */
    getLastOriginStep: () => string | undefined;
  };
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
  ): Promise<StepRunResult> {
    const updateSession = this.deps.updatePersonaSession;
    let result: StepRunResult;

    if (step.name === FINDING_CONFLICT_ADJUDICATION_STEP && step.engineSynthesized === true) {
      const runner = this.deps.findingConflictAdjudicationRunner;
      if (!runner) {
        throw new Error(
          `Step "${step.name}" is the engine-synthesized conflict adjudication step but no adjudication runner is configured`,
        );
      }
      result = await runner.run(step, this.deps.state, runtime);
    } else if (step.parallel && step.parallel.length > 0) {
      result = await this.deps.parallelRunner.runParallelStep(
        step,
        this.deps.state,
        this.deps.task,
        this.deps.getMaxSteps(),
        updateSession,
        runtime,
      );
    } else if (step.arpeggio) {
      result = await this.deps.arpeggioRunner.runArpeggioStep(step, this.deps.state, runtime);
    } else if (step.teamLeader) {
      result = await this.deps.teamLeaderRunner.runTeamLeaderStep(
        step,
        this.deps.state,
        this.deps.task,
        this.deps.getMaxSteps(),
        updateSession,
        runtime,
      );
    } else if (isSystemWorkflowStep(step)) {
      result = {
        response: await this.deps.systemStepExecutor.run(step, this.deps.state, runtime),
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
        runtime,
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
    if (
      step.name === FINDING_CONFLICT_ADJUDICATION_STEP
      && step.engineSynthesized === true
      && response.matchedRuleIndex != null
    ) {
      const dynamicNext = this.resolveAdjudicationDynamicNextStep(response.matchedRuleIndex);
      if (dynamicNext !== undefined) {
        return { nextStep: dynamicNext };
      }
    }
    if (response.matchedRuleIndex != null && step.rules) {
      const transition = determineRuleTransition(step, response.matchedRuleIndex);
      if (transition && (transition.nextStep || transition.returnValue || transition.requiresUserInput)) {
        return transition;
      }
    }
    throw new RuleDetectionExhaustedError(step.name);
  }

  /**
   * Dynamic transitions of the engine-synthesized finding-conflict-adjudication
   * step. The originating step (whose rule routed here) is only known at run
   * time, so the FINDING_CLOSED / ACTIONABLE_FIX rules carry no static `next`
   * (see adjudication-step.ts) and are resolved from WorkflowState.previousStep:
   *
   * - FINDING_CLOSED — return to the origin step so it re-evaluates the updated
   *   ledger.
   * - ACTIONABLE_FIX — route to the origin step's fix path: its first non-AI
   *   rule with `next: fix` (contract-intake.ts's
   *   selectInvalidManagerOutputRuleIndex precedent); when absent, return to
   *   the origin whose own `when(findings.conflicts.count == 0 &&
   *   findings.open.count > 0)`-style rule routes to the fix path next round.
   *
   * Origin resolution order (origin-step requirement):
   * 1. WorkflowState.previousStep (normal in-run entry),
   * 2. the runner's last resolved origin — which covers the durable originStep
   *    persisted on the conflict's pending attempt, so a resume that starts
   *    directly at this step still returns to the true origin,
   * 3. the UNIQUE step wiring a rule to this step (only when unambiguous —
   *    guessing among multiple wiring steps such as reviewers vs final-gate
   *    would misroute),
   * 4. otherwise ABORT.
   * UNRESOLVED keeps its static `next: ABORT` and never reaches this method's
   * dynamic branch (returns undefined).
   */
  private resolveAdjudicationDynamicNextStep(matchedRuleIndex: number): string | undefined {
    if (
      matchedRuleIndex !== FINDING_CONFLICT_ADJUDICATION_RULE_INDEX.FINDING_CLOSED
      && matchedRuleIndex !== FINDING_CONFLICT_ADJUDICATION_RULE_INDEX.ACTIONABLE_FIX
    ) {
      return undefined;
    }
    const originName = this.resolveAdjudicationOriginStepName();
    if (originName === undefined) {
      return ABORT_STEP;
    }
    if (matchedRuleIndex === FINDING_CONFLICT_ADJUDICATION_RULE_INDEX.FINDING_CLOSED) {
      return originName;
    }
    const originStep = this.deps.config.steps.find((candidate) => candidate.name === originName);
    const fixRule = (originStep?.rules ?? []).find((rule) => rule.next === 'fix');
    return fixRule?.next ?? originName;
  }

  private resolveAdjudicationOriginStepName(): string | undefined {
    const isValidOrigin = (name: string | undefined): name is string => (
      name !== undefined
      && name !== FINDING_CONFLICT_ADJUDICATION_STEP
      && this.deps.config.steps.some((candidate) => candidate.name === name)
    );
    const previous = this.deps.state.previousStep;
    if (isValidOrigin(previous)) {
      return previous;
    }
    const fromRunner = this.deps.findingConflictAdjudicationRunner?.getLastOriginStep();
    if (isValidOrigin(fromRunner)) {
      return fromRunner;
    }
    const wiringSteps = this.deps.config.steps.filter((candidate) => (
      (candidate.rules ?? []).some((rule) => rule.next === FINDING_CONFLICT_ADJUDICATION_STEP)
    ));
    return wiringSteps.length === 1 ? wiringSteps[0]!.name : undefined;
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
