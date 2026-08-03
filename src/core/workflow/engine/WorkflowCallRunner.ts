import { resolveEffectiveProviderOptions } from '../../../infra/config/providerOptions.js';
import type {
  AgentResponse,
  FindingContractConfig,
  WorkflowConfig,
  WorkflowCallStep,
  WorkflowMaxSteps,
  WorkflowResumePointEntry,
  WorkflowState,
} from '../../models/types.js';
import type { FindingLedgerStore } from '../findings/store.js';
import type { RunPaths } from '../run/run-paths.js';
import {
  applyProviderModelOverride,
  resolveWorkflowCallProviderModel,
} from '../provider-resolution.js';
import {
  buildWorkflowResumePointEntry,
  getResumePointWorkflowReference,
  getWorkflowReference,
} from '../workflow-reference.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../workflow-call-depth.js';
import { buildWorkflowCallInvocationIdentity } from '../workflow-call-invocation-index.js';
import { withWorkflowConfigErrorPath } from '../workflow-config-error.js';
import { findWorkflowStepLocation } from '../workflow-step-location.js';
import type {
  RuntimeStepResolution,
  StepProviderInfo,
  StepRunResult,
  WorkflowCallChildEngine,
  WorkflowCallCompleteLifecycle,
  WorkflowCallLifecycle,
  WorkflowCallResolver,
  WorkflowEngineOptions,
  WorkflowSharedRuntimeState,
} from '../types.js';
import {
  WorkflowCallExecutor,
  applyWorkflowCallOverridesToProviderRouting,
  applyWorkflowCallOverridesToPersonaProviders,
  type WorkflowCallExecutionResult,
  type WorkflowCallIsolatedStateSync,
  type WorkflowCallSessionUpdates,
  type PreparedWorkflowCallExecution,
} from './WorkflowCallExecutor.js';
import { terminalLabelOf } from '../../models/workflow-rule-condition.js';
import { RuleDetectionExhaustedError } from '../evaluation/RuleDetectionExhaustedError.js';
import { translateWorkflowConfigError } from '../../../shared/workflowConfigMetadata.js';
import { getErrorMessage } from '../../../shared/utils/error.js';

interface WorkflowCallRunnerDeps {
  getConfig: () => WorkflowConfig;
  getMaxSteps: () => WorkflowMaxSteps;
  updateMaxSteps: (maxSteps: WorkflowMaxSteps) => void;
  state: WorkflowState;
  projectCwd: string;
  getCwd: () => string;
  task: string;
  getOptions: () => WorkflowEngineOptions;
  sharedRuntime: WorkflowSharedRuntimeState;
  resumeStackPrefix: WorkflowResumePointEntry[];
  consumeWorkflowCallContinuation: (
    step: WorkflowCallStep,
    occurrence: number,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ) => WorkflowResumePointEntry | undefined;
  runPaths: RunPaths;
  setActiveResumePoint: (
    step: WorkflowCallStep,
    iteration: number,
    occurrence: number,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ) => void;
  emit: (event: string, ...args: unknown[]) => void;
  resolveWorkflowCall: WorkflowCallResolver;
  createEngine: (
    config: WorkflowConfig,
    cwd: string,
    task: string,
    options: WorkflowEngineOptions,
  ) => WorkflowCallChildEngine;
  /** 自前 or 継承済みの、この engine で有効な Finding Contract。子へ引き継ぐ。 */
  findingContract?: FindingContractConfig;
  findingLedgerStore?: FindingLedgerStore;
  /** workflow_call 完了後、子が書き込んだ台帳を親の state.findings へ反映する。 */
  refreshFindingsState: () => void;
}

export interface WorkflowCallExecutionToken {
  readonly stepName: string;
  readonly occurrence: number;
  readonly resumeStackPrefix: readonly WorkflowResumePointEntry[];
  cancel(): void;
}

interface PendingWorkflowCallExecution {
  readonly identity: string;
  readonly occurrence: number;
  readonly token: WorkflowCallExecutionToken;
}

interface WorkflowCallAttempt {
  readonly lifecycle: WorkflowCallLifecycle;
  readonly preparedExecution: PreparedWorkflowCallExecution;
  started: boolean;
}

