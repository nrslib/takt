/**
 * レビュアーの差し戻し slot の実行。
 *
 * レビュアー由来の未決着（言い直し待ちの intake anomaly と、後続の完全レビュー
 * 成立でしか決着しない anomaly）は「次のレビューラウンドに相乗りさせる」のでは
 * なく、レビューラウンドの findings-manager 取り込みが終わった直後に、当該
 * レビュアーごとの直接 provider call として差し戻す。findings-manager /
 * terminal adjudication と同じく workflow の step ではなく、engine が合成した
 * ステップ経由で executeAgent を呼び、その出力を通常の intake pipeline
 * （StepExecutor.prepareFindingReviewPublication → canonical publication →
 * findings-manager の取り込み）へ載せる。
 *
 * 1回の差し戻しは「呼び出し → 正規化 → manager 取り込み」で1パス。まだ言い直し
 * 待ちが残っていれば同じレビューラウンド内で次のパスへ進み、提示予算
 * （presentationLimit）まで反復する。最終枠（presentedCount === presentationLimit - 1）
 * は owner が解決された profile の `escalate` 先へ格上げする。
 *
 * owner ごとに persona / policy / knowledge / report 形式が違うため、1 owner =
 * 1呼び出しに分ける。
 */
import type {
  AgentResponse,
  AgentWorkflowStep,
  WorkflowMaxSteps,
  WorkflowState,
} from '../../models/types.js';
import { executeAgent } from '../../../agents/agent-usecases.js';
import { createLogger } from '../../../shared/utils/index.js';
import type { OptionsBuilder } from '../engine/OptionsBuilder.js';
import type { StepExecutor } from '../engine/StepExecutor.js';
import { reviewerOperationOrigin, runtimeForOperation } from '../engine/fallback-operation.js';
import type { RuntimeStepResolution, StepProviderInfo, StepRunResult } from '../types.js';
import { buildSessionKey } from '../session-key.js';
import type { FindingContractInstructionContext } from '../instruction/instruction-context.js';
import {
  buildFindingRestatementSlotStep,
  resolveFindingEscalationTarget,
  type RestatementSlotMode,
  type RestatementSlotPhase,
  type RestatementSlotProviderTarget,
} from './restatement-slot-step.js';
import type { InternalAgentSeats } from '../../models/config-types.js';
import type { FindingManagerSubStepResult } from './manager-intake.js';
import type { RunAgentOptions } from '../../../agents/runner.js';
import type { FindingEvidenceSearchRequest } from './evidence-search.js';
import type { FindingEvidenceSearchRunResult } from '../engine/StepExecutor.js';

const log = createLogger('finding-restatement-slot');

/**
 * slot のレビュアーは「レビュアー」であって manager ではない。対象コードを
 * 自分で読み、新規の byte-exact な引用証拠を作れなければ言い直しの意味がないため、
 * 通常レビュアーの Phase 1 と同じ読み取り専用ツールセットを与える
 * （findings-manager の allowedTools: [] は流用しない）。
 *
 * permission mode だけは provider profile の既定に委ねず readonly で固定する。
 * 合成ステップは `edit: false` なので profile が edit を既定にしていても
 * 書き込み権限へ昇格させない。
 */
function buildRestatementSlotAgentOptions(
  optionsBuilder: OptionsBuilder,
  slotStep: AgentWorkflowStep,
  runtime: RuntimeStepResolution | undefined,
): RunAgentOptions {
  const options = {
    ...optionsBuilder.buildAgentOptions(slotStep, runtime),
  } as RunAgentOptions & { permissionResolution?: unknown };
  delete options.permissionResolution;
  return {
    ...options,
    permissionMode: 'readonly',
  };
}

/**
 * 親ステップの runtime から slot 用の runtime を導く。
 *
 * provider/model は呼び出し側で確定しているため、親（owner reviewer / parallel
 * 親）が持つ `providerInfo` の上書きは引き継がない。一方 rate-limit fallback は
 * 透過させる — slot 自身の operation を対象とする fallback だけが
 * `runtimeForOperation` によって providerInfo へ反映され、他 operation 向けの
 * fallback はここで落ちる。
 */
function slotRuntime(
  runtime: RuntimeStepResolution | undefined,
  slotStepName: string,
): RuntimeStepResolution | undefined {
  return runtimeForOperation(
    runtime === undefined ? undefined : { ...runtime, providerInfo: undefined },
    reviewerOperationOrigin(slotStepName),
  );
}

