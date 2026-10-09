import type { AgentResponse, WorkflowEffect, WorkflowState, WorkflowStep } from '../../models/types.js';
import type { RuleEvaluatorContext } from '../evaluation/RuleEvaluator.js';
import type { StatusJudgmentPhaseContext } from '../phase-runner.js';
import type {
  SystemStepRuntimeState,
  SystemStepInputResolutionContext,
  SystemStepServicesFactory,
} from '../system/system-step-services.js';
import { resolveWorkflowStateReference } from '../state/workflow-state-access.js';
import { waitForStepDelay } from './step-delay.js';
import { evaluatePostExecutionRules } from './post-execution-rule-evaluator.js';
import type { RuntimeStepResolution } from '../types.js';
import { evaluateWhenExpression } from '../evaluation/when-evaluator.js';
import { PR_STATUS_TIMEOUT_MS, PrStatusTimeoutError, type PrMergeOptions } from '../system/pr-execution-context.js';
import { parseWorkflowRuleCondition } from '../../models/workflow-rule-condition.js';

interface SystemStepExecutorDeps extends PrMergeOptions {
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
  readonly abortSignal?: AbortSignal;
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
  private readonly waitAbort = new AbortController();
  private readonly abortSignal: AbortSignal;
  private readonly runtimeState: SystemStepRuntimeState = {
    cache: new Map(),
    cleanupHandlers: new Set(),
  };

  constructor(private readonly deps: SystemStepExecutorDeps) {
    this.abortSignal = AbortSignal.any([this.waitAbort.signal,
      ...(deps.abortSignal === undefined ? [] : [deps.abortSignal])]);
  }

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
      prExecutionContext: this.deps.prExecutionContext,
      mergeMethod: this.deps.mergeMethod,
      prGitOperations: this.deps.prGitOperations,
      abortSignal: this.abortSignal,
    });
  }

  cleanup(): void {
    this.cancel();
    for (const cleanup of this.runtimeState.cleanupHandlers) {
      cleanup();
    }
    this.runtimeState.cleanupHandlers.clear();
    this.runtimeState.cache.clear();
  }

  cancel(): void {
    this.waitAbort.abort();
  }

  private async waitInterval(intervalMs: number): Promise<void> {
    const signal = this.abortSignal;
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, intervalMs);
      signal.addEventListener('abort', finish, { once: true });
    });
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

    const wait = step.kind === 'system' ? step.wait : undefined;
    const resolveInputs = async (): Promise<boolean> => {
      const resolvedContext: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      if ((step.systemInputs?.length ?? 0) > 0) {
        const services = this.requireServices(cwd);
        const resolutionContext: SystemStepInputResolutionContext = {
          cache: new Map(),
          resolvedBindings: new Map(),
          prStatusFetchOptions: {
            timeoutMs: PR_STATUS_TIMEOUT_MS,
            signal: this.abortSignal,
          },
        };
        for (const input of step.systemInputs ?? []) {
          const resolvedInput = await services.resolveSystemInput(input, state, step.name, resolutionContext);
          resolvedContext[input.as] = resolvedInput;
          resolutionContext.resolvedBindings.set(input.as, resolvedInput);
        }
      }
      state.systemContexts.set(step.name, resolvedContext);
      return true;
    };
    const acquireInputs = async (): Promise<boolean> => {
      try {
        return await resolveInputs();
      } catch (error) {
        if (this.abortSignal.aborted) return false;
        if (wait && error instanceof PrStatusTimeoutError) return false;
        throw error;
      }
    };
    const interrupted = () => this.abortSignal.aborted;
    const interruptedResponse = (): AgentResponse => ({
      persona: step.name, status: 'blocked', content: 'System wait interrupted.', timestamp: new Date(),
    });
    if (interrupted()) return interruptedResponse();
    let inputsResolved = await acquireInputs();
    if (interrupted()) return interruptedResponse();
    let systemWaitTimeout = false;
    if (wait) {
      const condition = parseWorkflowRuleCondition(wait.until);
      if (condition.kind !== 'when') throw new Error('wait.until requires when(...)');
      let retries = 0;
      while (!inputsResolved || !evaluateWhenExpression(condition.expression, state)) {
        if (retries === wait.maxRetries) {
          systemWaitTimeout = true;
          break;
        }
        await this.waitInterval(wait.intervalMs);
        if (interrupted()) return interruptedResponse();
        retries += 1;
        inputsResolved = await acquireInputs();
        if (interrupted()) return interruptedResponse();
      }
    }
    if (interrupted()) return interruptedResponse();
    if (!systemWaitTimeout && step.effects && step.effects.length > 0) {
      const stepEffectResults: Record<string, unknown> = {};
      for (const effect of step.effects) {
        stepEffectResults[effect.type] = await this.executeEffect(effect, state, cwd);
        state.effectResults.set(step.name, { ...stepEffectResults });
      }
    }

    const responseContent = `System step "${step.name}" completed.`;
    const match = systemWaitTimeout ? undefined : await evaluatePostExecutionRules(step, () => this.deps.getStatusJudgmentContext(
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
      ...(systemWaitTimeout ? { systemWaitTimeout: true } : {}),
    };

    state.stepOutputs.set(step.name, response);
    state.lastOutput = response;
    return response;
  }
}
