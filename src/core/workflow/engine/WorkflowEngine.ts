import { EventEmitter } from 'node:events';
import { CapabilityAwareStructuredCaller, type StructuredCaller } from '../../../agents/structured-caller.js';
import { createAutoRoutingAiRouter } from '../../../agents/auto-routing-usecase.js';
import { createLogger, generateReportDir, getErrorMessage, isValidReportDirName } from '../../../shared/utils/index.js';
import type {
  AgentResponse,
  FindingContractConfig,
  WorkflowConfig,
  WorkflowMaxSteps,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
  WorkflowState,
  WorkflowStep,
} from '../../models/types.js';
import { buildRunPaths, type RunPaths } from '../run/run-paths.js';
import type {
  WorkflowCallChildEngine,
  WorkflowAbortKind,
  WorkflowEngineOptions,
  WorkflowRunResult,
  WorkflowSharedRuntimeState,
} from '../types.js';
import { LoopDetector } from './loop-detector.js';
import { createInitialState, addUserInput as addUserInputToState } from './state-manager.js';
import { CycleDetector } from './cycle-detector.js';
import { runSingleWorkflowIteration, runWorkflowToCompletion } from './WorkflowRunLoop.js';
import { validateWorkflowConfig } from './WorkflowValidator.js';
import { getWorkflowStepKind } from '../step-kind.js';
import { applyAutoRoutingStrategyOverride } from '../auto-routing/resolver.js';
import { resolveEffectiveAutoRouting } from '../auto-routing/effective-auto-routing.js';
import { buildWorkflowResumePointEntry, workflowEntryMatchesWorkflow } from '../workflow-reference.js';
import { runWithWorkflowSpan, type WorkflowSpanOutcome, type WorkflowSpanParams } from '../observability/workflowSpans.js';
import { WorkflowEngineStepCoordinator } from './WorkflowEngineStepCoordinator.js';
import {
  applyRuntimeEnvironment,
  assertTaskPrefixPair,
  createSharedRuntime,
  createWorkflowEngineServices,
  ensureRunDirsExist,
  type WorkflowEngineServices,
} from './WorkflowEngineSetup.js';
import {
  createStructuredOutputNormalizerRegistry,
  type StructuredOutputNormalizerRegistry,
} from './structured-output-normalizer.js';
import { runQualityGates } from '../quality-gates/qualityGateRunner.js';
import { buildFindingsRuleContext } from '../findings/context.js';
import { hasUnquotedIdentifierReference } from '../evaluation/rule-utils.js';
import { createFindingLedgerStore, type FindingLedgerStore, type NeedsAdjudicationStopReason } from '../findings/store.js';
import { stopBudgetRoundsCompleted } from '../findings/stop-budget.js';
import { reviewIntegrityRoundsCompleted } from '../findings/review-integrity.js';
import type { FindingLedger, FindingLedgerEntry, ReviewerAnomalyEntry } from '../findings/types.js';
import { injectFindingConflictAdjudicationStep } from '../findings/adjudication-step.js';
import { createFindingConflictAdjudicationRunner } from '../findings/adjudication-runner.js';
import { ERROR_MESSAGES } from '../constants.js';
import { inheritReviewReports, writeReviewReportInheritanceDiagnostic } from '../report-inheritance.js';
import {
  resolveCurrentReviewReportPathsWithDiagnostics,
} from '../instruction/report-handles.js';
import {
  resolveInheritedReviewReportNamesWithDiagnostics,
  type InheritedReviewReportNamesResult,
} from '../review-report-discovery.js';
const log = createLogger('workflow-engine');
export type {
  WorkflowEvents,
  StepProviderInfo,
  UserInputRequest,
  IterationLimitRequest,
  SessionUpdateCallback,
  IterationLimitCallback,
  WorkflowEngineOptions,
} from '../types.js';
export { COMPLETE_STEP, ABORT_STEP } from '../constants.js';

const workflowRunExecutors = new WeakMap<WorkflowEngine, () => Promise<WorkflowRunResult>>();
const FIX_STEP_NAME = 'fix';

function getWorkflowRunExecutor(engine: WorkflowEngine): () => Promise<WorkflowRunResult> {
  const executor = workflowRunExecutors.get(engine);
  if (!executor) {
    throw new Error('WorkflowEngine executor is not registered');
  }
  return executor;
}

export class WorkflowEngine extends EventEmitter {
  private state: WorkflowState;
  private config: WorkflowConfig;
  private projectCwd: string;
  private cwd: string;
  private task: string;
  private options: WorkflowEngineOptions & { structuredOutputNormalizers: StructuredOutputNormalizerRegistry };
  private maxSteps: WorkflowMaxSteps;
  private loopDetector: LoopDetector;
  private cycleDetector: CycleDetector;
  private reportDir: string;
  private runPaths: RunPaths;
  private abortRequested = false;
  private readonly sharedRuntime: WorkflowSharedRuntimeState;
  private readonly resumeStackPrefix: WorkflowResumePointEntry[];
  private readonly findingLedgerStore?: FindingLedgerStore;
  private readonly findingContract?: FindingContractConfig;

  private readonly optionsBuilder: WorkflowEngineServices['optionsBuilder'];
  private readonly stepExecutor: WorkflowEngineServices['stepExecutor'];
  private readonly parallelRunner: WorkflowEngineServices['parallelRunner'];
  private readonly arpeggioRunner: WorkflowEngineServices['arpeggioRunner'];
  private readonly teamLeaderRunner: WorkflowEngineServices['teamLeaderRunner'];
  private readonly systemStepExecutor: WorkflowEngineServices['systemStepExecutor'];
  private readonly loopMonitorJudgeRunner: WorkflowEngineServices['loopMonitorJudgeRunner'];
  private readonly workflowCallRunner: WorkflowEngineServices['workflowCallRunner'];
  private readonly stepCoordinator: WorkflowEngineStepCoordinator;
  private readonly detectRuleIndex: (content: string, stepName: string) => number;
  private readonly structuredCaller: StructuredCaller;
  private readonly inheritedReviewReports: Array<{ reportName: string; path: string }> = [];
  private resolvedReviewReportNames: InheritedReviewReportNamesResult | undefined;

