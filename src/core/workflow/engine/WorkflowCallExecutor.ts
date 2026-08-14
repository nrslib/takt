import { join } from 'node:path';
import { mergeProviderOptions } from '../../../infra/config/providerOptions.js';
import { createWorkRequirementEstimator } from '../../../agents/auto-routing-usecase.js';
import type {
  WorkflowConfig,
  WorkflowCallStep,
  WorkflowCallInvocationRecord,
  WorkflowMaxSteps,
  WorkflowResumePointEntry,
  WorkflowState,
} from '../../models/types.js';
import type { RunPaths } from '../run/run-paths.js';
import { trimResumePointStackForWorkflow } from '../run/resume-point.js';
import {
  getWorkflowCallOverrideErrorPath,
  resolveWorkflowCallChildAutoRouting,
} from '../workflow-call-provider-context.js';
import type { WorkRequirementEstimator } from '../auto-routing/contracts.js';
import { RoutingRuntime } from '../auto-routing/runtime.js';
import { applyAutoRoutingStrategyOverride } from '../auto-routing/resolver.js';
import { withWorkflowTargetContext } from '../provider-target-resolution.js';
import {
  buildWorkflowResumePointEntry,
  getWorkflowReference,
  workflowEntryMatchesWorkflow,
} from '../workflow-reference.js';
import { buildWorkflowCallSiteIdentity } from '../workflow-call-site-identity.js';
import {
  buildWorkflowCallNamespaceSegment,
  parseWorkflowCallNamespaceSegment,
} from '../workflow-call-namespace.js';
import { buildWorkflowStackStepIterationIdentity } from '../step-iteration-identity.js';
import type {
  StepProviderInfo,
  AutoRoutingEstimatorSource,
  WorkflowAbortKind,
  WorkflowCallChildEngine,
  WorkflowCallResolver,
  WorkflowEngineOptions,
  WorkflowEvents,
  WorkflowSharedRuntimeState,
  WorkflowStepFailureSummary,
} from '../types.js';
import { withWorkflowConfigErrorPath } from '../workflow-config-error.js';
import { findWorkflowStepLocation } from '../workflow-step-location.js';
import { translateWorkflowConfigError } from '../../../shared/workflowConfigMetadata.js';
import { restoreWorkflowCallInvocationEvidence } from '../workflow-call-invocation-index.js';

const PENDING_WORKFLOW_CALL_SITE_DIGEST = '0'.repeat(64);

export interface WorkflowCallSessionUpdate {
  expectedSessionId: string | undefined;
  sessionId: string | undefined;
}

export type WorkflowCallSessionUpdates = ReadonlyMap<string, WorkflowCallSessionUpdate>;
export interface WorkflowCallIsolatedStateSync {
  iteration: number;
  maxSteps?: WorkflowMaxSteps;
}

class WorkflowCallChildExecutionError extends Error {
  constructor(
    readonly originalError: unknown,
    readonly sessionUpdates: WorkflowCallSessionUpdates,
    readonly stateSync: WorkflowCallIsolatedStateSync,
  ) {
    super(originalError instanceof Error ? originalError.message : String(originalError), { cause: originalError });
    this.name = 'WorkflowCallChildExecutionError';
  }
}

export interface WorkflowCallChildExecutionState {
  readonly originalError: unknown;
  readonly sessionUpdates: WorkflowCallSessionUpdates;
  readonly stateSync: WorkflowCallIsolatedStateSync;
}

const childExecutionStateByError = new WeakMap<object, WorkflowCallChildExecutionState>();

export function preserveWorkflowCallChildExecutionState(
  error: unknown,
  sessionUpdates: WorkflowCallSessionUpdates,
  stateSync: WorkflowCallIsolatedStateSync,
): unknown {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    childExecutionStateByError.set(error, { originalError: error, sessionUpdates, stateSync });
    return error;
  }
  return new WorkflowCallChildExecutionError(error, sessionUpdates, stateSync);
}

export function getWorkflowCallChildExecutionState(
  error: unknown,
): WorkflowCallChildExecutionState | undefined {
  if (error instanceof WorkflowCallChildExecutionError) {
    return error;
  }
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    return childExecutionStateByError.get(error);
  }
  return undefined;
}

