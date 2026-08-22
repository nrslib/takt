import type { AgentResponse, WorkflowEffect, WorkflowState, WorkflowStep } from '../../models/types.js';
import type { RuleEvaluatorContext } from '../evaluation/RuleEvaluator.js';
import type { StatusJudgmentPhaseContext } from '../phase-runner.js';
import type {
  SystemStepRuntimeState,
  SystemStepInputResolutionContext,
  SystemStepServices,
  SystemStepServicesFactory,
} from '../system/system-step-services.js';
import { resolveWorkflowStateReference } from '../state/workflow-state-access.js';
import { waitForStepDelay } from './step-delay.js';
import { evaluatePostExecutionRules } from './post-execution-rule-evaluator.js';
import type { RuntimeStepResolution } from '../types.js';

interface SystemStepExecutorDeps {
  readonly task: string;
  readonly projectCwd: string;
  readonly getCwd: () => string;
  readonly taskContext?: {
    readonly issueNumber?: number;
    readonly runSlug?: string;
  };
  readonly getRuleContext: (
    step: WorkflowStep,
    runtime?: RuntimeStepResolution,
  ) => Omit<RuleEvaluatorContext, 'state'>;
  readonly getStatusJudgmentContext: (
    step: WorkflowStep,
    state: WorkflowState,
    lastResponse: string,
    runtime?: RuntimeStepResolution,
  ) => StatusJudgmentPhaseContext;
  readonly systemStepServicesFactory?: SystemStepServicesFactory;
}

function isTemplateValue(value: string): boolean {
  return /^\{(?:context|structured|effect):.+\}$/.test(value);
}

function resolveTemplateReference(reference: string, state: WorkflowState): unknown {
  return resolveWorkflowStateReference(reference, state);
}

function resolveTemplateString(template: string, state: WorkflowState): unknown {
  if (isTemplateValue(template)) {
    const inner = template.slice(1, -1).replace(':', '.');
    return resolveTemplateReference(inner, state);
  }

  return template.replace(/\{(context|structured|effect):([^}]+)\}/g, (_match, root, ref) => {
    const value = resolveTemplateReference(`${root}.${ref.replace(/:/g, '.')}`, state);
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`Template interpolation requires scalar value for "${root}:${ref}"`);
    }
    return String(value);
  });
}

function resolveEffectPayload(effect: WorkflowEffect, state: WorkflowState): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(effect).map(([key, value]) => {
      if (typeof value === 'string') {
        return [key, resolveTemplateString(value, state)];
      }
      return [key, value];
    }),
  );
}

export class SystemStepExecutor {
  private readonly runtimeState: SystemStepRuntimeState = {
    cache: new Map(),
    cleanupHandlers: new Set(),
  };

  constructor(private readonly deps: SystemStepExecutorDeps) {}

  private requireServices(cwd: string) {
    if (!this.deps.systemStepServicesFactory) {
      throw new Error('System step services are not configured');
    }
    return this.deps.systemStepServicesFactory({
      cwd,
      projectCwd: this.deps.projectCwd,
      task: this.deps.task,
      taskContext: this.deps.taskContext,
      runtimeState: this.runtimeState,
    });
  }

  cleanup(): void {
    for (const cleanup of this.runtimeState.cleanupHandlers) {
      cleanup();
    }
    this.runtimeState.cleanupHandlers.clear();
    this.runtimeState.cache.clear();
  }

  private resolveSystemInput(
    services: SystemStepServices,
    input: NonNullable<WorkflowStep['systemInputs']>[number],
    state: WorkflowState,
    stepName: string,
    resolutionContext: SystemStepInputResolutionContext,
  ): unknown {
    return services.resolveSystemInput(input, state, stepName, resolutionContext);
  }

  private async executeEffect(
    effect: WorkflowEffect,
    state: WorkflowState,
    cwd: string,
  ): Promise<Record<string, unknown>> {
    const payload = resolveEffectPayload(effect, state);
    const services = this.requireServices(cwd);
    return services.executeEffect(effect, payload, state);
  }

  async run(
    step: WorkflowStep,
    state: WorkflowState,
    runtime?: RuntimeStepResolution,
  ): Promise<AgentResponse> {
    await waitForStepDelay(step);
    const cwd = this.deps.getCwd();
    const ruleContext = this.deps.getRuleContext(step, runtime);

    const resolvedContext: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    if ((step.systemInputs?.length ?? 0) > 0) {
      const services = this.requireServices(cwd);
      const resolutionContext: SystemStepInputResolutionContext = {
        cache: new Map(),
        resolvedBindings: new Map(),
      };
      for (const input of step.systemInputs ?? []) {
        const resolvedInput = this.resolveSystemInput(
          services,
          input,
          state,
          step.name,
          resolutionContext,
        );
        resolvedContext[input.as] = resolvedInput;
        resolutionContext.resolvedBindings.set(input.as, resolvedInput);
      }
    }
    state.systemContexts.set(step.name, resolvedContext);

    if (step.effects && step.effects.length > 0) {
      const stepEffectResults: Record<string, unknown> = {};
      for (const effect of step.effects) {
        stepEffectResults[effect.type] = await this.executeEffect(effect, state, cwd);
        state.effectResults.set(step.name, { ...stepEffectResults });
      }
    }

    const responseContent = `System step "${step.name}" completed.`;
    const match = await evaluatePostExecutionRules(step, () => this.deps.getStatusJudgmentContext(
      step,
      state,
      responseContent,
      runtime,
    ), {
      ...ruleContext,
      state,
    });

    const response: AgentResponse = {
      persona: step.name,
      status: 'done',
      content: responseContent,
      timestamp: new Date(),
      matchedRuleIndex: match?.index,
      matchedRuleMethod: match?.method,
    };

    state.stepOutputs.set(step.name, response);
    state.lastOutput = response;
    return response;
  }
}