interface WorkflowCallAttemptValue<T> {
  readonly childResult: WorkflowCallExecutionResult;
  readonly value: T;
}

type WorkflowCallAttemptOutcome<T> =
  | { readonly lifecycle: WorkflowCallCompleteLifecycle; readonly value: T }
  | { readonly lifecycle: WorkflowCallCompleteLifecycle; readonly error: unknown };

export class WorkflowCallRunner {
  private readonly executor: WorkflowCallExecutor;
  private readonly preparedExecutions = new WeakMap<WorkflowCallExecutionToken, WorkflowCallAttempt>();
  private pendingExecution: PendingWorkflowCallExecution | undefined;

  constructor(private readonly deps: WorkflowCallRunnerDeps) {
    this.executor = new WorkflowCallExecutor(deps);
  }

  private resolveParentWorkflowProviderContext(): {
    provider: WorkflowEngineOptions['provider'];
    providerSource: WorkflowEngineOptions['providerSource'];
    model: string | undefined;
    modelSource: WorkflowEngineOptions['modelSource'];
    providerOptions: WorkflowEngineOptions['providerOptions'];
  } {
    const options = this.deps.getOptions();
    const parentConfig = this.deps.getConfig();
    const providerInfo = resolveWorkflowCallProviderModel({
      workflow: parentConfig,
      provider: options.provider,
      providerSource: options.providerSource,
      model: options.model,
      modelSource: options.modelSource,
    });
    const providerOptions = resolveEffectiveProviderOptions(
      options.providerOptionsSource,
      options.providerOptionsOriginResolver,
      options.providerOptions,
      parentConfig.providerOptions,
    );

    return {
      provider: providerInfo.provider,
      providerSource: providerInfo.providerSource,
      model: providerInfo.model,
      modelSource: providerInfo.modelSource,
      providerOptions,
    };
  }

  private resolveChildProviderModel(
    step: WorkflowCallStep,
    childWorkflow: WorkflowConfig,
  ): StepProviderInfo {
    const parentProviderInfo = this.resolveParentWorkflowProviderContext();
    const childProviderInfo = resolveWorkflowCallProviderModel({
      workflow: childWorkflow,
      provider: parentProviderInfo.provider,
      providerSource: parentProviderInfo.providerSource,
      model: parentProviderInfo.model,
      modelSource: parentProviderInfo.modelSource,
    });
    if (!step.overrides) {
      return {
        provider: childProviderInfo.provider,
        providerSource: childProviderInfo.providerSource,
        model: childProviderInfo.model,
        modelSource: childProviderInfo.modelSource,
      };
    }

    return applyProviderModelOverride(childProviderInfo, {
      provider: step.overrides.provider,
      providerSpecified: step.overrides.provider !== undefined,
      model: step.overrides.model,
      modelSpecified: step.overrides.model !== undefined,
      source: 'workflow_call',
    });
  }

  resolveRuntime(step: WorkflowCallStep): RuntimeStepResolution {
    const parentProviderInfo = this.resolveParentWorkflowProviderContext();
    const workflowCallProviderModel = applyProviderModelOverride(parentProviderInfo, {
      provider: step.overrides?.provider,
      providerSpecified: step.overrides?.provider !== undefined,
      model: step.overrides?.model,
      modelSpecified: step.overrides?.model !== undefined,
      source: 'workflow_call',
    });
    return {
      providerInfo: {
        provider: workflowCallProviderModel.provider,
        providerSource: workflowCallProviderModel.providerSource,
        model: workflowCallProviderModel.model,
        modelSource: workflowCallProviderModel.modelSource,
      },
    };
  }

  private buildChildPersonaProviders(
    step: WorkflowCallStep,
  ): WorkflowEngineOptions['personaProviders'] {
    return applyWorkflowCallOverridesToPersonaProviders(
      this.deps.getOptions().personaProviders,
      step.overrides,
    );
  }

  private buildChildProviderRouting(
    step: WorkflowCallStep,
  ): WorkflowEngineOptions['providerRouting'] {
    return applyWorkflowCallOverridesToProviderRouting(
      this.deps.getOptions().providerRouting,
      step.overrides,
    );
  }