/** owner1件分の、今パスで発行する呼び出し context。対象が無い枠は含まれない。 */
export interface FindingRestatementSlotOwnerContexts {
  /**
   * owner 宛の呼び出し。intake anomaly の言い直し request と、非 intake anomaly の
   * 再レビューを兼ねる。どちらの理由も無い owner には付かない。
   */
  readonly owner?: FindingContractInstructionContext;
  /**
   * この owner に、後続の完全レビュー成立でしか決着しない anomaly
   * （protocol-anomaly / verdict-claims-mismatch / 報告拒否由来）が残っているか。
   * 残っているなら owner 宛の呼び出しは完全な再レビューでなければならない —
   * 言い直しだけの publication で取り下げが走ると、決着の前提が偽になる。
   */
  readonly ownerNeedsFullReview: boolean;
  /** 提示予算の最終枠。格上げ先モデルで言い直しだけを行う。 */
  readonly escalation?: FindingContractInstructionContext;
}

export interface FindingRestatementSlotTerminalOutcome {
  readonly kind: 'terminal';
  readonly step: AgentWorkflowStep;
  readonly response: AgentResponse;
  readonly providerInfo?: StepProviderInfo;
  readonly terminalOperation?: NonNullable<StepRunResult['terminalOperation']>;
}

export interface FindingRestatementSlotInput {
  /** FC 台帳へ寄稿する owner reviewer step 群。dynamic facets 適用後の実行用ステップ。 */
  readonly ownerReviewerSteps: readonly AgentWorkflowStep[];
  /**
   * そのパスで発行する提示 context を owner 名ごとに組む。呼ぶたびに台帳と
   * 提示回数を読み直すこと（前パスの publication と manager 取り込みの結果を
   * 次のパスの判定に反映するため）。
   */
  readonly buildSlotContexts: (input: {
    readonly ownerReviewerSteps: readonly AgentWorkflowStep[];
    readonly reviewScopeSnapshotId: string;
  }) => ReadonlyMap<string, FindingRestatementSlotOwnerContexts>;
  /** 1パス分の publication を findings-manager へ取り込む。 */
  readonly ingest: (
    results: readonly FindingManagerSubStepResult[],
    options?: { deferClaimBearingTerminalDispositions?: boolean },
  ) => Promise<void>;
  /** 言い直し予算を使い切った anomaly ごとの、engine-owned evidence-search 入力。 */
  readonly buildEvidenceSearchRequests?: (input: {
    ownerReviewerSteps: readonly AgentWorkflowStep[];
    reviewScopeSnapshotId: string;
  }) => readonly FindingEvidenceSearchRequest[];
  readonly reviewScopeSnapshotId: string;
  readonly parentStepName: string;
  readonly stepIteration: number;
  readonly state: WorkflowState;
  readonly task: string;
  readonly maxSteps: WorkflowMaxSteps;
  readonly optionsBuilder: OptionsBuilder;
  readonly stepExecutor: StepExecutor;
  readonly updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
  readonly runtime?: RuntimeStepResolution;
  /** runtime.yaml internal_agents の解決済み seat。`escalation-reviewer` seat を消費する。 */
  readonly internalAgentSeats?: InternalAgentSeats;
  /** 提示予算。1 anomaly はこの回数までしか提示されないので、パス数の上限でもある。 */
  readonly presentationLimit: number;
}

/**
 * runPreparedManagerAttempt と同形の直接 provider call。usage 計上も manager と
 * 揃えて、合成ステップの LLM 呼び出しをトークン集計の死角にしない。
 */
export async function runRestatementSlotAttempt(input: {
  readonly slotStep: AgentWorkflowStep;
  readonly phase1Instruction: string;
  /** この呼び出しが実際に使う provider/model。usage event へそのまま計上する。 */
  readonly providerInfo: StepProviderInfo;
  readonly optionsBuilder: OptionsBuilder;
  readonly stepExecutor: Pick<StepExecutor, 'recordSynthesizedAgentUsage'>;
  readonly runtime?: RuntimeStepResolution;
}): Promise<AgentResponse> {
  const agentOptions = buildRestatementSlotAgentOptions(
    input.optionsBuilder,
    input.slotStep,
    input.runtime,
  );
  let response: AgentResponse;
  try {
    response = await executeAgent(
      input.slotStep.persona,
      input.phase1Instruction,
      agentOptions,
    );
  } catch (error) {
    input.stepExecutor.recordSynthesizedAgentUsage(
      input.slotStep,
      false,
      undefined,
      input.providerInfo,
    );
    throw error;
  }
  input.stepExecutor.recordSynthesizedAgentUsage(
    input.slotStep,
    response.status === 'done',
    response.providerUsage,
    input.providerInfo,
  );
  return response;
}