  constructor(config: WorkflowConfig, cwd: string, task: string, options: WorkflowEngineOptions) {
    super();
    assertTaskPrefixPair(options.taskPrefix, options.taskColorIndex);
    this.structuredCaller = options.structuredCaller ?? new CapabilityAwareStructuredCaller();
    if (options.reportDirName !== undefined && !isValidReportDirName(options.reportDirName)) {
      throw new Error(`Invalid reportDirName: ${options.reportDirName}`);
    }

    const reportDirName = options.reportDirName ?? generateReportDir(task);
    const runPaths = buildRunPaths(cwd, reportDirName, options.runPathNamespace);
    const traceTaskMetadata = {
      ...options.traceTaskMetadata,
      runDir: runPaths.runRootAbs,
    };
    const autoRoutingAiRouter = options.autoRoutingAiRouter ?? createAutoRoutingAiRouter({
      cwd,
      workflowName: config.name,
      runId: runPaths.slug,
      language: options.language,
      childProcessEnv: options.childProcessEnv,
      abortSignal: options.abortSignal,
      onStream: options.onStream,
      onProviderStream: options.onProviderStream,
    });
    const inheritedAutoRouting = resolveEffectiveAutoRouting(config, options.autoRouting);
    if (options.autoStrategyOverride !== undefined && inheritedAutoRouting !== undefined) {
      options.onEffectiveAutoRoutingReached?.();
    }
    const effectiveAutoRouting = applyAutoRoutingStrategyOverride(
      inheritedAutoRouting,
      options.autoStrategyOverride,
    );
    // The adjudication target must participate in normal step validation and execution,
    // so it is injected into config.steps whenever the workflow (or a
    // loop monitor judge) wires a rule to it and a finding contract is in
    // effect. Injection happens before validateWorkflowConfig so the injected
    // step is validated exactly like an authored step (session, provider,
    // model), and before any service captures config.steps.
    this.config = injectFindingConflictAdjudicationStep(
      config,
      options.inheritedFindingContract?.contract ?? config.findingContract,
    );
    this.options = {
      ...options,
      rateLimitFallback: config.rateLimitFallback ?? options.rateLimitFallback,
      structuredCaller: this.structuredCaller,
      structuredOutputNormalizers: options.structuredOutputNormalizers ?? createStructuredOutputNormalizerRegistry([]),
      autoRouting: effectiveAutoRouting,
      autoRoutingAiRouter,
      traceTaskMetadata,
    };
    this.projectCwd = this.options.projectCwd;
    this.cwd = cwd;
    this.task = task;
    this.loopDetector = new LoopDetector(this.config.loopDetection);
    this.cycleDetector = new CycleDetector(this.config.loopMonitors ?? []);
    const initialMaxSteps = this.options.maxStepsOverride ?? this.config.maxSteps;
    this.sharedRuntime = this.options.sharedRuntime ?? createSharedRuntime(this.options.resumePoint, initialMaxSteps);
    this.sharedRuntime.maxSteps ??= initialMaxSteps;
    this.maxSteps = this.sharedRuntime.maxSteps;
    this.resumeStackPrefix = this.options.resumeStackPrefix ?? [];
    this.runPaths = runPaths;
    this.reportDir = this.runPaths.reportsRel;
    ensureRunDirsExist(this.runPaths);
    applyRuntimeEnvironment(this.cwd, this.config, 'init');
    validateWorkflowConfig(this.config, this.options);

    this.state = createInitialState(this.config, this.options);
    this.inheritPreviousReviewReports();
    // workflow_call の親から継承した Finding Contract があればそれを優先する。
    // 継承しないと子の parallel レビューが出す raw findings が親の台帳に届かず、
    // fix ステップへ渡らないまま reviewers ↔ fix が回り続ける（実測: 56周・9時間）。
    // 自前 finding_contract と継承の同時指定は WorkflowValidator で設定エラーに
    // しているため、ここでは「継承 or 自前」のどちらか一方だけが来る前提で良い。
    this.findingContract = this.options.inheritedFindingContract?.contract ?? this.config.findingContract;
    if (this.findingContract) {
      // 継承時は親と同一の FindingLedgerStore インスタンスをそのまま使う。
      // ledger_path / raw_findings_path はワークフロー名に紐づくため、子が
      // 自前で store を作り直すと親の when(findings.*) と別の台帳を見てしまう。
      this.findingLedgerStore = this.options.inheritedFindingContract?.ledgerStore ?? createFindingLedgerStore({
        projectCwd: this.projectCwd,
        reportDir: this.runPaths.reportsAbs,
        workflowName: this.config.name,
        ledgerPath: this.findingContract.ledgerPath,
        rawFindingsPath: this.findingContract.rawFindingsPath,
      });
      this.refreshFindingsState();
      this.findingLedgerStore.createRunCopy();
    }
    this.detectRuleIndex = this.options.detectRuleIndex ?? (() => {
      throw new Error('detectRuleIndex is required for rule evaluation');
    });
    const services = createWorkflowEngineServices({
      config: this.config,
      state: this.state,
      task: this.task,
      projectCwd: this.projectCwd,
      getCwd: () => this.cwd,
      getReportDir: () => this.reportDir,
      getRunPaths: () => this.runPaths,
      getMaxSteps: () => this.maxSteps,
      options: this.options,
      detectRuleIndex: this.detectRuleIndex,
      structuredCaller: this.structuredCaller,
      sharedRuntime: this.sharedRuntime,
      resumeStackPrefix: this.resumeStackPrefix,
      runPaths: this.runPaths,
      updateMaxSteps: (maxSteps) => {
        this.maxSteps = maxSteps;
        this.sharedRuntime.maxSteps = maxSteps;
      },
      setActiveResumePoint: this.setActiveResumePoint.bind(this),
      refreshFindingsState: this.refreshFindingsState.bind(this),
      findingContract: this.findingContract,
      findingLedgerStore: this.findingLedgerStore,
      updatePersonaSession: this.updatePersonaSession.bind(this),
      resolveNextStepFromDone: this.resolveNextStepFromDone.bind(this),
      resetCycleDetector: () => this.cycleDetector.reset(),
      getInheritedPeerReportPaths: (step) => this.getReviewReportPaths(step),
      emitEvent: (event, ...args) => this.emit(event as never, ...args as []),
      createEngine: (nestedConfig, nestedCwd, nestedTask, nestedOptions): WorkflowCallChildEngine => {
        const nestedEngine = new WorkflowEngine(nestedConfig, nestedCwd, nestedTask, nestedOptions);
        return {
          on: nestedEngine.on.bind(nestedEngine),
          runWithResult: () => getWorkflowRunExecutor(nestedEngine)(),
        };
      },
    });
    this.optionsBuilder = services.optionsBuilder;
    this.stepExecutor = services.stepExecutor;
    this.parallelRunner = services.parallelRunner;
    this.arpeggioRunner = services.arpeggioRunner;
    this.teamLeaderRunner = services.teamLeaderRunner;
    this.systemStepExecutor = services.systemStepExecutor;
    this.loopMonitorJudgeRunner = services.loopMonitorJudgeRunner;
    this.workflowCallRunner = services.workflowCallRunner;
    this.stepCoordinator = new WorkflowEngineStepCoordinator({
      config: this.config,
      state: this.state,
      task: this.task,
      getMaxSteps: () => this.maxSteps,
      getOptions: () => this.options,
      stepExecutor: this.stepExecutor,
      parallelRunner: this.parallelRunner,
      arpeggioRunner: this.arpeggioRunner,
      teamLeaderRunner: this.teamLeaderRunner,
      systemStepExecutor: this.systemStepExecutor,
      loopMonitorJudgeRunner: this.loopMonitorJudgeRunner,
      workflowCallRunner: this.workflowCallRunner,
      updatePersonaSession: this.updatePersonaSession.bind(this),
      emitReport: (step, filePath, fileName) => this.emit('step:report', step, filePath, fileName),
      findingConflictAdjudicationRunner: this.findingContract && this.findingLedgerStore
        ? createFindingConflictAdjudicationRunner({
          ledgerStore: this.findingLedgerStore,
          optionsBuilder: this.optionsBuilder,
          stepExecutor: this.stepExecutor,
          getCwd: () => this.cwd,
          // 台帳へ書く文脈の workflowName は store が束縛する正準名を使う。
          // workflow_call の子が親の台帳を継承した場合、this.config.name
          // （子の名前）を使うと reconcile 文脈が親の台帳の workflowName と
          // 食い違う（StepExecutor / ParallelRunner の manager 経路と同じ理由）。
          workflowName: this.findingLedgerStore.workflowName,
          runId: this.runPaths.slug,
          refreshFindingsState: this.refreshFindingsState.bind(this),
          emitEvent: (event, ...args) => this.emit(event as never, ...args as []),
        })
        : undefined,
    });
    workflowRunExecutors.set(this, () => this.runWithSystemCleanup(
      () => runWithWorkflowSpan(
        this.buildWorkflowSpanParams('full'),
        () => runWorkflowToCompletion({
          state: this.state,
          options: this.options,
          getWorkflowName: () => this.config.name,
          getCurrentWorkflowStack: () => this.sharedRuntime.activeResumePoint?.stack,
          getCwd: () => this.cwd,
          getMaxSteps: () => this.maxSteps,
          getReportDir: () => this.runPaths.reportsAbs,
          abortRequested: () => this.abortRequested,
          getStep: this.stepCoordinator.getStep.bind(this.stepCoordinator),
          applyRuntimeEnvironment: (stage) => applyRuntimeEnvironment(this.cwd, this.config, stage),
          loopDetectorCheck: (stepName) => {
            const result = this.loopDetector.check(stepName);
            return {
              shouldWarn: result.shouldWarn ?? false,
              shouldAbort: result.shouldAbort ?? false,
              count: result.count,
              isLoop: result.isLoop,
            };
          },
          cycleDetectorRecordAndCheck: (stepName) => this.cycleDetector.recordAndCheck(stepName),
          resolveDoneTransition: this.stepCoordinator.resolveTransitionFromDone.bind(this.stepCoordinator),
          runLoopMonitorJudge: this.stepCoordinator.runLoopMonitorJudge.bind(this.stepCoordinator),
          runStep: this.stepCoordinator.runStep.bind(this.stepCoordinator),
          runQualityGates,
          persistPreviousResponseSnapshot: this.stepExecutor.persistPreviousResponseSnapshot.bind(this.stepExecutor),
          buildInstruction: this.stepCoordinator.buildInstruction.bind(this.stepCoordinator),
          buildPhase1Instruction: this.stepCoordinator.buildPhase1Instruction.bind(this.stepCoordinator),
          resolveStepProviderModel: (step, runtime) => this.optionsBuilder.resolveStepProviderModel(step, runtime),
          resolveStepProviderModelBeforeAutoRouting: (step, runtime) => this.optionsBuilder.resolveStepProviderModelBeforeAutoRouting(step, runtime),
          resolveRuntimeForStep: this.stepCoordinator.resolveRuntimeForStep.bind(this.stepCoordinator),
          setActiveStep: this.setActiveResumePoint.bind(this),
          addUserInput: this.addUserInput.bind(this),
          emit: (event, ...args) => this.emit(event as never, ...args as []),
          updateMaxSteps: (maxSteps) => {
            this.maxSteps = maxSteps;
            this.sharedRuntime.maxSteps = maxSteps;
          },
          checkCompletionGate: this.checkCompletionGate.bind(this),
          checkReviewIntegrityGate: this.checkReviewIntegrityGate.bind(this),
          recordNeedsAdjudication: this.recordNeedsAdjudication.bind(this),
        }),
        (result) => ({
          status: result.state.status,
          abortKind: result.abort?.kind,
          abortReason: result.abort?.reason,
          failure: result.abort?.failure,
          iterations: result.state.iteration,
        }),
        (error) => this.buildWorkflowErrorSpanOutcome(error),
      ),
      () => true,
    ));

    log.debug('WorkflowEngine initialized', {
      workflow: config.name,
      steps: config.steps.map((step) => step.name),
      initialStep: config.initialStep,
      maxSteps: config.maxSteps,
      effectiveMaxSteps: this.maxSteps,
    });
  }

