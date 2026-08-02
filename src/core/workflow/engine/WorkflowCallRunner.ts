import { resolveEffectiveProviderOptions } from '../../../infra/config/providerOptions.js';
import type {
  AgentResponse,
  FindingContractConfig,
  WorkflowConfig,
  WorkflowCallStep,
  WorkflowCallInvocationRecord,
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
  normalizeWorkflowResumePointEntry,
  workflowEntryMatchesWorkflow,
} from '../workflow-reference.js';
import { buildWorkflowCallNamespaceSegment } from '../workflow-call-namespace.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../workflow-call-depth.js';
import { withWorkflowConfigErrorPath } from '../workflow-config-error.js';
import { findWorkflowStepLocation } from '../workflow-step-location.js';
import type {
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
  preserveWorkflowCallChildExecutionState,
  applyWorkflowCallOverridesToProviderRouting,
  applyWorkflowCallOverridesToPersonaProviders,
  type WorkflowCallExecutionResult,
  type WorkflowCallIsolatedStateSync,
  type WorkflowCallSessionUpdates,
} from './WorkflowCallExecutor.js';
import { terminalLabelOf } from '../../models/workflow-rule-condition.js';
import { RuleDetectionExhaustedError } from '../evaluation/RuleDetectionExhaustedError.js';
import { translateWorkflowConfigError } from '../../../shared/workflowConfigMetadata.js';
import { incrementStepIteration } from './state-manager.js';
import { getErrorMessage } from '../../../shared/utils/error.js';
import { workflowCallPathFromStack, workflowOwnerPathFromStack } from '../workflow-execution-scope.js';
import {
  buildWorkflowCallInvocationIdentity,
} from '../workflow-call-invocation-index.js';

interface WorkflowCallAttempt {
  readonly invocation: WorkflowCallInvocationRecord;
  readonly persistedInvocation: boolean;
  readonly upgradePersistedChildReference: boolean;
  readonly callStack: WorkflowResumePointEntry[];
  readonly lifecycle: WorkflowCallLifecycle;
  readonly context: WorkflowCallAttemptContext;
}

export interface WorkflowCallAttemptContext {
  readonly resumeStackPrefix: readonly WorkflowResumePointEntry[];
  readonly ownerPath: readonly WorkflowResumePointEntry[];
  readonly workflowCallPath: readonly WorkflowResumePointEntry[];
}

interface WorkflowCallAttemptValue<T> {
  readonly childResult: WorkflowCallExecutionResult;
  readonly value: T;
}

type WorkflowCallAttemptOutcome<T> =
  | { readonly lifecycle: WorkflowCallCompleteLifecycle; readonly value: T }
  | { readonly lifecycle: WorkflowCallCompleteLifecycle; readonly error: unknown };

