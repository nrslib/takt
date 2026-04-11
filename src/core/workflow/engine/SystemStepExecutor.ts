import type { AgentResponse, WorkflowEffect, WorkflowState, WorkflowStep } from '../../models/types.js';
import { detectMatchedRule } from '../evaluation/index.js';
import type { RuleEvaluatorContext } from '../evaluation/RuleEvaluator.js';
import type { SystemStepServicesFactory } from '../system/system-step-services.js';
import { resolveWorkflowStateReference } from '../state/workflow-state-access.js';
import { waitForStepDelay } from './step-delay.js';

interface SystemStepExecutorDeps {
  readonly task: string;
  readonly projectCwd: string;
  readonly taskContext?: {
    readonly issueNumber?: number;
  };
  readonly ruleContext: Omit<RuleEvaluatorContext, 'state'>;
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
  constructor(private readonly deps: SystemStepExecutorDeps) {}

  private requireServices() {
    if (!this.deps.systemStepServicesFactory) {
      throw new Error('System step services are not configured');
    }
    return this.deps.systemStepServicesFactory({
      cwd: this.deps.ruleContext.cwd,
      projectCwd: this.deps.projectCwd,
      task: this.deps.task,
      taskContext: this.deps.taskContext,
    });
  }

  private resolveSystemInput(input: NonNullable<WorkflowStep['systemInputs']>[number]): Record<string, unknown> {
    const services = this.requireServices();
    return services.resolveSystemInput(input);
  }

  private async executeEffect(effect: WorkflowEffect, state: WorkflowState): Promise<Record<string, unknown>> {
    const payload = resolveEffectPayload(effect, state);
    const services = this.requireServices();
    return services.executeEffect(effect, payload, state);
  }

  async run(step: WorkflowStep, state: WorkflowState): Promise<AgentResponse> {
    await waitForStepDelay(step);

    const contextEntries = (step.systemInputs ?? []).map((input) => [
      input.as,
      this.resolveSystemInput(input),
    ] as const);
    state.systemContexts.set(step.name, Object.fromEntries(contextEntries));

    for (const effect of step.effects ?? []) {
      state.effectResults.set(effect.type, await this.executeEffect(effect, state));
    }

    const match = await detectMatchedRule(step, '', '', {
      ...this.deps.ruleContext,
      state,
    });

    const response: AgentResponse = {
      persona: step.name,
      status: 'done',
      content: `System step "${step.name}" completed.`,
      timestamp: new Date(),
      matchedRuleIndex: match?.index,
      matchedRuleMethod: match?.method,
    };

    state.stepOutputs.set(step.name, response);
    state.lastOutput = response;
    return response;
  }
}