  getState(): WorkflowState {
    return { ...this.state };
  }

  private refreshFindingsState(): void {
    if (!this.findingLedgerStore) {
      return;
    }
    this.state.findings = buildFindingsRuleContext(this.findingLedgerStore.loadLedger(), this.cwd);
  }

  /** Open findings still carrying provisional metadata (shared by checkCompletionGate and recordNeedsAdjudication). */
  private loadOpenProvisionalFindings(ledger: FindingLedger): FindingLedgerEntry[] {
    return ledger.findings.filter(
      (finding) => finding.status === 'open' && finding.provisional !== undefined,
    );
  }

  /** Human-readable bullet lines for open provisional findings (shared by checkCompletionGate and recordNeedsAdjudication). */
  private formatProvisionalFindingItems(provisionals: readonly FindingLedgerEntry[]): string[] {
    return provisionals.map(
      (finding) => `- ${finding.id} [${finding.provisional!.kind}]: ${finding.provisional!.reason}`,
    );
  }

  /**
   * 二系統台帳（review-integrity protocol）の review-integrity 側の未昇格 anomaly
   * （recordNeedsAdjudication 専用）。product gate（checkCompletionGate）は
   * この配列を一切参照しない — anomaly 単体で COMPLETE を拒否することはない
   * （安全不変条件: anomaly は product gate を塞がない）。NEEDS_ADJUDICATION に
   * 到達したときだけ、監査情報として同梱する。
   */
  private loadOutstandingReviewerAnomalies(ledger: FindingLedger): ReviewerAnomalyEntry[] {
    return (ledger.reviewerAnomalies ?? []).filter((anomaly) => anomaly.promotedFindingId === undefined);
  }

