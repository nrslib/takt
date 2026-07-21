import { mergeProviderOptions } from '../../../infra/config/providerOptions.js';
import type {
  FindingContractConfig,
  WorkflowConfig,
  WorkflowCallStep,
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
import { buildWorkflowResumePointEntry, workflowEntryMatchesWorkflow } from '../workflow-reference.js';
import { buildWorkflowCallNamespaceSegment } from '../workflow-call-namespace.js';
import type {
  StepProviderInfo,
  WorkflowAbortKind,
  WorkflowCallChildEngine,
  WorkflowCallResolver,
  WorkflowEngineOptions,
  WorkflowSharedRuntimeState,
} from '../types.js';
import { validateFindingContractManagerProviderModel } from './WorkflowValidator.js';

export interface WorkflowCallSessionUpdate {
  expectedSessionId: string | undefined;
  sessionId: string | undefined;
}

export type WorkflowCallSessionUpdates = ReadonlyMap<string, WorkflowCallSessionUpdate>;
export interface WorkflowCallIsolatedStateSync {
  iteration: number;
  maxSteps?: WorkflowMaxSteps;
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
  };
  setActiveResumePoint: (step: WorkflowCallStep, iteration: number) => void;
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
}

export type WorkflowCallExecutionResult = WorkflowState & {
  abortKind?: WorkflowAbortKind;
  abortReason?: string;
  returnValue?: string;
  sessionUpdates?: WorkflowCallSessionUpdates;
  isolatedStateSync?: WorkflowCallIsolatedStateSync;
};

export class WorkflowCallExecutor {
  constructor(private readonly deps: WorkflowCallExecutorDeps) {}

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
   * ケースを区別できない。子エンジンはループのたびに新規生成され
   * stepIterations が空から始まるため、子の最初のレビューは常に
   * stepIteration=1 になる。ステップ名・parentStepName・stepIteration・
   * subStepName が全て一致すれば、ローカルの raw finding id が同じ場合に
   * 正規化後の id も完全に一致し、後勝ちで前回の raw finding が台帳から
   * 消える。buildWorkflowCallNamespace() と同じ「親のこの呼び出し時点の
   * イテレーション」（this.deps.state.iteration）をステップ名に組み合わせ、
   * ループの各回を区別する。
   */
  private buildFindingCallNamespace(step: WorkflowCallStep): string {
    const parentNamespace = this.deps.getOptions().findingCallNamespace;
    const segment = `${step.name}#${this.deps.state.iteration}`;
    return parentNamespace ? `${parentNamespace}/${segment}` : segment;
  }

  private buildWorkflowCallNamespace(step: WorkflowCallStep, childWorkflow: WorkflowConfig): string[] {
    const baseNamespace = this.deps.getOptions().runPathNamespace ?? [];
    const callIteration = this.deps.state.iteration;
    if (!Number.isInteger(callIteration) || callIteration <= 0) {
      throw new Error(`workflow_call step "${step.name}" requires a positive parent iteration before creating child report namespace`);
    }

    return [
      ...baseNamespace,
      'subworkflows',
      buildWorkflowCallNamespaceSegment(step.name, childWorkflow.name, callIteration),
    ];
  }

  private resolveChildResumeStartStep(
    childWorkflow: WorkflowConfig,
    resumePoint: WorkflowEngineOptions['resumePoint'],
  ): string | undefined {
    if (!resumePoint) {
      return undefined;
    }

    const nextEntry = resumePoint.stack[this.deps.resumeStackPrefix.length + 1];
    if (!nextEntry || !workflowEntryMatchesWorkflow(nextEntry, childWorkflow)) {
      return undefined;
    }

    const targetStep = childWorkflow.steps.find((step) => step.name === nextEntry.step);
    return targetStep?.name;
  }

  private resolveChildResumePoint(
    step: WorkflowCallStep,
    childWorkflow: WorkflowConfig,
  ): WorkflowEngineOptions['resumePoint'] {
    const options = this.deps.getOptions();
    const parentConfig = this.deps.getConfig();
    return trimResumePointStackForWorkflow({
      workflow: childWorkflow,
      resumePoint: options.resumePoint,
      resumeStackPrefix: [
        ...this.deps.resumeStackPrefix,
        buildWorkflowResumePointEntry(parentConfig, step.name, 'workflow_call'),
      ],
      resolveWorkflowCall: (parentWorkflow, nestedStep) => this.deps.resolveWorkflowCall({
        parentWorkflow,
        step: nestedStep,
        projectCwd: this.deps.projectCwd,
        lookupCwd: this.deps.getCwd(),
      }),
    });
  }

  private relayChildEvents(childEngine: WorkflowCallChildEngine, resumeStepName: string): void {
    childEngine.on('step:start', (...args) => {
      const [step, iteration, instruction, providerInfo, workflowName] = args;
      this.deps.emit(
        'step:start',
        step,
        iteration,
        instruction,
        providerInfo,
        workflowName,
        resumeStepName,
      );
    });
    childEngine.on('step:complete', (...args) => {
      const [step, response, instruction] = args;
      this.deps.emit('step:complete', step, response, instruction, resumeStepName);
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

  private syncStateFromChild(step: WorkflowCallStep, childState: WorkflowState): void {
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
    this.deps.setActiveResumePoint(step, this.deps.state.iteration);
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
    const childResumePoint = this.resolveChildResumePoint(request.step, request.childWorkflow);
    const inheritedSessions = new Map(this.deps.state.personaSessions);
    const sessionUpdates = new Map<string, WorkflowCallSessionUpdate>();
    const childAutoRouting = resolveEffectiveAutoRouting(request.childWorkflow, options.autoRouting);
    const childOptions: WorkflowEngineOptions = {
      ...options,
      maxStepsOverride: this.deps.sharedRuntime.maxSteps ?? this.deps.getMaxSteps(),
      initialSessions: Object.fromEntries(this.deps.state.personaSessions),
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
      // Child workflows need router prompts scoped to the child workflow name and run namespace.
      autoRoutingAiRouter: undefined,
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
      startStep: this.resolveChildResumeStartStep(request.childWorkflow, childResumePoint),
      resumePoint: childResumePoint,
      initialIteration: this.deps.state.iteration,
      reportDirName: this.deps.runPaths.slug,
      runPathNamespace: this.buildWorkflowCallNamespace(request.step, request.childWorkflow),
      findingCallNamespace: this.buildFindingCallNamespace(request.step),
      sharedRuntime: this.deps.sharedRuntime,
      resumeStackPrefix: [
        ...this.deps.resumeStackPrefix,
        buildWorkflowResumePointEntry(parentConfig, request.step.name, 'workflow_call'),
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
    validateFindingContractManagerProviderModel(request.childWorkflow, childOptions);

    const childEngine = this.deps.createEngine(request.childWorkflow, this.deps.getCwd(), this.deps.task, childOptions);

    this.relayChildEvents(childEngine, request.step.name);
    const childResult = await childEngine.runWithResult();
    const childState = childResult.state;
    if (executeOptions.syncParentState) {
      this.syncStateFromChild(request.step, childState);
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
