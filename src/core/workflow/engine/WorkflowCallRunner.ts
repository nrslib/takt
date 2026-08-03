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

export class WorkflowCallRunner {
  private readonly executor: WorkflowCallExecutor;
  private readonly preparedExecutions = new WeakMap<WorkflowCallExecutionToken, PreparedWorkflowCallExecution>();
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
    const childWorkflow = this.resolveCallableChildWorkflow(step, resumeStackPrefix);
    const prepared = this.executor.prepare(
      step,
      childWorkflow,
      occurrence,
      resumeStackPrefix,
    );
    const token: WorkflowCallExecutionToken = Object.freeze({
      stepName: step.name,
      occurrence,
      resumeStackPrefix: prepared.resumeStackPrefix,
      cancel: () => {
        this.preparedExecutions.delete(token);
        if (this.pendingExecution?.token === token) {
          this.pendingExecution = undefined;
        }
      },
    });
    this.preparedExecutions.set(token, prepared);
    this.pendingExecution = { identity, occurrence, token };
    return token;
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
      return token;
    } catch (error) {
      token.cancel();
      throw error;
    }
  }

  private consumePreparedExecution(
    step: WorkflowCallStep,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
    token: WorkflowCallExecutionToken,
  ): PreparedWorkflowCallExecution {
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
    const prepared = this.preparedExecutions.get(token);
    if (prepared === undefined) {
      throw new Error(`workflow_call step "${step.name}" execution was not prepared`);
    }
    if (token.occurrence !== prepared.occurrence) {
      throw new Error(`workflow_call step "${step.name}" execution token occurrence does not match its preparation`);
    }
    this.preparedExecutions.delete(token);
    if (this.pendingExecution?.token === token) {
      this.pendingExecution = undefined;
    }
    return prepared;
  }

  private async executeChildWorkflow(
    step: WorkflowCallStep,
    runtime: RuntimeStepResolution,
    syncParentState: boolean,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
    token: WorkflowCallExecutionToken,
  ): Promise<{
    childResult: WorkflowCallExecutionResult;
    providerInfo: NonNullable<StepRunResult['providerInfo']>;
  }> {
    const parentConfig = this.deps.getConfig();
    const prepared = this.consumePreparedExecution(step, resumeStackPrefix, token);
    const childWorkflow = prepared.childWorkflow;
    const lifecycle: WorkflowCallLifecycle = {
      parentWorkflow: getWorkflowReference(parentConfig),
      step: step.name,
      childWorkflow: getWorkflowReference(childWorkflow),
      callInstance: prepared.occurrence,
      stack: [
        ...prepared.resumeStackPrefix,
        buildWorkflowResumePointEntry(
          parentConfig,
          step.name,
          'workflow_call',
          prepared.occurrence,
          this.deps.state.stepIterations,
          prepared.occurrence,
        ),
      ],
    };
    this.deps.emit('workflow_call:start', lifecycle);

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
    let childResult: WorkflowCallExecutionResult;
    try {
      childResult = await this.executor.execute({
        step,
        preparedExecution: prepared,
        childProviderInfo,
        parentProviderOptions: parentProviderContext.providerOptions,
        personaProviders: this.buildChildPersonaProviders(step),
        providerRouting: this.buildChildProviderRouting(step),
      }, {
        syncParentState,
      });
    } catch (error) {
      const complete: WorkflowCallCompleteLifecycle = {
        ...lifecycle,
        result: {
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        },
      };
      this.deps.emit('workflow_call:complete', complete);
      throw error;
    }

    const complete: WorkflowCallCompleteLifecycle = childResult.status === 'completed'
      ? {
          ...lifecycle,
          result: {
            status: 'completed',
            ...(childResult.returnValue === undefined ? {} : { returnValue: childResult.returnValue }),
          },
        }
      : {
          ...lifecycle,
          result: {
            status: 'aborted',
            ...(childResult.abortKind === undefined ? {} : { abortKind: childResult.abortKind }),
            ...(childResult.abortReason === undefined ? {} : { abortReason: childResult.abortReason }),
          },
        };
    this.deps.emit('workflow_call:complete', complete);

    return {
      childResult,
      providerInfo: runtimeProviderInfo,
    };
  }

  async run(
    step: WorkflowCallStep,
    token: WorkflowCallExecutionToken,
    runtime: RuntimeStepResolution = this.resolveRuntime(step),
  ): Promise<StepRunResult> {
    const { childResult, providerInfo } = await this.executeChildWorkflow(
      step,
      runtime,
      true,
      this.deps.resumeStackPrefix,
      token,
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
      response,
      instruction: '',
      providerInfo,
      ...(childResult.abortFailure === undefined
        ? {}
        : { workflowCallFailure: childResult.abortFailure }),
    };
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
    const { childResult, providerInfo } = await this.executeChildWorkflow(
      step,
      runtime,
      false,
      resumeStackPrefix,
      token,
    );
    const response = this.buildWorkflowCallResponse(
      step,
      childResult,
      childResult.abortKind,
      childResult.abortReason,
      childResult.returnValue,
    );
    return {
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
    };
  }
}
