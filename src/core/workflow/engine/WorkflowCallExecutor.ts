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
import { applyAutoRoutingStrategyOverride } from '../auto-routing/resolver.js';
import { workflowUsesAutoProvider } from '../auto-routing/workflow-auto-provider.js';
import { buildWorkflowResumePointEntry, workflowEntryMatchesWorkflow } from '../workflow-reference.js';
import type {
  WorkflowAbortKind,
  WorkflowCallChildEngine,
  WorkflowCallResolver,
  WorkflowEngineOptions,
  WorkflowSharedRuntimeState,
} from '../types.js';

export type WorkflowCallSessionUpdates = ReadonlyMap<string, string | undefined>;
export interface WorkflowCallIsolatedStateSync {
  iteration: number;
  maxSteps?: WorkflowMaxSteps;
}

function encodeWorkflowNamespaceValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildWorkflowCallNamespaceSegment(stepName: string, workflowName: string, iteration: number): string {
  return `iteration-${iteration}--step-${encodeWorkflowNamespaceValue(stepName)}--workflow-${encodeWorkflowNamespaceValue(workflowName)}`;
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

  const overrideProvider = overrides.provider === 'auto' ? undefined : overrides.provider;
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
  childProviderInfo: {
    provider: WorkflowEngineOptions['provider'];
    model: string | undefined;
  };
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

  private relayChildEvents(childEngine: WorkflowCallChildEngine): void {
    for (const eventName of [
      'step:start',
      'step:complete',
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
    for (const [sessionKey, sessionId] of childState.personaSessions.entries()) {
      this.deps.state.personaSessions.set(sessionKey, sessionId);
    }
    this.deps.setActiveResumePoint(step, this.deps.state.iteration);
    // 子が Finding Contract の台帳（親と共有）へ書き込んでいても、iteration /
    // session の同期だけでは親の state.findings は古いまま。親の
    // when(findings.*) ルールが子の取り込み結果を見られるよう、ここで
    // ParallelRunner の manager 実行後と同じ再読込を行う。
    this.deps.refreshFindingsState();
  }

  async execute(
    request: ExecuteWorkflowCallRequest,
    executeOptions: ExecuteWorkflowCallOptions,
  ): Promise<WorkflowCallExecutionResult> {
    const options = this.deps.getOptions();
    const parentConfig = this.deps.getConfig();
    const childResumePoint = this.resolveChildResumePoint(request.step, request.childWorkflow);
    const sessionUpdates = new Map<string, string | undefined>();
    const childAutoStrategyOverride = workflowUsesAutoProvider({
      workflowConfig: request.childWorkflow,
      effectiveProvider: request.childProviderInfo.provider,
      cliProvider: undefined,
      projectCwd: this.deps.projectCwd,
      lookupCwd: this.deps.getCwd(),
      workflowCallResolver: this.deps.resolveWorkflowCall,
    })
      ? options.autoStrategyOverride
      : undefined;
    const childEngine = this.deps.createEngine(request.childWorkflow, this.deps.getCwd(), this.deps.task, {
      ...options,
      maxStepsOverride: this.deps.sharedRuntime.maxSteps ?? this.deps.getMaxSteps(),
      initialSessions: Object.fromEntries(this.deps.state.personaSessions),
      provider: request.childProviderInfo.provider,
      model: request.childProviderInfo.model,
      providerOptions: mergeProviderOptions(
        request.parentProviderOptions,
        request.step.overrides?.providerOptions,
      ),
      autoRouting: applyAutoRoutingStrategyOverride(
        request.childWorkflow.autoRouting ?? options.autoRouting,
        childAutoStrategyOverride,
      ),
      autoStrategyOverride: childAutoStrategyOverride,
      // Child workflows need router prompts scoped to the child workflow name and run namespace.
      autoRoutingAiRouter: undefined,
      onSessionUpdate: executeOptions.syncParentState
        ? options.onSessionUpdate
        : (persona, sessionId) => {
            sessionUpdates.set(persona, sessionId);
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
    });

    this.relayChildEvents(childEngine);
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
