import type { AgentResponse, LoopMonitorConfig, WorkflowMaxSteps, WorkflowState, WorkflowStep } from '../../models/types.js';
import { ABORT_STEP, FINDING_CONFLICT_ADJUDICATION_STEP } from '../constants.js';
import { FINDING_CONFLICT_ADJUDICATION_RULE_INDEX } from '../findings/adjudication-step.js';
import { isDelegatedWorkflowStep, isSystemWorkflowStep, isWorkflowCallStep } from '../step-kind.js';
import type { RuntimeStepResolution, StepRunResult, WorkflowEngineOptions } from '../types.js';
import type { PreparedNormalStepExecution } from './StepExecutor.js';
import { determineRuleTransition, type WorkflowRuleTransition } from './transitions.js';
import { RuleDetectionExhaustedError } from '../evaluation/RuleDetectionExhaustedError.js';
import type { WorkflowStepBudget } from '../workflow-step-budget.js';
import type { LoopMonitorJudgeRunResult } from './LoopMonitorJudgeRunner.js';
import {
  requireWorkflowEventAttribution,
  type WorkflowExecutionScope,
  type WorkflowEventAttribution,
} from '../workflow-execution-scope.js';

interface WorkflowEngineStepCoordinatorDeps {
  config: {
    steps: WorkflowStep[];
  };
  state: WorkflowState;
  task: string;
  stepBudget: WorkflowStepBudget;
  getOptions: () => WorkflowEngineOptions;
  stepExecutor: {
    runNormalStep: (
      step: WorkflowStep,
      state: WorkflowState,
      updateSession: (persona: string, sessionId: string | undefined) => void,
      runtime: RuntimeStepResolution | undefined,
      preparedExecution: PreparedNormalStepExecution,
      eventAttribution: WorkflowEventAttribution,
    ) => Promise<StepRunResult>;
    prepareNormalStepExecution: (
      step: WorkflowStep,
      state: WorkflowState,
      task: string,
      maxSteps: WorkflowMaxSteps,
      stepIteration: number,
      runtime?: RuntimeStepResolution,
    ) => PreparedNormalStepExecution;
    drainReportFiles: () => Array<{ step: WorkflowStep; filePath: string; fileName: string }>;
  };
  parallelRunner: {
    runParallelStep: (
      step: WorkflowStep,
      state: WorkflowState,
      task: string,
      maxSteps: WorkflowMaxSteps,
      updateSession: (persona: string, sessionId: string | undefined) => void,
      runtime: RuntimeStepResolution | undefined,
      activeStepIteration: number | undefined,
      eventAttribution: WorkflowEventAttribution,
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
      executionScope?: WorkflowExecutionScope,
    ) => Promise<AgentResponse>;
  };
  loopMonitorJudgeRunner: {
    run: (
      monitor: LoopMonitorConfig,
      cycleCount: number,
      triggeringStep: WorkflowStep,
      triggeringRuntime: RuntimeStepResolution | undefined,
      fallbackNextStep: string,
      resumedStart?: import('../../models/types.js').WorkflowPendingLoopJudgeStarted,
    ) => Promise<LoopMonitorJudgeRunResult>;
  };
  workflowCallRunner: {
    run: (
      step: WorkflowStep & { call: string },
      runtime?: RuntimeStepResolution,
    ) => Promise<StepRunResult>;
  };
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
  emitReport: (
    step: WorkflowStep,
    filePath: string,
    fileName: string,
    eventAttribution: WorkflowEventAttribution,
  ) => void;
  getExecutionOwnerPath: () => readonly import('../../models/types.js').WorkflowResumePointEntry[];
  recordParticipation: (
    step: WorkflowStep,
    reportNames: readonly string[],
    ownerPath: readonly import('../../models/types.js').WorkflowResumePointEntry[],
  ) => void;
  /** Present only when the workflow has an effective finding_contract and the finding-conflict-adjudication step was injected (see WorkflowEngine). */
  findingConflictAdjudicationRunner?: {
    run: (
      step: WorkflowStep,
      state: WorkflowState,
      runtime: RuntimeStepResolution | undefined,
      eventAttribution: WorkflowEventAttribution,
    ) => Promise<StepRunResult>;
    /** Origin the runner last resolved (state.previousStep or the pending attempt's durable originStep — origin-step requirement). */
    getLastOriginStep: () => string | undefined;
  };
}

interface CountableStepPlanBase {
  readonly runtime: RuntimeStepResolution | undefined;
  readonly stepIteration: number;
  readonly eventAttribution: WorkflowEventAttribution;
}

export type WorkflowStepExecutionPlan =
  | {
      readonly kind: 'workflow_call';
    }
  | (CountableStepPlanBase & {
      readonly kind: 'normal';
      readonly preparedExecution: PreparedNormalStepExecution;
    })
  | (CountableStepPlanBase & {
      readonly kind: 'engine_synthesized' | 'parallel' | 'arpeggio' | 'team_leader' | 'system';
    });

export class WorkflowEngineStepCoordinator {
  constructor(private readonly deps: WorkflowEngineStepCoordinatorDeps) {}