interface ChildRoutingRuntime {
  estimator: WorkRequirementEstimator;
  runtime: RoutingRuntime;
  estimatorSource: Exclude<AutoRoutingEstimatorSource, 'absent'>;
}

interface WorkflowCallExecutorDeps {
  getConfig: () => WorkflowConfig;
  getOptions: () => WorkflowEngineOptions;
  getAbortSignal?: () => AbortSignal | undefined;
  getMaxSteps: () => WorkflowMaxSteps;
  updateMaxSteps: (maxSteps: WorkflowMaxSteps) => void;
  getCwd: () => string;
  projectCwd: string;
  task: string;
  sharedRuntime: WorkflowSharedRuntimeState;
  resumeStackPrefix: WorkflowResumePointEntry[];
  consumeWorkflowCallContinuation: (
    step: WorkflowCallStep,
    occurrence: number,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ) => WorkflowResumePointEntry | undefined;
  runPaths: RunPaths;
  resolveWorkflowCall: WorkflowCallResolver;
  createEngine: (
    config: WorkflowConfig,
    cwd: string,
    task: string,
    options: WorkflowEngineOptions,
  ) => WorkflowCallChildEngine;
  emit: (event: string, ...args: unknown[]) => void;
  state: {
    iteration: number;
    personaSessions: Map<string, string>;
    stepIterations: Map<string, number>;
    userInputs: string[];
  };
  setActiveResumePoint: (
    step: WorkflowCallStep,
    iteration: number,
    occurrence: number,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ) => void;
}

export interface PreparedWorkflowCallExecution {
  readonly parentWorkflowReference: string;
  readonly stepName: string;
  readonly childWorkflow: WorkflowConfig;
  readonly occurrence: number;
  readonly resumeStackPrefix: readonly WorkflowResumePointEntry[];
  readonly invocation: Readonly<WorkflowCallInvocationRecord>;
}

interface ExecuteWorkflowCallRequest {
  step: WorkflowCallStep;
  preparedExecution: PreparedWorkflowCallExecution;
  childProviderInfo: StepProviderInfo;
  parentProviderOptions: WorkflowEngineOptions['providerOptions'];
  personaProviders: WorkflowEngineOptions['personaProviders'];
  providerRouting: WorkflowEngineOptions['providerRouting'];
  providerLadders: WorkflowEngineOptions['providerLadders'];
  providerEscalation: WorkflowEngineOptions['providerEscalation'];
}

interface ExecuteWorkflowCallOptions {
  syncParentState: boolean;
}

export type WorkflowCallExecutionResult = WorkflowState & {
  abortKind?: WorkflowAbortKind;
  abortReason?: string;
  abortFailure?: WorkflowStepFailureSummary;
  returnValue?: string;
  sessionUpdates?: WorkflowCallSessionUpdates;
  isolatedStateSync?: WorkflowCallIsolatedStateSync;
};

export class WorkflowCallExecutor {
  private readonly childRoutingRuntimes = new Map<string, ChildRoutingRuntime>();

  constructor(private readonly deps: WorkflowCallExecutorDeps) {
    deps.sharedRuntime.workflowCallInvocationEvidence ??=
      restoreWorkflowCallInvocationEvidence(deps.getOptions().resumePoint);
  }