  private buildWorkflowCallResponse(
    step: WorkflowCallStep,
    childState: WorkflowState,
    abortKind: WorkflowCallExecutionResult['abortKind'],
    abortReason: string | undefined,
    returnValue: string | undefined,
  ): AgentResponse {
    const terminalStatus = childState.status === 'completed' ? 'COMPLETE' : 'ABORT';
    const matchedCondition = returnValue ?? terminalStatus;
    const finalContent = returnValue !== undefined
      ? childState.lastOutput?.content ?? returnValue
      : terminalStatus === 'COMPLETE'
      ? childState.lastOutput?.content ?? terminalStatus
      : abortKind === 'step_transition'
        ? childState.lastOutput?.content ?? abortReason ?? terminalStatus
        : abortReason ?? terminalStatus;
    const interactive = this.deps.getOptions().interactive === true;
    const matchedRuleIndex = step.rules?.findIndex(
      (rule) => (
        (rule.interactiveOnly !== true || interactive)
        && terminalLabelOf(rule.condition) === matchedCondition
      ),
    );
    if (matchedRuleIndex === undefined || matchedRuleIndex < 0) {
      throw new RuleDetectionExhaustedError(step.name);
    }

    return {
      persona: step.name,
      status: 'done',
      content: finalContent,
      timestamp: new Date(),
      matchedRuleIndex,
    };
  }

  private requireIsolatedSessionUpdates(
    step: WorkflowCallStep,
    childResult: WorkflowCallExecutionResult,
  ): WorkflowCallSessionUpdates {
    if (!childResult.sessionUpdates) {
      throw new Error(`workflow_call step "${step.name}" isolated execution did not return session updates`);
    }
    return childResult.sessionUpdates;
  }

  private requireIsolatedStateSync(
    step: WorkflowCallStep,
    childResult: WorkflowCallExecutionResult,
  ): WorkflowCallIsolatedStateSync {
    if (!childResult.isolatedStateSync) {
      throw new Error(`workflow_call step "${step.name}" isolated execution did not return state sync`);
    }
    return childResult.isolatedStateSync;
  }

  private translateWorkflowCallConfigError(
    parentConfig: WorkflowConfig,
    step: WorkflowCallStep,
    error: unknown,
    fieldPath: readonly PropertyKey[],
  ): Error {
    const stepPath = findWorkflowStepLocation(parentConfig, step);
    if (!stepPath) {
      return error instanceof Error ? error : new Error(String(error));
    }
    return translateWorkflowConfigError(
      parentConfig,
      withWorkflowConfigErrorPath(error, [...stepPath, ...fieldPath]),
    );
  }

  private resolveCallableChildWorkflow(
    step: WorkflowCallStep,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ): WorkflowConfig {
    const parentConfig = this.deps.getConfig();
    const childWorkflow = this.deps.resolveWorkflowCall({
      parentWorkflow: parentConfig,
      step,
      projectCwd: this.deps.projectCwd,
      lookupCwd: this.deps.getCwd(),
    });
    if (!childWorkflow) {
      throw this.translateWorkflowCallConfigError(
        parentConfig,
        step,
        new Error(`workflow_call step "${step.name}" references unknown workflow "${step.call}"`),
        ['call'],
      );
    }
    if (childWorkflow.subworkflow?.callable !== true) {
      throw this.translateWorkflowCallConfigError(
        parentConfig,
        step,
        new Error(`workflow "${childWorkflow.name}" is not callable`),
        ['call'],
      );
    }

    const workflowChain = [
      ...resumeStackPrefix
        .filter((entry) => entry.kind === 'workflow_call')
        .map((entry) => getResumePointWorkflowReference(entry)),
      getWorkflowReference(parentConfig),
    ];
    const childWorkflowRef = getWorkflowReference(childWorkflow);
    if (workflowChain.includes(childWorkflowRef)) {
      throw this.translateWorkflowCallConfigError(
        parentConfig,
        step,
        new Error(`Detected workflow_call cycle: ${[...workflowChain, childWorkflow.name].join(' -> ')}`),
        ['call'],
      );
    }

    const currentDepth = resumeStackPrefix.filter(
      (entry) => entry.kind === 'workflow_call',
    ).length + 1;
    const nextDepth = currentDepth + 1;
    if (nextDepth > MAX_WORKFLOW_CALL_DEPTH) {
      throw this.translateWorkflowCallConfigError(
        parentConfig,
        step,
        new Error(`workflow_call depth exceeds limit (${MAX_WORKFLOW_CALL_DEPTH}): ${childWorkflow.name}`),
        ['call'],
      );
    }
    return childWorkflow;
  }