/**
 * slot をレビューラウンド内でインライン反復する。
 *
 * 終了条件は3つ:
 *   1. そのパスで publication が1件も成立しない — 新しい提示も、保存済み
 *      publication の引き当ても無い（差し戻し対象が無い / 全 owner が報告側原因で
 *      寄稿できなかった）
 *   2. 提示予算（presentationLimit）に達した
 *   3. どれかの呼び出しが terminal（provider error / blocked / rate limited）
 *
 * presentationLimit 到達後の claim-bearing anomaly には、終端処分へ進む前に
 * evidence-search を1 anomaly 1回だけ挿入する。これは slot の budget-excluded
 * 取り込みとして通常 admission へ渡される。
 *
 * terminal はその時点までの publication を manager へ渡してから返す
 * （親ステップが terminal になっても、永続化済みの成功分は失わない）。
 */
export async function runFindingRestatementSlot(
  input: FindingRestatementSlotInput,
): Promise<FindingRestatementSlotTerminalOutcome | undefined> {
  if (input.ownerReviewerSteps.length === 0) {
    return undefined;
  }
  // 非 intake anomaly の再レビューは専用の提示予算を持たないため、1ラウンドに
  // レビュアーごと1回までに制限する。1回で決着しなかった分は次ラウンドの slot へ
  // 回り、全体の有限性は review_budget が保つ。
  const fullReviewIssued = new Set<string>();
  const runEvidenceSearch = async (): Promise<FindingRestatementSlotTerminalOutcome | undefined> => {
    const requests = input.buildEvidenceSearchRequests?.({
      ownerReviewerSteps: input.ownerReviewerSteps,
      reviewScopeSnapshotId: input.reviewScopeSnapshotId,
    }) ?? [];
    if (requests.length === 0) {
      return;
    }
    const ownerStepsByName = new Map(input.ownerReviewerSteps.map((step) => [step.name, step] as const));
    const results: FindingManagerSubStepResult[] = [];
    for (const request of requests) {
      const ownerStep = ownerStepsByName.get(request.ownerReviewerStepName);
      if (ownerStep === undefined) {
        log.warn('Dropping an evidence-search request whose owner step is not in the active review set', {
          ownerReviewerStepName: request.ownerReviewerStepName,
          anomalyId: request.request.anomalyId,
          restatementRequestId: request.request.restatementRequestId,
        });
        continue;
      }
      const outcome: FindingEvidenceSearchRunResult = await input.stepExecutor.runFindingEvidenceSearch({
        ownerStep,
        parentStepName: input.parentStepName,
        stepIteration: input.stepIteration,
        state: input.state,
        reviewScopeSnapshotId: input.reviewScopeSnapshotId,
        request,
        runtime: input.runtime,
      });
      if (outcome.kind === 'terminal') {
        if (results.length > 0) {
          await input.ingest(results, { deferClaimBearingTerminalDispositions: false });
        }
        return {
          kind: 'terminal',
          step: ownerStep,
          response: outcome.response,
          providerInfo: outcome.providerInfo,
          ...(outcome.terminalOperation === undefined
            ? {}
            : { terminalOperation: outcome.terminalOperation }),
        };
      }
      if (outcome.kind === 'published') {
        results.push(outcome.result);
      }
    }
    if (results.length > 0) {
      await input.ingest(results, { deferClaimBearingTerminalDispositions: false });
    }
    return undefined;
  };
  for (let pass = 1; pass <= input.presentationLimit; pass += 1) {
    const contexts = input.buildSlotContexts({
      ownerReviewerSteps: input.ownerReviewerSteps,
      reviewScopeSnapshotId: input.reviewScopeSnapshotId,
    });
    const passResults: FindingManagerSubStepResult[] = [];
    for (const ownerStep of input.ownerReviewerSteps) {
      const ownerContexts = contexts.get(ownerStep.name);
      // 再レビュー枠を1ラウンドに1回へ制限する。使い切った後も言い直しは出せる —
      // restatement-only の publication は「完全なレビューが成立した」証跡に
      // ならないので（establishesCompleteReview: false）、未決着の非 intake
      // anomaly を取り下げてしまう心配がない。
      const needsFullReview = ownerContexts?.ownerNeedsFullReview === true
        && !fullReviewIssued.has(ownerStep.name);
      // 再レビュー枠を使い切り、言い直し request も無い owner には出す用がない。
      // context の有無だけで判断すると、決着しない非 intake anomaly を持つ owner へ
      // 中身の無い呼び出しを提示予算いっぱいまで発行し続ける。
      const ownerRequestCount = requestCountOf(ownerContexts?.owner);
      const ownerContext = needsFullReview || ownerRequestCount > 0
        ? ownerContexts?.owner
        : undefined;
      const ownerOutcome = await runSlotPresentation({
        ...input,
        ownerStep,
        phase: 'restatement',
        mode: needsFullReview ? 'full-review' : 'restatement-only',
        presentationPass: pass,
        ...(ownerContext === undefined ? {} : { context: ownerContext }),
      });
      if (ownerOutcome?.kind === 'terminal') {
        if (passResults.length > 0) {
          await input.ingest(passResults, { deferClaimBearingTerminalDispositions: true });
        }
        return ownerOutcome;
      }
      if (ownerOutcome !== undefined) {
        // 保存済み publication の引き当てでも、その再レビューは実際に行われている。
        // 枠を使っていない扱いにすると resume のたびにもう一度発行してしまう。
        if (needsFullReview) {
          fullReviewIssued.add(ownerStep.name);
        }
        passResults.push(ownerOutcome.result);
      }

      const escalationContext = ownerContexts?.escalation;
      const escalationOutcome = await runSlotPresentation({
        ...input,
        ownerStep,
        phase: 'escalation',
        mode: 'restatement-only',
        presentationPass: pass,
        ...(escalationContext === undefined ? {} : { context: escalationContext }),
      });
      if (escalationOutcome?.kind === 'terminal') {
        if (passResults.length > 0) {
          await input.ingest(passResults, { deferClaimBearingTerminalDispositions: true });
        }
        return escalationOutcome;
      }
      if (escalationOutcome !== undefined) {
        passResults.push(escalationOutcome.result);
      }
    }
    // 新しい提示も保存済み publication の引き当ても無いパスで終わる。ここで
    // 「新しい提示が無い」だけを終了条件にすると、中断した run の pass 2 以降に
    // 残った publication が恒久的に孤児化する（提示予算は消費済みなのに証拠が
    // 台帳へ届かない）。
    if (passResults.length === 0) {
      return await runEvidenceSearch();
    }
    await input.ingest(passResults, { deferClaimBearingTerminalDispositions: true });
  }
  return await runEvidenceSearch();
}