  getStep(name: string): WorkflowStep {
    const step = this.deps.config.steps.find((candidate) => candidate.name === name);
    if (!step) {
      throw new Error(`Unknown step: ${name}`);
    }
    return step;
  }

  async runStep(
    step: WorkflowStep,
    plan: WorkflowStepExecutionPlan,
  ): Promise<StepRunResult> {
    const updateSession = this.deps.updatePersonaSession;
    let result: StepRunResult;

    if (plan.kind === 'engine_synthesized') {
      const runner = this.deps.findingConflictAdjudicationRunner;
      if (!runner) {
        throw new Error(
          `Step "${step.name}" is the engine-synthesized conflict adjudication step but no adjudication runner is configured`,
        );
      }
      result = await runner.run(
        step,
        this.deps.state,
        plan.runtime,
        plan.eventAttribution,
      );
    } else if (plan.kind === 'parallel') {
      result = await this.deps.parallelRunner.runParallelStep(
        step,
        this.deps.state,
        this.deps.task,
        this.deps.stepBudget.currentMaxSteps(),
        updateSession,
        plan.runtime,
        plan.stepIteration,
        plan.eventAttribution,
      );
    } else if (plan.kind === 'arpeggio') {
      result = await this.deps.arpeggioRunner.runArpeggioStep(
        step,
        this.deps.state,
        plan.runtime,
        plan.stepIteration,
      );
    } else if (plan.kind === 'team_leader') {
      result = await this.deps.teamLeaderRunner.runTeamLeaderStep(
        step,
        this.deps.state,
        this.deps.task,
        this.deps.stepBudget.currentMaxSteps(),
        updateSession,
        plan.runtime,
        plan.stepIteration,
      );
    } else if (plan.kind === 'system') {
      result = {
        response: await this.deps.systemStepExecutor.run(step, this.deps.state, plan.runtime, plan.eventAttribution.scope),
        instruction: '',
      };
    } else if (plan.kind === 'workflow_call') {
      if (!isWorkflowCallStep(step)) {
        throw new Error(`Step "${step.name}" cannot use a workflow_call execution plan`);
      }
      result = await this.deps.workflowCallRunner.run(step);
    } else {
      if (plan.kind !== 'normal') {
        throw new Error(`Step "${step.name}" has an unsupported execution plan: ${plan.kind}`);
      }
      result = await this.deps.stepExecutor.runNormalStep(
        step,
        this.deps.state,
        updateSession,
        plan.runtime,
        plan.preparedExecution,
        plan.eventAttribution,
      );
    }

    const reports = this.deps.stepExecutor.drainReportFiles();
    if (reports.length > 0) {
      const reportAttribution = requireWorkflowEventAttribution(
        plan.kind === 'workflow_call' ? undefined : plan.eventAttribution,
        'step:report',
      );
      for (const { step: reportedStep, filePath, fileName } of reports) {
        this.deps.emitReport(reportedStep, filePath, fileName, reportAttribution);
      }
    }
    const reportedSteps = new Map<string, WorkflowStep>();
    for (const report of reports) {
      reportedSteps.set(report.step.name, report.step);
    }
    reportedSteps.set(step.name, step);
    const executionOwnerPath = plan.kind === 'workflow_call'
      ? this.deps.getExecutionOwnerPath()
      : plan.eventAttribution.scope.stack.slice(0, -1);
    const nestedOwnerPath = plan.kind === 'workflow_call'
      ? executionOwnerPath
      : plan.eventAttribution.scope.stack;
    for (const [stepName, participatedStep] of reportedSteps) {
      this.deps.recordParticipation(
        participatedStep,
        reports
          .filter((report) => report.step.name === stepName)
          .map((report) => report.fileName),
        participatedStep.name === step.name ? executionOwnerPath : nestedOwnerPath,
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

  prepareNormalStepExecution(
    step: WorkflowStep,
    stepIteration: number,
    runtime?: RuntimeStepResolution,
  ): PreparedNormalStepExecution {
    if (
      (step.name === FINDING_CONFLICT_ADJUDICATION_STEP && step.engineSynthesized === true)
      || isDelegatedWorkflowStep(step)
      || isSystemWorkflowStep(step)
      || isWorkflowCallStep(step)
    ) {
      throw new Error(`Step "${step.name}" cannot be prepared as a normal agent step`);
    }
    return this.deps.stepExecutor.prepareNormalStepExecution(
      step,
      this.deps.state,
      this.deps.task,
      this.deps.stepBudget.currentMaxSteps(),
      stepIteration,
      runtime,
    );
  }

  runLoopMonitorJudge(
    monitor: LoopMonitorConfig,
    cycleCount: number,
    triggeringStep: WorkflowStep,
    triggeringRuntime: RuntimeStepResolution | undefined,
    fallbackNextStep: string,
    resumedStart?: import('../../models/types.js').WorkflowPendingLoopJudgeStarted,
  ): Promise<LoopMonitorJudgeRunResult> {
    return this.deps.loopMonitorJudgeRunner.run(
      monitor,
      cycleCount,
      triggeringStep,
      triggeringRuntime,
      fallbackNextStep,
      resumedStart,
    );
  }
}
