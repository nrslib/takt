import { mergeProviderOptions } from '../../../infra/config/providerOptions.js';
import { createWorkRequirementEstimator } from '../../../agents/auto-routing-usecase.js';
import type {
  FindingContractConfig,
  WorkflowConfig,
  WorkflowCallStep,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
  WorkflowState,
} from '../../models/types.js';
import type {
  PersonaProviderEntry,
  ProviderRoutingConfig,
  ProviderRoutingEntry,
} from '../../models/config-types.js';
import type { FindingLedgerStore } from '../findings/store.js';
import type { RunPaths } from '../run/run-paths.js';
import { trimResumePointStackForWorkflow } from '../run/resume-point.js';
import { resolveEffectiveAutoRouting } from '../auto-routing/effective-auto-routing.js';
import type { WorkRequirementEstimator } from '../auto-routing/contracts.js';
import { RoutingRuntime } from '../auto-routing/runtime.js';
import {
  workflowEntryMatchesWorkflow,
} from '../workflow-reference.js';
import type {
  StepProviderInfo,
  AutoRoutingEstimatorSource,
  WorkflowAbortKind,
  WorkflowCallChildEngine,
  WorkflowCallResolver,
  WorkflowEngineOptions,
  WorkflowSharedRuntimeState,
} from '../types.js';
import { validateFindingContractManagerProviderModel } from './WorkflowValidator.js';
import { getProviderValidationErrorSource } from '../provider-validation-error.js';
import { withWorkflowConfigErrorPath } from '../workflow-config-error.js';
import { findWorkflowStepLocation } from '../workflow-step-location.js';
import { translateWorkflowConfigError } from '../../../shared/workflowConfigMetadata.js';
import { restoreWorkflowCallInvocationEvidence } from '../workflow-call-invocation-index.js';
import { isWorkflowExecutionScope } from '../workflow-execution-scope.js';
import { cloneWorkflowResumePoint } from '../resume-point-codec.js';

export interface WorkflowCallSessionUpdate {
  expectedSessionId: string | undefined;
  sessionId: string | undefined;
}

export type WorkflowCallSessionUpdates = ReadonlyMap<string, WorkflowCallSessionUpdate>;
export interface WorkflowCallIsolatedStateSync {
  iteration: number;
  resumePoint: WorkflowResumePoint;
  interrupted: boolean;
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

function workflowCallOverrideErrorPath(
  step: WorkflowCallStep,
  error: unknown,
): readonly PropertyKey[] | undefined {
  if (!step.overrides) {
    return undefined;
  }
  const validationSource = getProviderValidationErrorSource(error);
  if (validationSource?.source !== 'workflow_call') {
    return undefined;
  }
  if (validationSource.field === 'model' && step.overrides.model !== undefined) {
    return ['overrides', 'model'];
  }
  if (validationSource.field === 'provider' && step.overrides.provider !== undefined) {
    return ['overrides', 'provider'];
  }
  return undefined;
}

function applyWorkflowCallOverridesToProviderEntries<T extends PersonaProviderEntry>(
  entries: Record<string, T> | undefined,
  overrides: WorkflowCallStep['overrides'],
): Record<string, T> | undefined {
  if (!entries) {
    return undefined;
  }
  if (overrides?.provider === undefined && overrides?.model === undefined) {
    return entries;
  }

  const overrideProvider = overrides.provider;
  return Object.fromEntries(
    Object.entries(entries).map(([key, entry]) => {
      const nextEntry: T = {
        ...(overrideProvider !== undefined
          ? { provider: overrideProvider }
          : entry.provider !== undefined
            ? { provider: entry.provider }
            : {}),
      } as T;

      if (overrides.model !== undefined) {
        nextEntry.model = overrides.model;
      } else if (overrideProvider === undefined && entry.model !== undefined) {
        nextEntry.model = entry.model;
      }
      if (entry.providerOptions !== undefined) {
        nextEntry.providerOptions = entry.providerOptions;
      }

      return [key, nextEntry];
    }),
  );
}

export function applyWorkflowCallOverridesToPersonaProviders(
  personaProviders: Record<string, PersonaProviderEntry> | undefined,
  overrides: WorkflowCallStep['overrides'],
): Record<string, PersonaProviderEntry> | undefined {
  return applyWorkflowCallOverridesToProviderEntries(personaProviders, overrides);
}

export function applyWorkflowCallOverridesToProviderRouting(
  providerRouting: ProviderRoutingConfig | undefined,
  overrides: WorkflowCallStep['overrides'],
): ProviderRoutingConfig | undefined {
  if (!providerRouting) {
    return undefined;
  }
  if (overrides?.provider === undefined && overrides?.model === undefined) {
    return providerRouting;
  }

  return {
    personas: applyWorkflowCallOverridesToProviderEntries<ProviderRoutingEntry>(providerRouting.personas, overrides),
    tags: applyWorkflowCallOverridesToProviderEntries<ProviderRoutingEntry>(providerRouting.tags, overrides),
    steps: applyWorkflowCallOverridesToProviderEntries<ProviderRoutingEntry>(providerRouting.steps, overrides),
  };
}

interface WorkflowCallExecutorDeps {
  getConfig: () => WorkflowConfig;
  getOptions: () => WorkflowEngineOptions;
  getCwd: () => string;
  projectCwd: string;
  task: string;
  sharedRuntime: WorkflowSharedRuntimeState;
  resumeStackPrefix: WorkflowResumePointEntry[];
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
  setActiveResumePoint: (step: WorkflowCallStep, iteration: number) => void;
  setActiveResumeStack: (
    stack: readonly WorkflowResumePointEntry[],
    iteration: number,
  ) => void;
  adoptResumeCheckpoint: (resumePoint: WorkflowResumePoint, iteration: number) => void;
  /** 自前 or 継承済みの、この engine で有効な Finding Contract。子へ引き継ぐ。 */
  findingContract?: FindingContractConfig;
  findingLedgerStore?: FindingLedgerStore;
  /** workflow_call 完了後、子が書き込んだ台帳を親の state.findings へ反映する。 */
  refreshFindingsState: () => void;
}

interface ExecuteWorkflowCallRequest {
  step: WorkflowCallStep;
  childWorkflow: WorkflowConfig;
  reportNamespaceSegment: string;
  callStack: WorkflowResumePointEntry[];
  childProviderInfo: StepProviderInfo;
  parentProviderOptions: WorkflowEngineOptions['providerOptions'];
  personaProviders: WorkflowEngineOptions['personaProviders'];
  providerRouting: WorkflowEngineOptions['providerRouting'];
}

interface ExecuteWorkflowCallOptions {
  syncParentState: boolean;
}

export type WorkflowCallExecutionResult = WorkflowState & {
  abortKind?: WorkflowAbortKind;
  abortReason?: string;
  returnValue?: string;
  sessionUpdates?: WorkflowCallSessionUpdates;
  isolatedStateSync?: WorkflowCallIsolatedStateSync;
  resumePoint: WorkflowResumePoint;
};

export class WorkflowCallExecutor {
  private readonly childRoutingRuntimes = new Map<string, ChildRoutingRuntime>();