  /**
   * COMPLETE 遷移直前のエンジン最終不変条件。2つの独立したゲートを見る:
   *
   * 1. product gate: open な provisional finding（意味を確定
   *    できなかった観測）が1件でも残っていれば COMPLETE を拒否する。
   *
   * 2. review-integrity gate（review-integrity requirement）: 未昇格（promotedFindingId
   *    無し）の reviewer anomaly が1件でも残っていれば COMPLETE を拒否する。
   *    二系統台帳（review-integrity protocol）で全指摘が anomaly に隔離された run は product
   *    gate が空になり「即 COMPLETE」で実質レビューされずに通り得たため、product
   *    gate とは別にここで fail-closed にする。anomaly は product finding では
   *    ないので product gate（open/provisional の count）は塞がない — この
   *    review-integrity gate だけが COMPLETE を止め、builtin は未昇格 anomaly を
   *    見て再レビュー（有限回で NEEDS_ADJUDICATION）へルーティングする。custom
   *    workflow がその配線を欠いても、このエンジンゲートが COMPLETE を拒否する。
   *
   * builtin workflow は先に findings.provisional.count / findings.reviewerAnomalies を
   * 見てルーティングするため、ここが発火するのは custom workflow の設定不備 —
   * 「ルールはあるが何もマッチしない」と同じクラスとして fail-fast する。判定は
   * state.findings のキャッシュではなく保存直前の台帳を再読込して行う（並列子の
   * 更新を見逃さない）。
   */
  private checkCompletionGate(): { ok: true } | { ok: false; reason: string } {
    if (!this.findingLedgerStore) {
      return { ok: true };
    }
    const ledger = this.findingLedgerStore.loadLedger();
    const provisionals = this.loadOpenProvisionalFindings(ledger);
    const anomalies = this.loadOutstandingReviewerAnomalies(ledger);
    if (provisionals.length === 0 && anomalies.length === 0) {
      return { ok: true };
    }
    const reasonLines: string[] = ['Cannot COMPLETE:'];
    if (provisionals.length > 0) {
      reasonLines.push(
        `- ${provisionals.length} provisional finding(s) remain open (observations whose meaning could not be determined):`,
        ...this.formatProvisionalFindingItems(provisionals),
        '  Workflow rules must route on findings.provisional.count (e.g. to a replan step) before COMPLETE; a provisional finding is a system finding that blocks the final gate until later clean review evidence settles it.',
      );
    }
    if (anomalies.length > 0) {
      reasonLines.push(...this.formatReviewIntegrityGateReason(anomalies));
    }
    return { ok: false, reason: reasonLines.join('\n') };
  }