  private getChildRoutingRuntime(
    childWorkflow: WorkflowConfig,
    childAutoRouting: NonNullable<ReturnType<typeof resolveWorkflowCallChildAutoRouting>>,
    options: WorkflowEngineOptions,
    workflowCallStep: WorkflowCallStep,
  ): ChildRoutingRuntime {
    const cacheKey = JSON.stringify({
      parentWorkflow: this.deps.getConfig().name,
      workflowCallStep: workflowCallStep.name,
      parentNamespace: options.runPathNamespace ?? [],
      childWorkflow: childWorkflow.name,
      autoRouting: childAutoRouting,
    });
    const existing = this.childRoutingRuntimes.get(cacheKey);
    if (existing !== undefined) {
      return existing;
    }
    const configuredEstimatorSource = options.autoRoutingEstimatorSource;
    const estimatorSource = configuredEstimatorSource
      ?? (options.autoRoutingEstimator === undefined ? 'engine-default' : 'injected');
    const inheritsParentAutoRouting = childWorkflow.autoRouting === undefined;
    const estimator = estimatorSource === 'injected' || inheritsParentAutoRouting
      ? options.autoRoutingEstimator
      : createWorkRequirementEstimator({
        cwd: this.deps.getCwd(),
        provider: childAutoRouting.router.provider,
        model: childAutoRouting.router.model,
        providerOptions: childAutoRouting.router.providerOptions,
        permissionMode: childAutoRouting.router.permissionMode,
        language: options.language,
        childProcessEnv: options.childProcessEnv,
        // The estimator is cached across workflow-call steps; pass the
        // per-call signal to estimate() instead of capturing a step deadline.
        abortSignal: options.abortSignal,
        failureDir: join(this.deps.runPaths.runRootAbs, 'failures'),
      });
    if (estimator === undefined) {
      throw new Error(`workflow_call child "${childWorkflow.name}" inherited auto routing without an estimator`);
    }
    const runtime = new RoutingRuntime({ autoRouting: childAutoRouting, estimator });
    const created: ChildRoutingRuntime = {
      estimator,
      runtime,
      estimatorSource: estimatorSource === 'injected' ? 'injected' : 'engine-default',
    };
    this.childRoutingRuntimes.set(cacheKey, created);
    return created;
  }

  private buildWorkflowCallNamespace(record: WorkflowCallInvocationRecord): string[] {
    const baseNamespace = this.deps.getOptions().runPathNamespace ?? [];
    return [
      ...baseNamespace,
      'subworkflows',
      record.report_namespace_segment,
    ];
  }

  private buildCurrentWorkflowCallFrame(
    step: WorkflowCallStep,
    occurrence: number,
    callInstance: number,
  ): WorkflowResumePointEntry {
    return buildWorkflowResumePointEntry(
      this.deps.getConfig(),
      step.name,
      'workflow_call',
      occurrence,
      this.deps.state.stepIterations,
      callInstance,
    );
  }

  private resolveChildResumeStartStep(
    childWorkflow: WorkflowConfig,
    resumePoint: WorkflowEngineOptions['resumePoint'],
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ): string | undefined {
    if (!resumePoint) {
      return undefined;
    }

    const nextEntry = resumePoint.stack[resumeStackPrefix.length + 1];
    if (!nextEntry || !workflowEntryMatchesWorkflow(nextEntry, childWorkflow)) {
      return undefined;
    }

    const targetStep = childWorkflow.steps.find((step) => step.name === nextEntry.step);
    return targetStep?.name;
  }

  private resolveChildContinuation(
    step: WorkflowCallStep,
    childWorkflow: WorkflowConfig,
    occurrence: number,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ): {
    readonly resumePoint?: NonNullable<WorkflowEngineOptions['resumePoint']>;
    readonly frame: WorkflowResumePointEntry;
  } | undefined {
    const options = this.deps.getOptions();
    const frame = this.deps.consumeWorkflowCallContinuation(
      step,
      occurrence,
      resumeStackPrefix,
    );
    if (frame === undefined) {
      return undefined;
    }
    const resumePoint = trimResumePointStackForWorkflow({
      workflow: childWorkflow,
      resumePoint: options.resumePoint,
      resumeStackPrefix: [
        ...resumeStackPrefix,
        frame,
      ],
      resolveWorkflowCall: (parentWorkflow, nestedStep) => this.deps.resolveWorkflowCall({
        parentWorkflow,
        step: nestedStep,
        projectCwd: this.deps.projectCwd,
        lookupCwd: this.deps.getCwd(),
      }),
    });
    return {
      frame,
      ...(resumePoint !== undefined ? { resumePoint } : {}),
    };
  }

  recordPendingInvocation(
    step: WorkflowCallStep,
    occurrence: number,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ): void {
    const parentConfig = this.deps.getConfig();
    const index = this.deps.sharedRuntime.workflowCallInvocationEvidence!.index;
    const existing = index.get(parentConfig, step.name, resumeStackPrefix);
    if (existing?.call_instance === occurrence) {
      return;
    }
    index.record(parentConfig, step.name, resumeStackPrefix, {
      call_instance: occurrence,
      report_namespace_segment: `${buildWorkflowCallNamespaceSegment(
        step.name,
        step.call,
        occurrence,
      )}--site-${PENDING_WORKFLOW_CALL_SITE_DIGEST}`,
    });
  }