/** その context が実際に載せている言い直し request の件数。 */
function requestCountOf(context: FindingContractInstructionContext | undefined): number {
  const presentation = context?.reviewer?.presentationContext;
  return presentation?.revision === 2 ? presentation.restatementRequests.length : 0;
}

/** 合成ステップの mode を指示文側の契約へ写す。 */
function instructionModeFor(mode: RestatementSlotMode): 'review' | 'restatement-only' {
  return mode === 'full-review' ? 'review' : 'restatement-only';
}

/**
 * その呼び出しの publication が後続レビューとして何を成立させたか。
 *
 * slot のフルレビューは判定ラダーを持たない（rules: []）ので verdict を伴わない。
 * verdict 由来の anomaly はここでは決着しない。
 */
function reviewEvidenceFor(mode: 'review' | 'restatement-only'): 'review' | 'none' {
  return mode === 'review' ? 'review' : 'none';
}

type SlotPresentationOutcome =
  | { readonly kind: 'published'; readonly result: FindingManagerSubStepResult }
  | FindingRestatementSlotTerminalOutcome;

/**
 * 提示1回分。`context` が無くても保存済み publication の引き当ては試みる —
 * 前ラウンドで永続化済みなのに manager へ渡っていない publication があると、
 * 「提示予算は消費済みなのに証拠は一度も intake されない」状態で終端するため。
 */