  private formatReviewIntegrityGateReason(anomalies: readonly ReviewerAnomalyEntry[]): string[] {
    return [
      `- ${anomalies.length} unpromoted reviewer anomaly(ies) remain (reviewer claims whose evidence did not mechanically verify — the reviewed scope was not soundly reviewed):`,
      ...anomalies.map((anomaly) => `  - ${anomaly.id} [${anomaly.kind}]: ${anomaly.mismatchReason}`),
      '  This is the review-integrity gate: an unpromoted anomaly is NOT a product finding, so it does not block the product gate — but the workflow must route on findings.reviewerAnomalies.count to re-review (reviewers) until a correctly-quoted finding promotes it or, once findings.reviewerAnomalies.budgetExhausted is true, to NEEDS_ADJUDICATION. Completion is never allowed while an unverified reviewer anomaly stands.',
    ];
  }

  /**
   * review-integrity gate 単独。checkCompletionGate は product
   * gate（provisional）+ review-integrity gate（未昇格 anomaly）の両方を見るが、
   * こちらは未昇格 anomaly だけを見る。returnValue 終端（`return: X`）に適用する
   * ためのもの: `return: need_replan` のような「未解決の provisional を親/呼び出し元へ
   * ハンドバックするシグナル」は provisional gate で塞ぐべきではない（provisional は
   * そのシグナルで扱われる）が、未昇格 anomaly が残ったまま 'completed' になるのは
   * どの完了経路でも許さない（review integrity は engine 側のハード不変条件）。
   */
  private checkReviewIntegrityGate(): { ok: true } | { ok: false; reason: string } {
    if (!this.findingLedgerStore) {
      return { ok: true };
    }
    const anomalies = this.loadOutstandingReviewerAnomalies(this.findingLedgerStore.loadLedger());
    if (anomalies.length === 0) {
      return { ok: true };
    }
    return { ok: false, reason: ['Cannot complete:', ...this.formatReviewIntegrityGateReason(anomalies)].join('\n') };
  }

  /**
   * NEEDS_ADJUDICATION の停止理由（Finding Contract の有限停止予算
   * 拡張）を、実際にマッチしたルールの condition（= 事実）から分類する。台帳
   * 状態からの推定ではない — WorkflowRunLoop が遷移を起こしたルールの condition
   * 文字列を渡してくる（recordNeedsAdjudication の引数）。builtin では fixpoint と
   * budget は別ルールなので matchedCondition はどちらか一方だけを参照し、ルール順を
   * 入れ替えても「先にマッチしたルールの condition」が渡るため常に正しい理由になる
   * （first-match-wins）。
   *
   * ただし first-match-wins が確定させるのは「どのルール」であって、複合式
   * （when-evaluator は `||` / `&&` を正式サポート）の中で「どのサブ式が成立
   * 要因か」ではない。単一 condition が両シグナルを参照する場合
   * （例: `fixpoint == true || budgetExhausted == true`）は、どちらが成立して
   * マッチしたか condition テキストからは判別できないため、決めつけず
   * 'unclassified' にする（verbatim の matchedCondition は監査レポートに残る）。
   * loop-monitor judge override 等で condition が取れない場合
   * （matchedCondition === undefined）や、両シグナルとも参照しない場合も
   * 'unclassified'。
   *
   * シグナル検出は hasUnquotedIdentifierReference（rule-utils / when-evaluator と
   * 同じ引用除去・識別子境界処理）で行う。単純な includes() は引用文字列内の
   * 一致（例: `... != "findings.provisional.fixpoint"` は budget のみの有効条件）や
   * 部分文字列の偶然一致を拾うため使わない。
   */
  private classifyNeedsAdjudicationStopReason(matchedCondition: string | undefined): NeedsAdjudicationStopReason {
    if (matchedCondition === undefined) {
      return 'unclassified';
    }
    const referencesFixpoint = hasUnquotedIdentifierReference(matchedCondition, 'findings.provisional.fixpoint');
    const referencesBudget = hasUnquotedIdentifierReference(matchedCondition, 'findings.rounds.budgetExhausted');
    // review-integrity requirement: review-integrity 予算切れ（未昇格 anomaly が有限回の
    // 再レビューでも補完できず NEEDS_ADJUDICATION へ）。findings.rounds.budgetExhausted
    // とは別の識別子なので取り違えない。
    const referencesReviewIntegrity = hasUnquotedIdentifierReference(matchedCondition, 'findings.reviewerAnomalies.budgetExhausted');
    const signalCount = [referencesFixpoint, referencesBudget, referencesReviewIntegrity].filter(Boolean).length;
    if (signalCount !== 1) {
      // 複数シグナルを1条件が参照する場合はどれが成立要因か判別できない。
      return 'unclassified';
    }
    if (referencesFixpoint) {
      return 'fixpoint';
    }
    if (referencesBudget) {
      return 'budget-exhausted';
    }
    if (referencesReviewIntegrity) {
      return 'review-integrity-exhausted';
    }
    return 'unclassified';
  }