  private buildAttemptLifecycle(
    step: WorkflowCallStep,
    occurrence: number,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ): WorkflowCallLifecycle {
    const parentConfig = this.deps.getConfig();
    const stackPrefixSnapshot = resumeStackPrefix.map((entry) => ({
      ...entry,
      ...(entry.step_iterations === undefined
        ? {}
        : { step_iterations: { ...entry.step_iterations } }),
    }));
    const lifecycle: WorkflowCallLifecycle = {
      parentWorkflow: getWorkflowReference(parentConfig),
      step: step.name,
      childWorkflow: step.call,
      callInstance: occurrence,
      stack: [
        ...stackPrefixSnapshot,
        buildWorkflowResumePointEntry(
          parentConfig,
          step.name,
          'workflow_call',
          occurrence,
          this.deps.state.stepIterations,
          occurrence,
        ),
      ],
    };
    return lifecycle;
  }

  private emitAttemptStart(attempt: WorkflowCallAttempt): void {
    if (attempt.started) return;
    attempt.started = true;
    this.deps.emit('workflow_call:start', attempt.lifecycle);
  }

  private buildTerminalLifecycle(
    attempt: WorkflowCallAttempt,
    result: WorkflowCallExecutionResult,
  ): WorkflowCallCompleteLifecycle {
    if (result.status === 'completed') {
      return {
        ...attempt.lifecycle,
        result: {
          status: 'completed',
          ...(result.returnValue === undefined ? {} : { returnValue: result.returnValue }),
        },
      };
    }
    if (result.status !== 'aborted') {
      throw new Error(`workflow_call child "${attempt.lifecycle.childWorkflow}" returned a non-terminal state`);
    }
    return {
      ...attempt.lifecycle,
      result: {
        status: 'aborted',
        ...(result.abortKind === undefined ? {} : { abortKind: result.abortKind }),
        ...(result.abortReason === undefined ? {} : { abortReason: result.abortReason }),
      },
    };
  }

  private buildFailedLifecycle(
    lifecycle: WorkflowCallLifecycle,
    error: unknown,
  ): WorkflowCallCompleteLifecycle {
    return {
      ...lifecycle,
      result: {
        status: 'failed',
        reason: getErrorMessage(error),
      },
    };
  }

  private async resolveAttempt<T>(
    attempt: WorkflowCallAttempt,
    execute: () => Promise<WorkflowCallAttemptValue<T>>,
  ): Promise<WorkflowCallAttemptOutcome<T>> {
    try {
      const result = await execute();
      return {
        lifecycle: this.buildTerminalLifecycle(attempt, result.childResult),
        value: result.value,
      };
    } catch (error) {
      return {
        lifecycle: this.buildFailedLifecycle(attempt.lifecycle, error),
        error,
      };
    }
  }