  prepare(
    step: WorkflowCallStep,
    childWorkflow: WorkflowConfig,
    occurrence: number,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ): PreparedWorkflowCallExecution {
    const parentConfig = this.deps.getConfig();
    const resumeStackSnapshot = Object.freeze(resumeStackPrefix.map((entry) => Object.freeze({
      ...entry,
      ...(entry.step_iterations === undefined
        ? {}
        : { step_iterations: Object.freeze({ ...entry.step_iterations }) }),
    })));
    const expectedInvocation = Object.freeze({
      call_instance: occurrence,
      report_namespace_segment: buildWorkflowCallSiteIdentity({
        stack: [
          ...resumeStackSnapshot,
          buildWorkflowResumePointEntry(
            parentConfig,
            step.name,
            'workflow_call',
            occurrence,
            this.deps.state.stepIterations,
            occurrence,
          ),
        ],
        childWorkflow,
      }).runPathSegment,
    });
    const existing = this.deps.sharedRuntime.workflowCallInvocationEvidence!.index.get(
      parentConfig,
      step.name,
      resumeStackSnapshot,
    );
    if (existing?.call_instance === occurrence) {
      if (existing.report_namespace_segment !== expectedInvocation.report_namespace_segment) {
        const existingNamespace = parseWorkflowCallNamespaceSegment(
          existing.report_namespace_segment,
        );
        if (
          existingNamespace?.siteDigest === PENDING_WORKFLOW_CALL_SITE_DIGEST
          && existingNamespace?.workflowName === step.call
        ) {
          this.deps.sharedRuntime.workflowCallInvocationEvidence!.index.replace(
            parentConfig,
            step.name,
            resumeStackSnapshot,
            expectedInvocation,
          );
        } else {
          throw new Error(`workflow_call step "${step.name}" invocation record does not match the canonical call site`);
        }
      }
    } else {
      this.deps.sharedRuntime.workflowCallInvocationEvidence!.index.record(
        parentConfig,
        step.name,
        resumeStackSnapshot,
        expectedInvocation,
      );
    }
    return Object.freeze({
      parentWorkflowReference: getWorkflowReference(parentConfig),
      stepName: step.name,
      childWorkflow,
      occurrence,
      resumeStackPrefix: resumeStackSnapshot,
      invocation: expectedInvocation,
    });
  }

  private relayChildEvents(childEngine: WorkflowCallChildEngine, resumeStepName: string): void {
    childEngine.on('step:start', (...args) => {
      const [
        step,
        iteration,
        instruction,
        providerInfo,
        workflowName,
        ,
        stepIteration,
        workflowStack,
      ] = args as Parameters<WorkflowEvents['step:start']>;
      this.deps.emit(
        'step:start',
        step,
        iteration,
        instruction,
        providerInfo,
        workflowName,
        resumeStepName,
        stepIteration,
        workflowStack,
      );
    });
    childEngine.on('step:complete', (...args) => {
      const [
        step,
        response,
        instruction,
        ,
        workflowStack,
      ] = args as Parameters<WorkflowEvents['step:complete']>;
      this.deps.emit(
        'step:complete',
        step,
        response,
        instruction,
        resumeStepName,
        workflowStack,
      );
    });
    for (const eventName of [
      'workflow:warning',
      'workflow_call:start',
      'workflow_call:complete',
      'routing:decision',
      'step:report',
      'companion:start',
      'companion:pool_selected',
      'companion:finding',
      'companion:fix_round',
      'companion:complete',
      'companion:review_round',
      'companion:queue_coalesced',
      'companion:call',
      'companion:review_skipped',
      'step:blocked',
      'step:rate_limited',
      'step:user_input',
      'phase:start',
      'phase:complete',
      'phase:judge_stage',
      'step:loop_detected',
      'step:cycle_detected',
      'iteration:limit',
    ] as const) {
      childEngine.on(eventName, (...args) => this.deps.emit(eventName, ...args));
    }
  }