  /**
   * `next: NEEDS_ADJUDICATION` 到達時に、open provisional findings と発生元
   * （sourceRawFindingIds / reason / reviewers）、実際にマッチした condition
   * （matchedCondition）と、そこから分類した停止理由（fixpoint /
   * budget-exhausted）を監査レポート（findings-ledger store 経由）へ永続化し、
   * CLI に表示する人間可読な abort reason を返す。matchedCondition は
   * WorkflowRunLoop が「NEEDS_ADJUDICATION へ遷移させたルールの condition」を
   * 渡してくる事実であり、台帳状態からの推定ではない。findingLedgerStore は
   * 必ず定義済み — この遷移は findings.* を参照する rule からしか到達できず、
   * WorkflowValidator が finding_contract 無しでのその rule 記述自体を拒否する
   * （validateNeedsAdjudicationRuleContract）。
   */
  private recordNeedsAdjudication(matchedCondition?: string): string {
    const ledger = this.findingLedgerStore!.loadLedger();
    const provisionals = this.loadOpenProvisionalFindings(ledger);
    const reviewerAnomalies = this.loadOutstandingReviewerAnomalies(ledger);
    const stopReason = this.classifyNeedsAdjudicationStopReason(matchedCondition);
    const roundsCompleted = stopBudgetRoundsCompleted(ledger);
    // headline のラウンド数は停止理由に合わせる: review-integrity 予算切れなら
    // review-integrity の完了ラウンド数、それ以外は stop budget のラウンド数。
    const headlineRounds = stopReason === 'review-integrity-exhausted'
      ? reviewIntegrityRoundsCompleted(ledger)
      : roundsCompleted;
    const stopBudget = ledger.stopBudget !== undefined
      ? { roundsCompleted, firstRoundAt: ledger.stopBudget.firstRoundAt }
      : undefined;
    this.findingLedgerStore!.saveNeedsAdjudicationReport({
      version: 1,
      runId: this.runPaths.slug,
      stepName: this.state.currentStep,
      reachedAt: new Date().toISOString(),
      stopReason,
      ...(matchedCondition !== undefined ? { matchedCondition } : {}),
      ...(stopBudget !== undefined ? { stopBudget } : {}),
      provisionalFindings: provisionals.map((finding) => ({
        findingId: finding.id,
        kind: finding.provisional!.kind,
        stableKey: finding.provisional!.stableKey,
        reason: finding.provisional!.reason,
        reviewers: finding.reviewers,
        sourceRawFindingIds: finding.provisional!.sourceRawFindingIds,
      })),
      ...(reviewerAnomalies.length > 0
        ? {
          reviewerAnomalies: reviewerAnomalies.map((anomaly) => ({
            id: anomaly.id,
            kind: anomaly.kind,
            stableKey: anomaly.stableKey,
            reason: anomaly.mismatchReason,
            reviewers: anomaly.reviewers,
            sourceRawFindingIds: anomaly.sourceRawFindingIds,
            occurrences: anomaly.occurrences,
          })),
        }
        : {}),
    });
    // review-integrity 側で止まったときは anomaly を、それ以外は provisional を
    // 明細として出す（両方あれば両方）。
    const items = [
      ...this.formatProvisionalFindingItems(provisionals),
      ...reviewerAnomalies.map((anomaly) => `- ${anomaly.id} [${anomaly.kind}]: ${anomaly.mismatchReason}`),
    ];
    const headline = this.buildNeedsAdjudicationHeadline(
      stopReason,
      provisionals.length,
      reviewerAnomalies.length,
      headlineRounds,
    );
    return [
      headline,
      ...items,
      'A human must adjudicate: edit the finding ledger to drop/resolve the stuck provisional finding(s) or reviewer anomaly(ies), or provide new review evidence (a correctly-quoted finding that promotes the anomaly), then continue with `takt resume`.',
    ].join('\n');
  }

  private buildNeedsAdjudicationHeadline(
    stopReason: NeedsAdjudicationStopReason,
    provisionalCount: number,
    anomalyCount: number,
    roundsCompleted: number,
  ): string {
    switch (stopReason) {
      case 'budget-exhausted':
        return `NEEDS_ADJUDICATION: the findings-manager stop budget was exhausted (${roundsCompleted} round(s) completed) while ${provisionalCount} provisional finding(s) remained open and unresolved:`;
      case 'fixpoint':
        return `NEEDS_ADJUDICATION: ${provisionalCount} provisional finding(s) reached a fixpoint (no meaningful change across consecutive review rounds) and cannot be resolved automatically:`;
      case 'review-integrity-exhausted':
        return `NEEDS_ADJUDICATION: the review-integrity budget was exhausted (${roundsCompleted} round(s) completed) while ${anomalyCount} unpromoted reviewer anomaly(ies) — reviewer claims whose evidence never mechanically verified — could not be substantiated by re-review:`;
      case 'unclassified':
        return `NEEDS_ADJUDICATION: the workflow routed to a human-adjudication stop with ${provisionalCount} provisional finding(s) and ${anomalyCount} unpromoted reviewer anomaly(ies) still open:`;
    }
  }