  private async executeAttempt<T>(
    attempt: WorkflowCallAttempt,
    execute: () => Promise<WorkflowCallAttemptValue<T>>,
  ): Promise<T> {
    const outcome = await this.resolveAttempt(attempt, execute);
    this.deps.emit('workflow_call:complete', outcome.lifecycle);
    if ('error' in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  }

  private failAttempt(lifecycle: WorkflowCallLifecycle, error: unknown): void {
    this.deps.emit('workflow_call:complete', this.buildFailedLifecycle(lifecycle, error));
  }

  private emitFailedAttempt(lifecycle: WorkflowCallLifecycle, error: unknown): void {
    // canonical invocation は start listener が再開点を保存する前に確定必須なため、
    // その事前確定が失敗した場合だけ lifecycle pair をここで同時に閉じる。
    this.deps.emit('workflow_call:start', lifecycle);
    this.failAttempt(lifecycle, error);
  }

  private prepareInvocation(
    step: WorkflowCallStep,
    occurrence: number,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ): WorkflowCallExecutionToken {
    const identity = buildWorkflowCallInvocationIdentity(
      getWorkflowReference(this.deps.getConfig()),
      step.name,
      resumeStackPrefix,
    );
    if (
      this.pendingExecution?.identity === identity
      && this.pendingExecution.occurrence === occurrence
    ) {
      return this.pendingExecution.token;
    }
    this.cancelPendingInvocation();
    const unresolvedLifecycle = this.buildAttemptLifecycle(step, occurrence, resumeStackPrefix);
    let childWorkflow: WorkflowConfig;
    try {
      childWorkflow = this.resolveCallableChildWorkflow(step, resumeStackPrefix);
    } catch (error) {
      this.emitFailedAttempt(unresolvedLifecycle, error);
      throw error;
    }
    const lifecycle = {
      ...unresolvedLifecycle,
      childWorkflow: getWorkflowReference(childWorkflow),
    };
    try {
      const preparedExecution = this.executor.prepare(
        step,
        childWorkflow,
        occurrence,
        resumeStackPrefix,
      );
      const token: WorkflowCallExecutionToken = Object.freeze({
        stepName: step.name,
        occurrence,
        resumeStackPrefix: preparedExecution.resumeStackPrefix,
        cancel: () => {
          const attempt = this.preparedExecutions.get(token);
          if (this.pendingExecution?.token === token) {
            this.pendingExecution = undefined;
          }
          if (attempt !== undefined) {
            this.preparedExecutions.delete(token);
            if (attempt.started) {
              this.failAttempt(
                attempt.lifecycle,
                new Error(`workflow_call step "${attempt.lifecycle.step}" execution was cancelled`),
              );
            }
          }
        },
      });
      this.preparedExecutions.set(token, { lifecycle, preparedExecution, started: false });
      this.pendingExecution = { identity, occurrence, token };
      return token;
    } catch (error) {
      this.emitFailedAttempt(lifecycle, error);
      throw error;
    }
  }

  cancelPendingInvocation(): void {
    this.pendingExecution?.token.cancel();
  }

  activateInvocation(
    step: WorkflowCallStep,
    iteration: number,
    occurrence: number,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ): WorkflowCallExecutionToken {
    const token = this.prepareInvocation(step, occurrence, resumeStackPrefix);
    try {
      this.deps.setActiveResumePoint(step, iteration, occurrence, token.resumeStackPrefix);
      const attempt = this.preparedExecutions.get(token);
      if (attempt === undefined) {
        throw new Error(`workflow_call step "${step.name}" execution was not prepared`);
      }
      this.emitAttemptStart(attempt);
      return token;
    } catch (error) {
      const attempt = this.preparedExecutions.get(token);
      this.preparedExecutions.delete(token);
      if (this.pendingExecution?.token === token) {
        this.pendingExecution = undefined;
      }
      if (attempt !== undefined) {
        if (attempt.started) {
          this.failAttempt(attempt.lifecycle, error);
        } else {
          this.emitFailedAttempt(attempt.lifecycle, error);
        }
      }
      throw error;
    }
  }

  private consumePreparedExecution(
    step: WorkflowCallStep,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
    token: WorkflowCallExecutionToken,
  ): WorkflowCallAttempt {
    const attempt = this.preparedExecutions.get(token);
    if (attempt === undefined) {
      throw new Error(`workflow_call step "${step.name}" execution was not prepared`);
    }
    try {
      const expectedIdentity = buildWorkflowCallInvocationIdentity(
        getWorkflowReference(this.deps.getConfig()),
        step.name,
        resumeStackPrefix,
      );
      const tokenIdentity = buildWorkflowCallInvocationIdentity(
        getWorkflowReference(this.deps.getConfig()),
        token.stepName,
        token.resumeStackPrefix,
      );
      if (tokenIdentity !== expectedIdentity) {
        throw new Error(`workflow_call step "${step.name}" execution token does not match the call site`);
      }
      if (token.occurrence !== attempt.preparedExecution.occurrence) {
        throw new Error(`workflow_call step "${step.name}" execution token occurrence does not match its preparation`);
      }
    } catch (error) {
      this.preparedExecutions.delete(token);
      if (this.pendingExecution?.token === token) {
        this.pendingExecution = undefined;
      }
      this.failAttempt(attempt.lifecycle, error);
      throw error;
    }
    this.preparedExecutions.delete(token);
    if (this.pendingExecution?.token === token) {
      this.pendingExecution = undefined;
    }
    return attempt;
  }

  private async executeChildWorkflow(
    step: WorkflowCallStep,
    runtime: RuntimeStepResolution,
    syncParentState: boolean,
    preparedExecution: PreparedWorkflowCallExecution,
  ): Promise<{
    childResult: WorkflowCallExecutionResult;
    providerInfo: NonNullable<StepRunResult['providerInfo']>;
  }> {
    const parentConfig = this.deps.getConfig();
    const childWorkflow = preparedExecution.childWorkflow;

    const runtimeProviderInfo = runtime.providerInfo ?? this.resolveRuntime(step).providerInfo;
    if (!runtimeProviderInfo) {
      throw this.translateWorkflowCallConfigError(
        parentConfig,
        step,
        new Error(`workflow_call step "${step.name}" could not resolve provider context`),
        step.overrides === undefined ? ['call'] : ['overrides'],
      );
    }
    const childProviderInfo = runtime.fallback
      ? runtimeProviderInfo
      : this.resolveChildProviderModel(step, childWorkflow);
    const parentProviderContext = this.resolveParentWorkflowProviderContext();
    const childResult = await this.executor.execute({
      step,
      preparedExecution,
      childProviderInfo,
      parentProviderOptions: parentProviderContext.providerOptions,
      personaProviders: this.buildChildPersonaProviders(step),
      providerRouting: this.buildChildProviderRouting(step),
    }, {
      syncParentState,
    });

    return {
      childResult,
      providerInfo: runtimeProviderInfo,
    };
  }

  async run(
    step: WorkflowCallStep,
    token: WorkflowCallExecutionToken,
    runtime?: RuntimeStepResolution,
  ): Promise<StepRunResult> {
    const attempt = this.consumePreparedExecution(step, this.deps.resumeStackPrefix, token);
    return this.executeAttempt(attempt, async () => {
      const resolvedRuntime = runtime ?? this.resolveRuntime(step);
      const { childResult, providerInfo } = await this.executeChildWorkflow(
        step,
        resolvedRuntime,
        true,
        attempt.preparedExecution,
      );
      const response = this.buildWorkflowCallResponse(
        step,
        childResult,
        childResult.abortKind,
        childResult.abortReason,
        childResult.returnValue,
      );
      this.deps.state.stepOutputs.set(step.name, response);
      this.deps.state.lastOutput = response;
      this.deps.state.previousResponseSourcePath = undefined;
      return {
        childResult,
        value: {
          response,
          instruction: '',
          providerInfo,
          ...(childResult.abortFailure === undefined
            ? {}
            : { workflowCallFailure: childResult.abortFailure }),
        },
      };
    });
  }

  async runIsolated(
    step: WorkflowCallStep,
    runtime: RuntimeStepResolution,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
    token: WorkflowCallExecutionToken,
  ): Promise<{
    result: StepRunResult;
    sessionUpdates: WorkflowCallSessionUpdates;
    stateSync: WorkflowCallIsolatedStateSync;
  }> {
    const attempt = this.consumePreparedExecution(step, resumeStackPrefix, token);
    return this.executeAttempt(attempt, async () => {
      const { childResult, providerInfo } = await this.executeChildWorkflow(
        step,
        runtime,
        false,
        attempt.preparedExecution,
      );
      const response = this.buildWorkflowCallResponse(
        step,
        childResult,
        childResult.abortKind,
        childResult.abortReason,
        childResult.returnValue,
      );
      return {
        childResult,
        value: {
          result: {
            response,
            instruction: '',
            providerInfo,
            ...(childResult.abortFailure === undefined
              ? {}
              : { workflowCallFailure: childResult.abortFailure }),
          },
          sessionUpdates: this.requireIsolatedSessionUpdates(step, childResult),
          stateSync: this.requireIsolatedStateSync(step, childResult),
        },
      };
    });
  }
}
