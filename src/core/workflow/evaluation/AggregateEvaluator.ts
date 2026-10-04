import {
  getAllParallelSubSteps,
  isDynamicParallelSubSteps,
  type WorkflowStep,
  type WorkflowState,
} from '../../models/types.js';
import {
  dynamicParallelAggregateTargetLabel,
  formatWorkflowRuleCondition,
  PARALLEL_TERMINAL_ERROR_LABEL,
  semanticLabelsOf,
  type WorkflowRuleCondition,
} from '../../models/workflow-rule-condition.js';
import { resolveDynamicParallelSelection } from '../dynamic-parallel/snapshot.js';

export class AggregateEvaluator {
  constructor(private readonly step: WorkflowStep, private readonly state: WorkflowState) {}

  evaluateCondition(condition: WorkflowRuleCondition): boolean {
    if (condition.kind !== 'aggregate') return false;
    const subSteps = this.step.parallel;
    if (subSteps === undefined || getAllParallelSubSteps(subSteps).length === 0) return false;
    if (isDynamicParallelSubSteps(subSteps)) {
      return this.evaluateDynamicCondition(condition, this.resolveDynamicParticipants(subSteps));
    }
    return this.evaluateLegacyCondition(condition, getAllParallelSubSteps(subSteps));
  }

  private evaluateDynamicCondition(
    condition: Extract<WorkflowRuleCondition, { kind: 'aggregate' }>,
    participants: readonly WorkflowStep[],
  ): boolean {
    const targetLabel = dynamicParallelAggregateTargetLabel(condition);
    if (targetLabel === undefined) {
      throw new Error(`Dynamic parallel aggregate for "${this.step.name}" requires one semantic target label`);
    }
    const matchedLabels = participants.map((subStep) => {
      const matchedCondition = this.matchedCondition(subStep);
      return matchedCondition === undefined ? [] : semanticLabelsOf(matchedCondition);
    });
    return condition.aggregate === 'all'
      ? matchedLabels.every((labels) => labels.includes(targetLabel))
      : matchedLabels.some((labels) => labels.includes(targetLabel));
  }

  private evaluateLegacyCondition(
    condition: Extract<WorkflowRuleCondition, { kind: 'aggregate' }>,
    subSteps: readonly WorkflowStep[],
  ): boolean {
    const matchedConditions = subSteps.map((subStep) => {
      const matchedCondition = this.matchedCondition(subStep);
      return matchedCondition === undefined ? undefined : formatWorkflowRuleCondition(matchedCondition);
    });
    const expectedConditions = condition.targetConditions.map(formatWorkflowRuleCondition);
    if (condition.aggregate === 'all') {
      return expectedConditions.length === 1
        ? matchedConditions.every((matchedCondition) => matchedCondition === expectedConditions[0])
        : matchedConditions.length === expectedConditions.length
          && matchedConditions.every((matchedCondition, index) => matchedCondition === expectedConditions[index]);
    }
    return matchedConditions.some((matchedCondition) => (
      matchedCondition !== undefined && expectedConditions.includes(matchedCondition)
    ));
  }

  private matchedCondition(subStep: WorkflowStep): WorkflowRuleCondition | undefined {
    const output = this.state.stepOutputs.get(subStep.name);
    if (output?.status === 'error') {
      return { kind: 'semantic', label: PARALLEL_TERMINAL_ERROR_LABEL };
    }
    return output?.matchedRuleIndex === undefined
      ? undefined
      : subStep.rules?.[output.matchedRuleIndex]?.condition;
  }

  private resolveDynamicParticipants(
    parallel: Extract<NonNullable<WorkflowStep['parallel']>, { kind: 'dynamic' }>,
  ): WorkflowStep[] {
    if (this.state.currentStep !== this.step.name) {
      throw new Error(`Dynamic parallel aggregate for "${this.step.name}" requires the step to be active`);
    }
    const identity = this.state.activeDynamicParallelSelectionIdentity;
    if (identity === undefined) {
      throw new Error(`Dynamic parallel aggregate for "${this.step.name}" requires an active selection identity`);
    }
    const snapshot = this.state.dynamicParallelSelections.get(identity);
    if (snapshot === undefined || snapshot.identity !== identity || snapshot.step_name !== this.step.name) {
      throw new Error(`Dynamic parallel aggregate for "${this.step.name}" requires a matching selection snapshot`);
    }
    return resolveDynamicParallelSelection(parallel, snapshot);
  }
}