  private inheritPreviousReviewReports(): void {
    const resumeSource = this.options.resumeSource;
    const currentStep = this.config.steps.find((step) => step.name === this.state.currentStep);
    if (!resumeSource || !currentStep || currentStep.name !== FIX_STEP_NAME || !this.isResumeTarget(currentStep)) {
      return;
    }
    try {
      const reportNameResult = this.resolveReviewReportNames(currentStep);
      const result = inheritReviewReports({
        cwd: this.cwd,
        sourceRunSlug: resumeSource.sourceRunSlug,
        currentRunSlug: this.runPaths.slug,
        targetReportDirectory: this.runPaths.reportsAbs,
        reviewReportNames: reportNameResult.reportNames,
        discoveryFailures: reportNameResult.failures,
      });
      this.inheritedReviewReports.push(...result.copied.map((entry) => ({
        reportName: entry.reportName,
        path: entry.targetPath,
      })));
      try {
        writeReviewReportInheritanceDiagnostic({
          cwd: this.cwd,
          sourceRunSlug: resumeSource.sourceRunSlug,
          currentRunSlug: this.runPaths.slug,
          targetReportDirectory: this.runPaths.reportsAbs,
          reviewReportNames: reportNameResult.reportNames,
        }, result);
      } catch (error) {
        log.warn('Failed to write review report inheritance diagnostic', { error: getErrorMessage(error), result });
      }
      if (result.fallbackUsed) {
        log.warn('Review report inheritance completed with fallback', result);
      } else {
        log.info('Review report inheritance completed', result);
      }
    } catch (error) {
      const diagnosticOptions = {
        cwd: this.cwd,
        sourceRunSlug: resumeSource.sourceRunSlug,
        currentRunSlug: this.runPaths.slug,
        targetReportDirectory: this.runPaths.reportsAbs,
        reviewReportNames: [],
      };
      const result = {
        ...(resumeSource.sourceRunSlug ? { sourceRunSlug: resumeSource.sourceRunSlug } : {}),
        targetReportDirectory: this.runPaths.reportsAbs,
        status: 'unavailable' as const,
        fallbackUsed: true,
        copied: [],
        skipped: [{ reportName: '*', reason: `resolution_failed:${getErrorMessage(error)}` }],
      };
      try {
        writeReviewReportInheritanceDiagnostic(diagnosticOptions, result);
      } catch (diagnosticError) {
        log.warn('Failed to write review report inheritance diagnostic', {
          error: getErrorMessage(diagnosticError),
          result,
        });
      }
      log.warn('Review report inheritance completed with fallback', result);
    }
  }

  private isResumeTarget(step: WorkflowStep): boolean {
    if (this.options.startStep === step.name) {
      return true;
    }
    const resumePoint = this.options.resumePoint;
    const entry = resumePoint?.stack[this.resumeStackPrefix.length];
    return entry !== undefined
      && entry.step === step.name
      && workflowEntryMatchesWorkflow(entry, this.config);
  }

  private getReviewReportPaths(step: WorkflowStep): readonly string[] {
    if (step.name !== FIX_STEP_NAME) {
      return [];
    }
    try {
      const reportNameResult = this.resolveReviewReportNames(step);
      const inheritedReportPaths = new Set(this.inheritedReviewReports.map((entry) => entry.path));
      const scanResult = resolveCurrentReviewReportPathsWithDiagnostics(
        this.runPaths.reportsAbs,
        reportNameResult.reportNames,
        inheritedReportPaths,
      );
      if (scanResult.scanFailure) {
        log.warn('Current review report scan completed with fallback', { error: scanResult.scanFailure });
      }
      if (reportNameResult.failures.length > 0) {
        log.warn('Current review report discovery completed with fallback', {
          failures: reportNameResult.failures,
        });
      }
      const currentReports = scanResult.paths;
      const currentReportNames = new Set(currentReports.map((entry) => entry.reportName));
      return [
        ...currentReports.map((entry) => entry.path),
        ...this.inheritedReviewReports
          .filter((entry) => !currentReportNames.has(entry.reportName))
          .map((entry) => entry.path),
      ];
    } catch (error) {
      log.warn('Failed to resolve current review report paths', { error: getErrorMessage(error) });
      return this.inheritedReviewReports.map((entry) => entry.path);
    }
  }

  private resolveReviewReportNames(step: WorkflowStep): InheritedReviewReportNamesResult {
    if (!this.resolvedReviewReportNames) {
      this.resolvedReviewReportNames = resolveInheritedReviewReportNamesWithDiagnostics({
        step,
        workflow: this.config,
        workflowCallResolver: this.options.workflowCallResolver,
        projectCwd: this.projectCwd,
        lookupCwd: this.cwd,
        resumeStackPrefix: this.resumeStackPrefix,
      });
    }
    return this.resolvedReviewReportNames;
  }

  private buildResumePoint(step: WorkflowStep, iteration: number): WorkflowResumePoint {
    return {
      version: 1,
      stack: [...this.resumeStackPrefix, buildWorkflowResumePointEntry(this.config, step.name, getWorkflowStepKind(step))],
      iteration,
      elapsed_ms: Date.now() - this.sharedRuntime.startedAtMs,
    };
  }

  private setActiveResumePoint(step: WorkflowStep, iteration: number): void {
    this.sharedRuntime.activeResumePoint = this.buildResumePoint(step, iteration);
  }

  getResumePoint(): WorkflowResumePoint | undefined {
    return this.sharedRuntime.activeResumePoint;
  }

  buildResumePointForStepName(stepName: string): WorkflowResumePoint | undefined {
    const step = this.config.steps.find((candidate) => candidate.name === stepName);
    return step ? this.buildResumePoint(step, this.state.iteration) : undefined;
  }

  addUserInput(input: string): void {
    addUserInputToState(this.state, input);
  }

  updateCwd(newCwd: string): void { this.cwd = newCwd; }
  getCwd(): string { return this.cwd; }
  getProjectCwd(): string { return this.projectCwd; }

  abort(): void {
    if (this.abortRequested) return;
    this.abortRequested = true;
    log.info('Abort requested');
  }

  isAbortRequested(): boolean { return this.abortRequested; }

  private updatePersonaSession(persona: string, sessionId: string | undefined): void {
    const previousSessionId = this.state.personaSessions.get(persona);
    if (sessionId === previousSessionId) return;

    if (sessionId === undefined) {
      this.state.personaSessions.delete(persona);
    } else {
      this.state.personaSessions.set(persona, sessionId);
    }

    if (this.options.onSessionUpdate && sessionId !== previousSessionId) {
      this.options.onSessionUpdate(persona, sessionId);
    }
  }