  constructor(private readonly deps: WorkflowCallExecutorDeps) {
    deps.sharedRuntime.workflowCallInvocationEvidence ??=
      restoreWorkflowCallInvocationEvidence(deps.getOptions().resumePoint);
  }

  private getChildRoutingRuntime(
    childWorkflow: WorkflowConfig,
    childAutoRouting: NonNullable<ReturnType<typeof resolveEffectiveAutoRouting>>,
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
        language: options.language,
        childProcessEnv: options.childProcessEnv,
        abortSignal: options.abortSignal,
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

  private buildFindingCallNamespace(
    reportNamespaceSegment: string,
  ): string {
    const parentNamespace = this.deps.getOptions().findingCallNamespace;
    return parentNamespace
      ? `${parentNamespace}/${reportNamespaceSegment}`
      : reportNamespaceSegment;
  }

  private buildWorkflowCallNamespace(reportNamespaceSegment: string): string[] {
    const baseNamespace = this.deps.getOptions().runPathNamespace ?? [];
    return [
      ...baseNamespace,
      'subworkflows',
      reportNamespaceSegment,
    ];
  }

  private resolveChildResumeStartStep(
    childWorkflow: WorkflowConfig,
    resumePoint: WorkflowEngineOptions['resumePoint'],
    callStackDepth: number,
  ): string | undefined {
    if (!resumePoint) {
      return undefined;
    }

    const nextEntry = resumePoint.stack[callStackDepth];
    if (!nextEntry || !workflowEntryMatchesWorkflow(nextEntry, childWorkflow)) {
      return undefined;
    }

    const targetStep = childWorkflow.steps.find((step) => step.name === nextEntry.step);
    return targetStep?.name;
  }

  private resolveChildResumePoint(
    childWorkflow: WorkflowConfig,
    callStack: readonly WorkflowResumePointEntry[],
  ): WorkflowEngineOptions['resumePoint'] {
    const options = this.deps.getOptions();
    return trimResumePointStackForWorkflow({
      workflow: childWorkflow,
      resumePoint: options.resumePoint,
      resumeStackPrefix: [...callStack],
      resolveWorkflowCall: (parentWorkflow, nestedStep) => this.deps.resolveWorkflowCall({
        parentWorkflow,
        step: nestedStep,
        projectCwd: this.deps.projectCwd,
        lookupCwd: this.deps.getCwd(),
      }),
    });
  }

  private relayChildEvents(
    childEngine: WorkflowCallChildEngine,
    resumeStepName: string,
    syncParentState: boolean,
  ): void {
    childEngine.on('step:start', (...args) => {
      const [step, iteration, instruction, providerInfo, workflowName, , stepIteration, maxSteps, scope] = args;
      if (typeof iteration !== 'number' || !isWorkflowExecutionScope(scope)) {
        throw new Error('Child step:start requires explicit iteration and execution scope');
      }
      if (syncParentState) {
        this.deps.setActiveResumeStack(scope.stack, iteration);
      }
      this.deps.emit(
        'step:start',
        step,
        iteration,
        instruction,
        providerInfo,
        workflowName,
        resumeStepName,
        stepIteration,
        maxSteps,
        scope,
      );
    });
    childEngine.on('step:complete', (...args) => {
      const [step, response, instruction, , scope] = args;
      this.deps.emit('step:complete', step, response, instruction, resumeStepName, scope);
    });
    for (const eventName of [
      'workflow_call:start',
      'workflow_call:complete',
      'routing:decision',
      'step:report',
      'findings:ledger',
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
    step: WorkflowCallStep,
    childState: WorkflowState,
    interrupted: boolean,
    childResumePoint: WorkflowResumePoint,
  ): void {
    if (childState.iteration < this.deps.state.iteration) {
      throw new Error(`workflow_call step "${step.name}" returned an earlier iteration`);
    }
    // direct 子は親の session 全体を initialSessions として継承する。したがって
    // 子の最終 map は、この workflow_call 後の親 session の正しい状態である。
    // 子実行中に onSessionUpdate が外部永続化を済ませているため、ここでは親 state
    // だけを置換し、同じ更新を callback へ重複通知しない。
    this.deps.state.personaSessions.clear();
    for (const [sessionKey, sessionId] of childState.personaSessions) {
      this.deps.state.personaSessions.set(sessionKey, sessionId);
    }
    if (interrupted) {
      this.deps.adoptResumeCheckpoint(childResumePoint, childState.iteration);
    } else {
      this.deps.setActiveResumePoint(step, childState.iteration);
    }
    // 子が Finding Contract の台帳（親と共有）へ書き込んでいても、iteration /
    // session の同期だけでは親の state.findings は古いまま。親の
    // when(findings.*) ルールが子の取り込み結果を見られるよう、ここで
    // ParallelRunner の manager 実行後と同じ再読込を行う。
    if (this.deps.findingLedgerStore !== undefined) {
      this.deps.refreshFindingsState();
    }
  }

  async execute(
    request: ExecuteWorkflowCallRequest,
    executeOptions: ExecuteWorkflowCallOptions,
  ): Promise<WorkflowCallExecutionResult> {
    const options = this.deps.getOptions();
    const inheritedOptions = { ...options };
    delete inheritedOptions.maxStepsOverride;
    const parentConfig = this.deps.getConfig();
    const resolvedChildResumePoint = this.resolveChildResumePoint(
      request.childWorkflow,
      request.callStack,
    );
    const childResumePoint = resolvedChildResumePoint === undefined
      ? undefined
      : cloneWorkflowResumePoint({
          ...resolvedChildResumePoint,
          iteration: this.deps.state.iteration,
        });
    const inheritedSessions = new Map(this.deps.state.personaSessions);
    const sessionUpdates = new Map<string, WorkflowCallSessionUpdate>();
    const childAutoRouting = resolveEffectiveAutoRouting(request.childWorkflow, options.autoRouting);
    const childRoutingRuntime = childAutoRouting === undefined
      ? undefined
      : this.getChildRoutingRuntime(request.childWorkflow, childAutoRouting, options, request.step);
    const inheritedEstimatorSource = options.autoRoutingEstimatorSource;
    let childEngine: WorkflowCallChildEngine;
    const onChildIterationLimit = options.onIterationLimit === undefined
      ? undefined
      : async (limitRequest: Parameters<NonNullable<WorkflowEngineOptions['onIterationLimit']>>[0]) => {
          if (executeOptions.syncParentState) {
            const childResumePoint = childEngine.getOwnedResumePoint();
            if (childResumePoint === undefined) {
              throw new Error(`workflow_call step "${request.step.name}" reached its limit without an owned resume checkpoint`);
            }
            this.deps.adoptResumeCheckpoint(childResumePoint, childResumePoint.iteration);
          }
          return options.onIterationLimit!(limitRequest);
        };
    const childOptions: WorkflowEngineOptions = {
      ...inheritedOptions,
      onIterationLimit: onChildIterationLimit,
      initialSessions: Object.fromEntries(this.deps.state.personaSessions),
      initialUserInputs: [...this.deps.state.userInputs],
      provider: request.childProviderInfo.provider,
      providerSource: request.childProviderInfo.providerSource,
      model: request.childProviderInfo.model,
      modelSource: request.childProviderInfo.modelSource,
      providerOptions: mergeProviderOptions(
        request.parentProviderOptions,
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
      startStep: this.resolveChildResumeStartStep(
        request.childWorkflow,
        childResumePoint,
        request.callStack.length,
      ),
      resumePoint: childResumePoint,
      initialIteration: this.deps.state.iteration,
      reportDirName: this.deps.runPaths.slug,
      runPathNamespace: this.buildWorkflowCallNamespace(request.reportNamespaceSegment),
      findingCallNamespace: this.buildFindingCallNamespace(request.reportNamespaceSegment),
      workflowCallVars: {
        ...options.workflowCallVars,
        ...request.step.vars,
      },
      sharedRuntime: this.deps.sharedRuntime,
      resumeStackPrefix: request.callStack.map((entry) => ({
        ...entry,
        ...(entry.step_iterations === undefined
          ? {}
          : { step_iterations: { ...entry.step_iterations } }),
      })),
      // 親の Finding Contract を子エンジンへ継承する。継承しないと子の
      // parallel レビューが出す raw findings が台帳に入らず、fix に届かないまま
      // reviewers ↔ fix が回り続ける（実測: 56周・9時間）。子が自前の
      // finding_contract も持つ場合は WorkflowValidator が設定エラーで落とす
      // ため、ここでは無条件に継承値を渡してよい。
      ...(this.deps.findingContract !== undefined && this.deps.findingLedgerStore !== undefined
        ? {
            inheritedFindingContract: {
              contract: this.deps.findingContract,
              ledgerStore: this.deps.findingLedgerStore,
            },
          }
        : {}),
    };
    // 子が継承する Finding Contract の manager provider/model を、子を実際に
    // 構築する前に検証する。子ワークフローの workflow provider/model は親と
    // 異なりうるため、WorkflowValidator の同じチェックを子の config + 継承
    // 契約入り options に対してもう一度行わないと、不正な組み合わせが素通り
    // したまま manager 起動時に初めて失敗する（WorkflowValidator.ts はここで
    // 検証済みの childOptions を再利用する）。
    try {
      validateFindingContractManagerProviderModel(request.childWorkflow, childOptions);
      childEngine = this.deps.createEngine(request.childWorkflow, this.deps.getCwd(), this.deps.task, childOptions);
    } catch (error) {
      const overridePath = workflowCallOverrideErrorPath(request.step, error);
      const parentStepPath = findWorkflowStepLocation(parentConfig, request.step);
      if (!overridePath || !parentStepPath) {
        throw error;
      }
      const located = withWorkflowConfigErrorPath(error, [...parentStepPath, ...overridePath]);
      throw translateWorkflowConfigError(parentConfig, located);
    }

    this.relayChildEvents(childEngine, request.step.name, executeOptions.syncParentState);
    let childResult: Awaited<ReturnType<WorkflowCallChildEngine['runWithResult']>>;
    try {
      childResult = await childEngine.runWithResult();
    } catch (error) {
      const interruptedResumePoint = childEngine.getOwnedResumePoint();
      if (interruptedResumePoint === undefined) {
        throw error;
      }
      if (executeOptions.syncParentState) {
        this.deps.adoptResumeCheckpoint(interruptedResumePoint, interruptedResumePoint.iteration);
        throw error;
      }
      throw preserveWorkflowCallChildExecutionState(
        error,
        sessionUpdates,
        {
          iteration: interruptedResumePoint.iteration,
          resumePoint: interruptedResumePoint,
          interrupted: true,
        },
      );
    }
    const childState = childResult.state;
    const ownedChildResumePoint = childEngine.getOwnedResumePoint();
    if (ownedChildResumePoint === undefined) {
      throw new Error(`workflow_call step "${request.step.name}" completed without an owned resume checkpoint`);
    }
    const interrupted = childResult.abort !== undefined;
    if (executeOptions.syncParentState) {
      this.syncStateFromChild(request.step, childState, interrupted, ownedChildResumePoint);
    }
    return {
      ...childState,
      resumePoint: ownedChildResumePoint,
      ...(childResult.returnValue !== undefined ? { returnValue: childResult.returnValue } : {}),
      ...(!executeOptions.syncParentState
        ? {
            sessionUpdates,
            isolatedStateSync: {
              iteration: childState.iteration,
              resumePoint: ownedChildResumePoint,
              interrupted,
            },
          }
        : {}),
      ...(childResult.abort
        ? {
            abortKind: childResult.abort.kind,
            abortReason: childResult.abort.reason,
          }
        : {}),
    };
  }
}
