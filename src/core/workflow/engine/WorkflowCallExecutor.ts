import { mergeProviderOptions } from '../../../infra/config/providerOptions.js';
import { createWorkRequirementEstimator } from '../../../agents/auto-routing-usecase.js';
import type {
  FindingContractConfig,
  WorkflowConfig,
  WorkflowCallStep,
  WorkflowCallInvocationRecord,
  WorkflowMaxSteps,
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
import { buildWorkflowResumePointEntry, workflowEntryMatchesWorkflow } from '../workflow-reference.js';
import { buildWorkflowCallSiteIdentity } from '../workflow-call-site-identity.js';
import { buildWorkflowStackStepIterationIdentity } from '../step-iteration-identity.js';
import {
  workflowCallNamespaceSegmentMatchesInvocation,
} from '../workflow-call-namespace.js';
import type {
  StepProviderInfo,
  AutoRoutingEstimatorSource,
  WorkflowAbortKind,
  WorkflowCallChildEngine,
  WorkflowCallResolver,
  WorkflowEngineOptions,
  WorkflowEvents,
  WorkflowSharedRuntimeState,
} from '../types.js';
import { validateFindingContractManagerProviderModel } from './WorkflowValidator.js';
import { getProviderValidationErrorSource } from '../provider-validation-error.js';
import { withWorkflowConfigErrorPath } from '../workflow-config-error.js';
import { findWorkflowStepLocation } from '../workflow-step-location.js';
import { translateWorkflowConfigError } from '../../../shared/workflowConfigMetadata.js';
import { restoreWorkflowCallInvocationEvidence } from '../workflow-call-invocation-index.js';

export interface WorkflowCallSessionUpdate {
  expectedSessionId: string | undefined;
  sessionId: string | undefined;
}

export type WorkflowCallSessionUpdates = ReadonlyMap<string, WorkflowCallSessionUpdate>;
export interface WorkflowCallIsolatedStateSync {
  iteration: number;
  maxSteps?: WorkflowMaxSteps;
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
  ) => void;
  /** 自前 or 継承済みの、この engine で有効な Finding Contract。子へ引き継ぐ。 */
  findingContract?: FindingContractConfig;
  findingLedgerStore?: FindingLedgerStore;
  /** workflow_call 完了後、子が書き込んだ台帳を親の state.findings へ反映する。 */
  refreshFindingsState: () => void;
}

interface ExecuteWorkflowCallRequest {
  step: WorkflowCallStep;
  childWorkflow: WorkflowConfig;
  childProviderInfo: StepProviderInfo;
  parentProviderOptions: WorkflowEngineOptions['providerOptions'];
  personaProviders: WorkflowEngineOptions['personaProviders'];
  providerRouting: WorkflowEngineOptions['providerRouting'];
}

interface ExecuteWorkflowCallOptions {
  syncParentState: boolean;
  resumeStackPrefix: readonly WorkflowResumePointEntry[];
}