  private resolveNextStepFromDone(step: WorkflowStep, response: AgentResponse): string {
    return this.stepCoordinator.resolveNextStepFromDone(step, response);
  }

  private finalizeSystemStepResources(): void {
    this.systemStepExecutor.cleanup();
  }

  private buildWorkflowSpanParams(runMode: WorkflowSpanParams['runMode']): WorkflowSpanParams {
    return {
      enabled: this.options.observability?.enabled === true,
      runId: this.options.observabilityRunId,
      workflowName: this.config.name,
      initialStep: this.config.initialStep,
      stepCount: this.config.steps.length,
      maxSteps: this.maxSteps,
      runMode,
      resumeDepth: this.resumeStackPrefix.length,
      sanitizeText: this.options.sanitizeObservabilityText,
      traceTaskMetadata: this.options.traceTaskMetadata,
    };
  }

  private buildWorkflowErrorSpanOutcome(error: unknown): WorkflowSpanOutcome {
    const kind: WorkflowAbortKind = this.abortRequested ? 'interrupt' : 'runtime_error';
    const reason = this.abortRequested
      ? 'Workflow interrupted by user (SIGINT)'
      : ERROR_MESSAGES.STEP_EXECUTION_FAILED(getErrorMessage(error));
    return {
      status: 'error',
      abortKind: kind,
      abortReason: reason,
      failure: {
        kind,
        step: this.state.currentStep,
        reason,
      },
      iterations: this.state.iteration,
    };
  }

  private async runWithSystemCleanup<T>(
    execute: () => Promise<T>,
    shouldCleanup: (result: T | undefined, error: unknown | undefined) => boolean,
  ): Promise<T> {
    let result: T | undefined;
    let error: unknown | undefined;

    try {
      result = await execute();
      return result;
    } catch (caughtError) {
      error = caughtError;
      throw caughtError;
    } finally {
      if (shouldCleanup(result, error)) {
        this.finalizeSystemStepResources();
      }
    }
  }

  async run(): Promise<WorkflowState & { returnValue?: string }> {
    const result = await getWorkflowRunExecutor(this)();
    return {
      ...result.state,
      ...(result.returnValue !== undefined ? { returnValue: result.returnValue } : {}),
    };
  }

  async runSingleIteration(): Promise<{
    response: AgentResponse;
    nextStep: string;
    isComplete: boolean;
    returnValue?: string;
    loopDetected?: boolean;
  }> {
    return this.runWithSystemCleanup(
      () => runWithWorkflowSpan(
        this.buildWorkflowSpanParams('single_iteration'),
        () => runSingleWorkflowIteration({
          state: this.state,
          options: this.options,
          getWorkflowName: () => this.config.name,
          getCurrentWorkflowStack: () => this.sharedRuntime.activeResumePoint?.stack,
          getCwd: () => this.cwd,
          getMaxSteps: () => this.maxSteps,
          getReportDir: () => this.runPaths.reportsAbs,
          abortRequested: () => this.abortRequested,
          getStep: this.stepCoordinator.getStep.bind(this.stepCoordinator),
          applyRuntimeEnvironment: (stage) => applyRuntimeEnvironment(this.cwd, this.config, stage),
          loopDetectorCheck: (stepName) => {
            const loopResult = this.loopDetector.check(stepName);
            return {
              shouldWarn: loopResult.shouldWarn ?? false,
              shouldAbort: loopResult.shouldAbort ?? false,
              count: loopResult.count,
              isLoop: loopResult.isLoop,
            };
          },
          cycleDetectorRecordAndCheck: (stepName) => this.cycleDetector.recordAndCheck(stepName),
          resolveDoneTransition: this.stepCoordinator.resolveTransitionFromDone.bind(this.stepCoordinator),
          runLoopMonitorJudge: this.stepCoordinator.runLoopMonitorJudge.bind(this.stepCoordinator),
          runStep: this.stepCoordinator.runStep.bind(this.stepCoordinator),
          runQualityGates,
          persistPreviousResponseSnapshot: this.stepExecutor.persistPreviousResponseSnapshot.bind(this.stepExecutor),
          buildInstruction: this.stepCoordinator.buildInstruction.bind(this.stepCoordinator),
          buildPhase1Instruction: this.stepCoordinator.buildPhase1Instruction.bind(this.stepCoordinator),
          resolveStepProviderModel: (step, runtime) => this.optionsBuilder.resolveStepProviderModel(step, runtime),
          resolveStepProviderModelBeforeAutoRouting: (step, runtime) => this.optionsBuilder.resolveStepProviderModelBeforeAutoRouting(step, runtime),
          resolveRuntimeForStep: this.stepCoordinator.resolveRuntimeForStep.bind(this.stepCoordinator),
          setActiveStep: this.setActiveResumePoint.bind(this),
          addUserInput: this.addUserInput.bind(this),
          emit: (event, ...args) => this.emit(event as never, ...args as []),
          updateMaxSteps: () => {},
          checkCompletionGate: this.checkCompletionGate.bind(this),
          checkReviewIntegrityGate: this.checkReviewIntegrityGate.bind(this),
          recordNeedsAdjudication: this.recordNeedsAdjudication.bind(this),
        }),
        (result) => ({
          status: result.isComplete ? this.state.status : 'running',
          abortKind: result.abort?.kind,
          abortReason: result.abort?.reason,
          failure: result.abort?.failure,
          nextStep: result.nextStep,
          iterations: this.state.iteration,
        }),
        (error) => this.buildWorkflowErrorSpanOutcome(error),
      ),
      (result, error) => error !== undefined || result?.isComplete === true || this.state.status !== 'running',
    );
  }
}