  private syncStateFromChild(
    childState: WorkflowState,
  ): void {
    if (this.deps.sharedRuntime.maxSteps !== undefined) {
      this.deps.updateMaxSteps(this.deps.sharedRuntime.maxSteps);
    }
    this.deps.state.iteration = childState.iteration;
    // direct 子は親の session 全体を initialSessions として継承する。したがって
    // 子の最終 map は、この workflow_call 後の親 session の正しい状態である。
    // 子実行中に onSessionUpdate が外部永続化を済ませているため、ここでは親 state
    // だけを置換し、同じ更新を callback へ重複通知しない。
    this.deps.state.personaSessions.clear();
    for (const [sessionKey, sessionId] of childState.personaSessions) {
      this.deps.state.personaSessions.set(sessionKey, sessionId);
    }
  }

  async execute(
    request: ExecuteWorkflowCallRequest,
    executeOptions: ExecuteWorkflowCallOptions,
  ): Promise<WorkflowCallExecutionResult> {
    const options = this.deps.getOptions();
    const inheritedOptions = { ...options };
    delete inheritedOptions.maxStepsOverride;
    delete inheritedOptions.restartPoint;
    const parentConfig = this.deps.getConfig();
    const prepared = request.preparedExecution;
    if (
      prepared.parentWorkflowReference !== getWorkflowReference(parentConfig)
      || prepared.stepName !== request.step.name
    ) {
      throw new Error(`workflow_call step "${request.step.name}" prepared execution does not match the call site`);
    }
    const childWorkflow = prepared.childWorkflow;
    const occurrence = prepared.occurrence;
    const resumeStackPrefix = prepared.resumeStackPrefix;
    const stepIterationIdentity = buildWorkflowStackStepIterationIdentity(
      parentConfig,
      request.step.name,
      resumeStackPrefix,
    );
    const activeOccurrence = this.deps.state.stepIterations.get(stepIterationIdentity);
    if (activeOccurrence === undefined) {
      throw new Error(`workflow_call step "${request.step.name}" has no occurrence`);
    }
    if (activeOccurrence !== occurrence) {
      throw new Error(`workflow_call step "${request.step.name}" prepared occurrence does not match execution state`);
    }
    const invocation = prepared.invocation;
    const continuation = this.resolveChildContinuation(
      request.step,
      childWorkflow,
      occurrence,
      resumeStackPrefix,
    );
    const childResumePoint = continuation?.resumePoint;
    const workflowCallFrame = continuation?.frame
      ?? this.buildCurrentWorkflowCallFrame(
        request.step,
        occurrence,
        invocation.call_instance,
      );
    if (workflowCallFrame.occurrence !== occurrence) {
      throw new Error(
        `workflow_call step "${request.step.name}" continuation occurrence does not match active occurrence`,
      );
    }
    const workflowCallSite = buildWorkflowCallSiteIdentity({
      stack: [
        ...resumeStackPrefix,
        workflowCallFrame,
      ],
      childWorkflow,
    });
    const inheritedSessions = new Map(this.deps.state.personaSessions);
    const sessionUpdates = new Map<string, WorkflowCallSessionUpdate>();
    const childAutoRouting = resolveWorkflowCallChildAutoRouting(childWorkflow, options.autoRouting);
    const childRuntimeAutoRouting = childAutoRouting === undefined
      ? undefined
      : withWorkflowTargetContext(
        applyAutoRoutingStrategyOverride(childAutoRouting, options.autoStrategyOverride),
        childWorkflow.name,
      );
    const childRoutingRuntime = childRuntimeAutoRouting === undefined
      ? undefined
      : this.getChildRoutingRuntime(childWorkflow, childRuntimeAutoRouting, options, request.step);
    const inheritedEstimatorSource = options.autoRoutingEstimatorSource;
    const childOptions: WorkflowEngineOptions = {
      ...inheritedOptions,
      abortSignal: this.deps.getAbortSignal?.() ?? options.abortSignal,
      maxStepsOverride: this.deps.sharedRuntime.maxSteps ?? this.deps.getMaxSteps(),
      initialSessions: Object.fromEntries(this.deps.state.personaSessions),
      initialUserInputs: [...this.deps.state.userInputs],
      provider: request.childProviderInfo.provider,
      providerSource: request.childProviderInfo.providerSource,
      model: request.childProviderInfo.model,
      modelSource: request.childProviderInfo.modelSource,
      // Explicitly overwrite the inherited value, including with undefined. The
      // permission belongs to the profile that supplied childProviderInfo.provider.
      providerPermissionMode: request.childProviderInfo.permissionMode,
      providerOptions: request.parentProviderOptions,
      providerOptionsProviderSource: options.providerOptionsProviderSource === undefined
        ? undefined
        : request.childProviderInfo.providerSource,
      workflowCallProviderOptions: mergeProviderOptions(
        options.workflowCallProviderOptions,
        request.step.overrides?.providerOptions,
      ),
      autoRouting: childAutoRouting,
      autoStrategyOverride: options.autoStrategyOverride,
      autoRoutingEstimator: childRoutingRuntime?.estimator,
      routingRuntime: childRoutingRuntime?.runtime,
      autoRoutingEstimatorSource: childRoutingRuntime?.estimatorSource ?? inheritedEstimatorSource,
      onSessionUpdate: executeOptions.syncParentState
        ? options.onSessionUpdate
        : (persona, sessionId) => {
            const priorUpdate = sessionUpdates.get(persona);
            sessionUpdates.set(persona, {
              expectedSessionId: priorUpdate
                ? priorUpdate.expectedSessionId
                : inheritedSessions.get(persona),
              sessionId,
            });
          },
      personaProviders: request.personaProviders === undefined
        ? undefined
        : structuredClone(request.personaProviders),
      providerRouting: request.providerRouting === undefined
        ? undefined
        : structuredClone(request.providerRouting),
      providerLadders: request.providerLadders === undefined
        ? undefined
        : structuredClone(request.providerLadders),
      // provider/model と同じく子の解決結果をそのまま渡す。値は不変な解決済み
      // ターゲットなので clone しない（providerRouting は entry を書き換える
      // 経路があるため clone している）。
      providerEscalation: request.providerEscalation,
      startStep: this.deps.sharedRuntime.restartNavigator === undefined
        ? this.resolveChildResumeStartStep(
            childWorkflow,
            childResumePoint,
            resumeStackPrefix,
          )
        : this.deps.sharedRuntime.restartNavigator.resolveChildStartStep(
            childWorkflow,
            [...resumeStackPrefix, workflowCallFrame],
            (message) => this.deps.emit('workflow:warning', message),
          ),
      resumePoint: childResumePoint,
      initialIteration: this.deps.state.iteration,
      reportDirName: this.deps.runPaths.slug,
      runPathNamespace: this.buildWorkflowCallNamespace(invocation),
      workflowCallSiteIdentity: workflowCallSite.runPathSegment,
      workflowCallVars: {
        ...options.workflowCallVars,
        ...request.step.vars,
      },
      sharedRuntime: this.deps.sharedRuntime,
      resumeStackPrefix: [
        ...resumeStackPrefix,
        workflowCallFrame,
      ],
    };
    let childEngine: WorkflowCallChildEngine;
    try {
      childEngine = this.deps.createEngine(childWorkflow, this.deps.getCwd(), this.deps.task, childOptions);
    } catch (error) {
      const overridePath = getWorkflowCallOverrideErrorPath(request.step, error);
      const parentStepPath = findWorkflowStepLocation(parentConfig, request.step);
      if (!overridePath || !parentStepPath) {
        throw error;
      }
      const located = withWorkflowConfigErrorPath(error, [...parentStepPath, ...overridePath]);
      throw translateWorkflowConfigError(parentConfig, located);
    }

    this.relayChildEvents(childEngine, request.step.name);
    const childResult = await childEngine.runWithResult();
    const childState = childResult.state;
    if (executeOptions.syncParentState) {
      this.syncStateFromChild(childState);
      if (childState.status === 'completed') {
        this.deps.setActiveResumePoint(
          request.step,
          this.deps.state.iteration,
          occurrence,
          resumeStackPrefix,
        );
      }
    }
    return {
      ...childState,
      ...(childResult.returnValue !== undefined ? { returnValue: childResult.returnValue } : {}),
      ...(!executeOptions.syncParentState
        ? {
            sessionUpdates,
            isolatedStateSync: {
              iteration: childState.iteration,
              ...(this.deps.sharedRuntime.maxSteps !== undefined
                ? { maxSteps: this.deps.sharedRuntime.maxSteps }
                : {}),
            },
          }
        : {}),
      ...(childResult.abort
        ? {
            abortKind: childResult.abort.kind,
            abortReason: childResult.abort.reason,
            abortFailure: childResult.abort.failure,
          }
        : {}),
    };
  }
}