export type WorkflowCallExecutionResult = WorkflowState & {
  abortKind?: WorkflowAbortKind;
  abortReason?: string;
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

  /**
   * raw finding id 用の呼び出し名前空間を組み立てる。子エンジンは
   * reportDirName（= runId）を親からそのまま継承するため、親の parallel から
   * 同じ子ワークフローを複数同時に呼ぶと2子の runId が一致し、findings
   * manager-runner.ts の normalizeRawFindingId が生成する raw finding id が
   * 完全に衝突する（実測: parentStepName / stepIteration / subStepName /
   * rawFindingId のいずれも子ワークフロー内では同一になるため）。
   * 呼び出し元ステップ名（parallel の子ステップ間で一意）を積み上げることで
   * 衝突を避ける。親が既に名前空間を持つ場合（さらに深い入れ子）は連結する。
   * トップレベルの走行では親の名前空間が undefined のため、この関数は常に
   * 呼ばれるが、その戻り値は options.findingCallNamespace としてのみ子へ渡り、
   * 親自身が undefined のままなら raw finding id の形は変わらない。
   *
   * ステップ名だけでは、同じ workflow_call ステップがループで再実行された
   * ケースを区別できない。resume continuation では stepIterations を復元するが、
   * 同一 run 内の新規 workflow_call は子エンジンを新規生成するため、子の最初の
   * レビューは stepIteration=1 になる。ステップ名・parentStepName・stepIteration・
   * subStepName が全て一致すれば、ローカルの raw finding id が同じ場合に
   * 正規化後の id も完全に一致し、後勝ちで前回の raw finding が台帳から
   * 消える。buildWorkflowCallNamespace() と同じ workflow_call step の
   * occurrence をステップ名に組み合わせ、ループの各回を区別する。resume
   * continuation では source frame の occurrence を再利用する。
   */
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

  private recordWorkflowCallInvocation(
    step: WorkflowCallStep,
    childWorkflow: WorkflowConfig,
    occurrence: number,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ): WorkflowCallInvocationRecord {
    const existing = this.deps.sharedRuntime.workflowCallInvocationEvidence!.index.get(
      this.deps.getConfig(),
      step.name,
      resumeStackPrefix,
    );
    if (existing?.call_instance === occurrence) {
      if (!workflowCallNamespaceSegmentMatchesInvocation(
        existing.report_namespace_segment,
        step.name,
        childWorkflow.name,
      )) {
        throw new Error(`workflow_call step "${step.name}" report namespace does not match the resolved child workflow`);
      }
      return existing;
    }
    const record = {
      call_instance: occurrence,
      report_namespace_segment: buildWorkflowCallSiteIdentity({
        stack: [
          ...resumeStackPrefix,
          buildWorkflowResumePointEntry(
            this.deps.getConfig(),
            step.name,
            'workflow_call',
            occurrence,
            this.deps.state.stepIterations,
            occurrence,
          ),
        ],
        childWorkflow,
      }).runPathSegment,
    };
    this.deps.sharedRuntime.workflowCallInvocationEvidence!.index.record(
      this.deps.getConfig(),
      step.name,
      resumeStackPrefix,
      record,
    );
    return record;
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
        findingScopeIdentity,
        findingIds,
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
        findingScopeIdentity,
        findingIds,
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
    occurrence: number,
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
    this.deps.setActiveResumePoint(step, this.deps.state.iteration, occurrence);
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
    const parentConfig = this.deps.getConfig();
    const stepIterationIdentity = buildWorkflowStackStepIterationIdentity(
      parentConfig,
      request.step.name,
      executeOptions.resumeStackPrefix,
    );
    const occurrence = this.deps.state.stepIterations.get(stepIterationIdentity);
    if (occurrence === undefined) {
      throw new Error(`workflow_call step "${request.step.name}" has no occurrence`);
    }
    const invocation = this.recordWorkflowCallInvocation(
      request.step,
      request.childWorkflow,
      occurrence,
      executeOptions.resumeStackPrefix,
    );
    this.deps.setActiveResumePoint(
      request.step,
      this.deps.state.iteration,
      occurrence,
    );
    const continuation = this.resolveChildContinuation(
      request.step,
      request.childWorkflow,
      occurrence,
      executeOptions.resumeStackPrefix,
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
        ...executeOptions.resumeStackPrefix,
        workflowCallFrame,
      ],
      childWorkflow: request.childWorkflow,
    });
    const inheritedSessions = new Map(this.deps.state.personaSessions);
    const sessionUpdates = new Map<string, WorkflowCallSessionUpdate>();
    const childAutoRouting = resolveEffectiveAutoRouting(request.childWorkflow, options.autoRouting);
    const childRoutingRuntime = childAutoRouting === undefined
      ? undefined
      : this.getChildRoutingRuntime(request.childWorkflow, childAutoRouting, options, request.step);
    const inheritedEstimatorSource = options.autoRoutingEstimatorSource;
    const childOptions: WorkflowEngineOptions = {
      ...options,
      maxStepsOverride: this.deps.sharedRuntime.maxSteps ?? this.deps.getMaxSteps(),
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
      personaProviders: request.personaProviders,
      providerRouting: request.providerRouting,
      startStep: this.resolveChildResumeStartStep(
        request.childWorkflow,
        childResumePoint,
        executeOptions.resumeStackPrefix,
      ),
      resumePoint: childResumePoint,
      initialIteration: this.deps.state.iteration,
      reportDirName: this.deps.runPaths.slug,
      runPathNamespace: this.buildWorkflowCallNamespace(invocation),
      findingCallNamespace: workflowCallSite.key,
      workflowCallSiteIdentity: workflowCallSite.key,
      sharedRuntime: this.deps.sharedRuntime,
      resumeStackPrefix: [
        ...executeOptions.resumeStackPrefix,
        workflowCallFrame,
      ],
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
              managerAuthority: request.step.findingContractAuthority ?? 'standard',
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
    let childEngine: WorkflowCallChildEngine;
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

    this.relayChildEvents(childEngine, request.step.name);
    const childResult = await childEngine.runWithResult();
    const childState = childResult.state;
    if (executeOptions.syncParentState) {
      this.syncStateFromChild(request.step, childState, occurrence);
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
          }
        : {}),
    };
  }
}