async function runSlotPresentation(
  input: FindingRestatementSlotInput & {
    readonly ownerStep: AgentWorkflowStep;
    readonly phase: RestatementSlotPhase;
    readonly mode: RestatementSlotMode;
    readonly presentationPass: number;
    readonly context?: FindingContractInstructionContext;
  },
): Promise<SlotPresentationOutcome | undefined> {
  const target = resolveSlotProviderTarget(input);
  if (target === undefined) {
    return undefined;
  }
  const slotStep = buildFindingRestatementSlotStep({
    ownerStep: input.ownerStep,
    phase: input.phase,
    mode: input.mode,
    presentationPass: input.presentationPass,
    target,
  });
  const runtime = slotRuntime(input.runtime, slotStep.name);
  const presentationContext = input.context?.reviewer?.presentationContext;

  const resumed = await input.stepExecutor.resumeFindingReviewPublication({
    step: slotStep,
    parentStepName: input.parentStepName,
    stepIteration: input.stepIteration,
    state: input.state,
    runtime,
    reviewerCallMode: instructionModeFor(input.mode),
    ...(presentationContext === undefined ? {} : { presentationContext }),
  });
  if (resumed !== undefined && 'reportRejection' in resumed) {
    // 保存済みの言い直し報告も報告側の契約を満たさなかった。resume 側で保存記録は
    // 破棄済みなので、ここで打ち切らず新規生成の経路へ落とす。打ち切ると同じ
    // stored 報告を読み続けて提示枠が永久に塞がる。
    log.warn('Stored restatement report could not be bound to its own text; regenerating', {
      step: slotStep.name,
      owner: input.ownerStep.name,
      phase: input.phase,
      reason: resumed.reportRejection.reason,
    });
  } else if (resumed !== undefined) {
    if ('terminalResponse' in resumed) {
      return {
        kind: 'terminal',
        step: slotStep,
        response: resumed.terminalResponse,
        ...(resumed.reviewerProviderInfo === undefined
          ? {}
          : { providerInfo: resumed.reviewerProviderInfo }),
        ...(resumed.terminalOperation === undefined
          ? {}
          : { terminalOperation: resumed.terminalOperation }),
      };
    }
    return {
      kind: 'published',
      result: {
        subStep: slotStep,
        publication: resumed.publication,
        // 引き当てた publication を出した呼び出しの mode を採用する。今回の
        // input.mode を被せると、言い直しだけで出た publication が再開後に
        // フルレビューの証拠として withdrawal を発火し得る。
        reviewEvidence: reviewEvidenceFor(
          resumed.reviewerCallMode ?? instructionModeFor(input.mode),
        ),
        ...(resumed.relationClarification === undefined
          ? {}
          : { relationClarification: resumed.relationClarification }),
      },
    };
  }
  const context = input.context;
  if (context === undefined) {
    return undefined;
  }
  // 「言い直しのみ」か「レビューに加えて言い直しも」かは request 件数からは
  // 導けない。呼び出し側の mode をそのまま指示文と withdrawal 判定へ渡す。
  const modedContext: FindingContractInstructionContext = context.reviewer === undefined
    ? context
    : { ...context, reviewer: { ...context.reviewer, mode: instructionModeFor(input.mode) } };

  const instruction = input.stepExecutor.buildInstruction(
    slotStep,
    input.stepIteration,
    input.state,
    input.task,
    input.maxSteps,
    undefined,
    { mode: 'explicit', context: modedContext },
  );
  const phase1Instruction = input.stepExecutor.buildPhase1Instruction(
    instruction,
    slotStep,
    runtime,
  );
  const providerInfo = input.optionsBuilder.resolveStepProviderModel(slotStep, runtime);
  const phase1Response = await runRestatementSlotAttempt({
    slotStep,
    phase1Instruction,
    providerInfo,
    optionsBuilder: input.optionsBuilder,
    stepExecutor: input.stepExecutor,
    runtime,
  });
  // Phase 1 は sessionId を渡さず必ず新規セッションで開始するため、Phase 2 が
  // 同じセッションを再開できるようここで登録する。
  if (phase1Response.sessionId !== undefined) {
    input.updatePersonaSession(
      buildSessionKey(slotStep, {
        provider: providerInfo.provider,
        model: providerInfo.model,
      }),
      phase1Response.sessionId,
    );
  }
  if (phase1Response.status !== 'done') {
    return {
      kind: 'terminal',
      step: slotStep,
      response: phase1Response,
      providerInfo,
      // blocked / rate_limited は既存の継続・fallback 経路が operation 単位で扱う。
      ...(phase1Response.status === 'blocked' || phase1Response.status === 'rate_limited'
        ? {
            terminalOperation: {
              origin: reviewerOperationOrigin(slotStep.name),
              providerInfo,
            },
          }
        : {}),
    };
  }

  const prepared = await input.stepExecutor.prepareFindingReviewPublication({
    step: slotStep,
    executableStep: slotStep,
    // publication へ永続化し、以後の resume はこの値を採用する。
    reviewerCallMode: instructionModeFor(input.mode),
    parentStepName: input.parentStepName,
    stepIteration: input.stepIteration,
    state: input.state,
    phase1Response,
    agentOptions: buildRestatementSlotAgentOptions(input.optionsBuilder, slotStep, runtime),
    // Phase 2 も slot の restatement-only 契約で動かす。既定の context 再構築
    // （reviewer 名でフィルタ）では request が0件になり、Phase 2 の指示が通常
    // レビュー契約へ化ける。
    findingContractContext: modedContext,
    // report phase の fallback で provider が切り替わっても、実際に走った
    // attempt の provider/model をそのまま計上する。
    onProviderAttempt: (attemptProviderInfo, success, usage) => {
      input.stepExecutor.recordSynthesizedAgentUsage(
        slotStep,
        success,
        usage,
        attemptProviderInfo,
      );
    },
    updatePersonaSession: input.updatePersonaSession,
    runtime,
    ...(presentationContext === undefined ? {} : { presentationContext }),
  });
  if ('terminalResponse' in prepared) {
    return {
      kind: 'terminal',
      step: slotStep,
      response: prepared.terminalResponse,
      providerInfo: prepared.reviewerProviderInfo ?? providerInfo,
      ...(prepared.terminalOperation === undefined
        ? {}
        : { terminalOperation: prepared.terminalOperation }),
    };
  }
  if ('reportRejection' in prepared) {
    // 言い直しの報告が報告側の契約（通常の markdown 散文）を満たさなかった。
    // owner のレビュー本編と違って専用の anomaly は積まない（意図的な非対称）:
    //   - 寄稿ゼロなら presentedCount が増えず、同じ request が次の機会に
    //     再発行される（presentationLimit と stop_budget が有限停止を保証する）。
    //   - 是正文言（「通常の markdown 散文で書き直せ」）は owner の anomaly サマリ
    //     経由で届くため、ここで別 anomaly を積むと同じ主張が二重計上される。
    log.warn('Restatement report could not be bound to its own text; contributing nothing', {
      step: slotStep.name,
      owner: input.ownerStep.name,
      phase: input.phase,
      reason: prepared.reportRejection.reason,
    });
    return undefined;
  }
  return {
    kind: 'published',
    result: {
      subStep: slotStep,
      publication: prepared.publication,
      // 言い直しだけの publication は withdrawal の根拠にしない。保存済みを
      // 引き当てた場合も、その publication を出した呼び出しの mode に従う。
      reviewEvidence: reviewEvidenceFor(
        prepared.reviewerCallMode ?? instructionModeFor(input.mode),
      ),
      ...(prepared.relationClarification === undefined
        ? {}
        : { relationClarification: prepared.relationClarification }),
    },
  };
}