interface WorkflowCallRunnerDeps {
  getConfig: () => WorkflowConfig;
  state: WorkflowState;
  projectCwd: string;
  getCwd: () => string;
  task: string;
  getOptions: () => WorkflowEngineOptions;
  sharedRuntime: WorkflowSharedRuntimeState;
  progressLease: import('../workflow-call-progress-tracker.js').WorkflowCallProgressLease;
  resumeStackPrefix: WorkflowResumePointEntry[];
  runPaths: RunPaths;
  setActiveResumePoint: (step: WorkflowCallStep, iteration: number) => void;
  setActiveResumeStack: (
    stack: readonly WorkflowResumePointEntry[],
    iteration: number,
  ) => void;
  adoptResumeCheckpoint: (
    resumePoint: import('../../models/types.js').WorkflowResumePoint,
    iteration: number,
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

export class WorkflowCallRunner {
  private readonly executor: WorkflowCallExecutor;
  private readonly consumedResumeAttempts = new Set<string>();

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

  private defaultAttemptContext(): WorkflowCallAttemptContext {
    return {
      resumeStackPrefix: this.deps.resumeStackPrefix,
      ownerPath: workflowOwnerPathFromStack(this.deps.resumeStackPrefix),
      workflowCallPath: workflowCallPathFromStack(this.deps.resumeStackPrefix),
    };
  }

  private attemptKey(
    step: WorkflowCallStep,
    context: WorkflowCallAttemptContext,
  ): string {
    return JSON.stringify({
      workflow: getWorkflowReference(this.deps.getConfig()),
      step: step.name,
      path: context.resumeStackPrefix.map((entry) => ({
        workflow: getResumePointWorkflowReference(entry),
        step: entry.step,
        callInstance: entry.call_instance,
      })),
    });
  }

  private resolveAttemptInstance(
    step: WorkflowCallStep,
    context: WorkflowCallAttemptContext,
  ): number {
    const key = this.attemptKey(step, context);
    const resumeEntry = this.deps.getOptions().resumePoint
      ?.stack[context.resumeStackPrefix.length];
    if (
      !this.consumedResumeAttempts.has(key)
      && resumeEntry !== undefined
      && resumeEntry.step === step.name
      && resumeEntry.kind === 'workflow_call'
      && workflowEntryMatchesWorkflow(resumeEntry, this.deps.getConfig())
    ) {
      const callInstance = normalizeWorkflowResumePointEntry(resumeEntry).call_instance;
      if (callInstance === undefined) {
        throw new Error(`workflow_call resume entry "${step.name}" requires a positive call_instance`);
      }
      this.consumedResumeAttempts.add(key);
      return callInstance;
    }
    return incrementStepIteration(this.deps.state, step.name);
  }

  private recordInvocation(
    step: WorkflowCallStep,
    callInstance: number,
    childWorkflowName: string,
    ownerPath: readonly WorkflowResumePointEntry[],
  ): WorkflowCallInvocationRecord {
    const index = this.deps.sharedRuntime.workflowCallInvocationEvidence!.index;
    const existing = index.get(this.deps.getConfig(), step.name, ownerPath);
    if (
      existing?.call_instance === callInstance
      && existing.child_workflow_ref === childWorkflowName
    ) {
      return existing;
    }
    const invocation = {
      call_instance: callInstance,
      child_workflow_ref: childWorkflowName,
    };
    index.record(this.deps.getConfig(), step.name, ownerPath, invocation);
    return invocation;
  }

  private startAttempt(
    step: WorkflowCallStep,
    context: WorkflowCallAttemptContext,
  ): WorkflowCallAttempt {
    const attemptIdentity = buildWorkflowCallInvocationIdentity(
      getWorkflowReference(this.deps.getConfig()),
      step.name,
      context.ownerPath,
    );
    this.deps.progressLease.enter(
      attemptIdentity,
      step.name,
    );
    const callInstance = this.resolveAttemptInstance(step, context);
    if ((this.deps.state.stepIterations.get(step.name) ?? 0) < callInstance) {
      this.deps.state.stepIterations.set(step.name, callInstance);
    }
    const existingInvocation = this.deps.sharedRuntime.workflowCallInvocationEvidence!.index.get(
      this.deps.getConfig(),
      step.name,
      context.ownerPath,
    );
    const persistedInvocation = existingInvocation?.call_instance === callInstance;
    const upgradePersistedChildReference = persistedInvocation
      && existingInvocation.child_workflow_ref === step.call;
    const invocation = persistedInvocation
      ? existingInvocation
      : this.recordInvocation(
          step,
          callInstance,
          step.call,
          context.ownerPath,
        );
    const callStack = [
      ...context.resumeStackPrefix,
      buildWorkflowResumePointEntry(
        this.deps.getConfig(),
        step.name,
        'workflow_call',
        this.deps.state.stepIterations,
        callInstance,
      ),
    ];
    this.deps.setActiveResumeStack(callStack, this.deps.state.iteration);
    const lifecycle: WorkflowCallLifecycle = {
      parentWorkflow: this.deps.getConfig().name,
      step: step.name,
      childWorkflow: step.call,
      callInstance,
      stack: callStack.map((entry) => ({
        ...entry,
        ...(entry.step_iterations === undefined
          ? {}
          : { step_iterations: { ...entry.step_iterations } }),
      })),
    };
    this.deps.emit('workflow_call:start', lifecycle);
    return {
      invocation,
      persistedInvocation,
      upgradePersistedChildReference,
      callStack,
      lifecycle,
      context,
    };
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
    attempt: WorkflowCallAttempt,
    error: unknown,
  ): WorkflowCallCompleteLifecycle {
    return {
      ...attempt.lifecycle,
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
        lifecycle: this.buildFailedLifecycle(attempt, error),
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

  private async executeChildWorkflow(
    step: WorkflowCallStep,
    syncParentState: boolean,
    attempt: WorkflowCallAttempt,
  ): Promise<WorkflowCallExecutionResult> {
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
      ...attempt.context.workflowCallPath.map((entry) => getResumePointWorkflowReference(entry)),
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

    const currentDepth = attempt.context.workflowCallPath.length + 1;
    const nextDepth = currentDepth + 1;
    if (nextDepth > MAX_WORKFLOW_CALL_DEPTH) {
      throw this.translateWorkflowCallConfigError(
        parentConfig,
        step,
        new Error(`workflow_call depth exceeds limit (${MAX_WORKFLOW_CALL_DEPTH}): ${childWorkflow.name}`),
        ['call'],
      );
    }

    const childProviderInfo = this.resolveChildProviderModel(step, childWorkflow);
    const parentProviderContext = this.resolveParentWorkflowProviderContext();
    const invocationIdentity = buildWorkflowCallInvocationIdentity(
      getWorkflowReference(parentConfig),
      step.name,
      attempt.context.ownerPath,
    );
    const persistedNamespaceMatches = attempt.persistedInvocation
      && attempt.invocation.child_workflow_ref === childWorkflowRef;
    if (
      attempt.persistedInvocation
      && !persistedNamespaceMatches
      && !attempt.upgradePersistedChildReference
    ) {
      throw new Error(`Persisted workflow-call namespace does not match resolved child "${childWorkflowRef}"`);
    }
    const invocation = persistedNamespaceMatches
      ? attempt.invocation
      : this.recordInvocation(
          step,
          attempt.invocation.call_instance,
          childWorkflowRef,
          attempt.context.ownerPath,
        );
    const childResult = await this.executor.execute({
      step,
      childWorkflow,
      reportNamespaceSegment: buildWorkflowCallNamespaceSegment(
        invocationIdentity,
        invocation.child_workflow_ref,
        invocation.call_instance,
      ),
      callStack: attempt.callStack,
      childProviderInfo,
      parentProviderOptions: parentProviderContext.providerOptions,
      personaProviders: this.buildChildPersonaProviders(step),
      providerRouting: this.buildChildProviderRouting(step),
    }, { syncParentState });

    return childResult;
  }

  async run(
    step: WorkflowCallStep,
  ): Promise<StepRunResult> {
    const attempt = this.startAttempt(step, this.defaultAttemptContext());
    return this.executeAttempt(attempt, async () => {
      const childResult = await this.executeChildWorkflow(step, true, attempt);
      let response: AgentResponse;
      try {
        response = this.buildWorkflowCallResponse(
          step,
          childResult,
          childResult.abortKind,
          childResult.abortReason,
          childResult.returnValue,
        );
      } catch (error) {
        this.deps.adoptResumeCheckpoint(childResult.resumePoint, childResult.iteration);
        throw error;
      }
      this.deps.state.stepOutputs.set(step.name, response);
      this.deps.state.lastOutput = response;
      this.deps.state.previousResponseSourcePath = undefined;
      return {
        childResult,
        value: { response, instruction: '' },
      };
    });
  }

  async runIsolated(
    step: WorkflowCallStep,
    context: WorkflowCallAttemptContext = this.defaultAttemptContext(),
  ): Promise<{
    result: StepRunResult;
    sessionUpdates: WorkflowCallSessionUpdates;
    stateSync: WorkflowCallIsolatedStateSync;
  }> {
    const attempt = this.startAttempt(step, context);
    return this.executeAttempt(attempt, async () => {
      const childResult = await this.executeChildWorkflow(step, false, attempt);
      let response: AgentResponse;
      try {
        response = this.buildWorkflowCallResponse(
          step,
          childResult,
          childResult.abortKind,
          childResult.abortReason,
          childResult.returnValue,
        );
      } catch (error) {
        const stateSync = this.requireIsolatedStateSync(step, childResult);
        throw preserveWorkflowCallChildExecutionState(
          error,
          this.requireIsolatedSessionUpdates(step, childResult),
          { ...stateSync, interrupted: true },
        );
      }
      return {
        childResult,
        value: {
          result: { response, instruction: '' },
          sessionUpdates: this.requireIsolatedSessionUpdates(step, childResult),
          stateSync: this.requireIsolatedStateSync(step, childResult),
        },
      };
    });
  }
}