/**
 * その提示が使う provider/model。
 *
 * - `restatement`: owner が解決した provider/model をそのまま使う
 * - `escalation`: `escalation-reviewer` seat、無ければ owner が解決された profile の
 *   `escalate` 先。どちらも持たない owner は最終枠も通常の言い直しになるので、
 *   この提示自体が発生しない
 *
 * どちらも runtime を渡さずに解決する。rate-limit fallback で一時的に別 provider
 * へ振られていても、代打の宛先は構成上の解決結果から決まる値であり、提示フェーズの
 * 判定（WorkflowEngineSetup）と同じ基準にそろえるため。
 */
function resolveSlotProviderTarget(input: {
  readonly ownerStep: AgentWorkflowStep;
  readonly phase: RestatementSlotPhase;
  readonly optionsBuilder: OptionsBuilder;
  readonly internalAgentSeats?: InternalAgentSeats;
}): RestatementSlotProviderTarget | undefined {
  const ownerProviderInfo = input.optionsBuilder.resolveStepProviderModel(input.ownerStep);
  if (input.phase === 'escalation') {
    return resolveFindingEscalationTarget({
      seat: input.internalAgentSeats?.escalationReviewer,
      escalation: ownerProviderInfo.escalation,
    });
  }
  if (ownerProviderInfo.provider === undefined) {
    throw new Error(
      `Finding contract reviewer "${input.ownerStep.name}" has no resolved provider for restatement`,
    );
  }
  return {
    provider: ownerProviderInfo.provider,
    ...(ownerProviderInfo.model === undefined ? {} : { model: ownerProviderInfo.model }),
    ...(ownerProviderInfo.providerOptions === undefined
      ? {}
      : { providerOptions: ownerProviderInfo.providerOptions }),
  };
}
