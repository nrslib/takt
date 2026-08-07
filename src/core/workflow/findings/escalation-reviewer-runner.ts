/**
 * 格上げ再レビューの実行。findings-manager / terminal adjudication と同じく、
 * workflow の step としてではなく engine が合成ステップ経由で直接 provider call を
 * 発行し、その出力を通常の intake pipeline
 * （StepExecutor.prepareFindingReviewPublication → canonical publication →
 * findings-manager の取り込み）へ載せる。
 *
 * 起動条件は owner レビュアーが解決された runtime.yaml profile の `escalate` で、
 * 格上げ先モデルもその profile が指す先。owner ごとに persona / policy / knowledge /
 * report 形式が違うため、1ラウンドに複数 owner の最終枠が来た場合は owner ごとに
 * 1呼び出しへ分ける。
 *
 * 呼び出しタイミングは「全 owner reviewer の canonical publication が揃った後、
 * findings-manager の取り込み前」。owner publication は既に成立しているため、
 * escalation の失敗だけで owner の計上を巻き込まない。
 */
import type {
  AgentResponse,
  AgentWorkflowStep,
  WorkflowMaxSteps,
  WorkflowState,
} from '../../models/types.js';
import { executeAgent } from '../../../agents/agent-usecases.js';
import { createLogger } from '../../../shared/utils/index.js';
import { FINDING_ESCALATION_REVIEWER_ROUTING_KEY } from '../../models/finding-types.js';
import type { OptionsBuilder } from '../engine/OptionsBuilder.js';
import type { StepExecutor } from '../engine/StepExecutor.js';
import { reviewerOperationOrigin, runtimeForOperation } from '../engine/fallback-operation.js';
import type { RuntimeStepResolution, StepProviderInfo, StepRunResult } from '../types.js';
import { buildSessionKey } from '../session-key.js';
import type { FindingContractInstructionContext } from '../instruction/instruction-context.js';
import { buildFindingEscalationReviewerStep } from './escalation-reviewer-step.js';
import type { CanonicalFindingReviewPublication } from './review-publication.js';
import type { ReviewerRelationClarification } from './relation-coherence.js';
import type { RunAgentOptions } from '../../../agents/runner.js';

const log = createLogger('finding-escalation-reviewer');

/**
 * escalation reviewer は「レビュアー」であって manager ではない。対象コードを
 * 自分で読み、新規の byte-exact な引用証拠を作れなければ格上げの意味がないため、
 * 通常レビュアーの Phase 1 と同じ読み取り専用ツールセットを与える
 * （findings-manager の allowedTools: [] は流用しない）。
 *
 * permission mode だけは provider profile の既定に委ねず readonly で固定する。
 * 合成ステップは `edit: false` なので profile が edit を既定にしていても
 * 書き込み権限へ昇格させない。
 */
function buildEscalationReviewerAgentOptions(
  optionsBuilder: OptionsBuilder,
  escalationStep: AgentWorkflowStep,
  runtime: RuntimeStepResolution | undefined,
): RunAgentOptions {
  const options = {
    ...optionsBuilder.buildAgentOptions(escalationStep, runtime),
  } as RunAgentOptions & { permissionResolution?: unknown };
  delete options.permissionResolution;
  return {
    ...options,
    permissionMode: 'readonly',
  };
}

/**
 * 親ステップの runtime から escalation slot 用の runtime を導く。
 *
 * provider/model は格上げ先 profile で確定しているため、親（owner reviewer /
 * parallel 親）が持つ `providerInfo` の上書きは引き継がない。一方 rate-limit
 * fallback は透過させる — escalation reviewer 自身の operation を対象とする
 * fallback だけが `runtimeForOperation` によって providerInfo へ反映され、
 * 他 operation 向けの fallback はここで落ちる。
 */
function escalationReviewerRuntime(
  runtime: RuntimeStepResolution | undefined,
): RuntimeStepResolution | undefined {
  return runtimeForOperation(
    runtime === undefined ? undefined : { ...runtime, providerInfo: undefined },
    reviewerOperationOrigin(FINDING_ESCALATION_REVIEWER_ROUTING_KEY),
  );
}

export interface FindingEscalationPublishedResult {
  readonly step: AgentWorkflowStep;
  readonly publication: CanonicalFindingReviewPublication;
  readonly relationClarification?: ReviewerRelationClarification;
}

export type FindingEscalationReviewerOutcome =
  | {
      readonly kind: 'published';
      readonly results: readonly FindingEscalationPublishedResult[];
    }
  | {
      readonly kind: 'terminal';
      readonly step: AgentWorkflowStep;
      readonly response: AgentResponse;
      readonly providerInfo?: StepProviderInfo;
      readonly terminalOperation?: NonNullable<StepRunResult['terminalOperation']>;
    };

export interface FindingEscalationReviewerInput {
  /** FC 台帳へ寄稿する owner reviewer step 群。格上げ先は各 step の解決結果から決まる。 */
  readonly ownerReviewerSteps: readonly AgentWorkflowStep[];
  /**
   * owner step 名ごとの escalation slot 専用 context。今ラウンドに格上げ対象の
   * anomaly が無い owner は含まれない。含まれない owner でも、前ラウンドで
   * 永続化済みの escalation publication があれば resume して返す
   * （提示は計上済みなので request は作られないが、raw findings はまだ
   * manager へ渡っていない）。
   */
  readonly escalationContexts: ReadonlyMap<string, FindingContractInstructionContext>;
  readonly parentStepName: string;
  readonly stepIteration: number;
  readonly state: WorkflowState;
  readonly task: string;
  readonly maxSteps: WorkflowMaxSteps;
  readonly optionsBuilder: OptionsBuilder;
  readonly stepExecutor: StepExecutor;
  readonly updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
  readonly runtime?: RuntimeStepResolution;
}

/**
 * runPreparedManagerAttempt と同形の直接 provider call。usage 計上も manager と
 * 揃えて、合成ステップの LLM 呼び出しをトークン集計の死角にしない。
 */
export async function runEscalationReviewerAttempt(input: {
  readonly escalationStep: AgentWorkflowStep;
  readonly phase1Instruction: string;
  /** この呼び出しが実際に使う provider/model。usage event へそのまま計上する。 */
  readonly providerInfo: StepProviderInfo;
  readonly optionsBuilder: OptionsBuilder;
  readonly stepExecutor: Pick<StepExecutor, 'recordSynthesizedAgentUsage'>;
  readonly runtime?: RuntimeStepResolution;
}): Promise<AgentResponse> {
  const agentOptions = buildEscalationReviewerAgentOptions(
    input.optionsBuilder,
    input.escalationStep,
    input.runtime,
  );
  let response: AgentResponse;
  try {
    response = await executeAgent(
      input.escalationStep.persona,
      input.phase1Instruction,
      agentOptions,
    );
  } catch (error) {
    input.stepExecutor.recordSynthesizedAgentUsage(
      input.escalationStep,
      false,
      undefined,
      input.providerInfo,
    );
    throw error;
  }
  input.stepExecutor.recordSynthesizedAgentUsage(
    input.escalationStep,
    response.status === 'done',
    response.providerUsage,
    input.providerInfo,
  );
  return response;
}

/**
 * owner ごとの格上げ再レビューを順に実行する。1件でも terminal になった時点で
 * 打ち切り、それまでに成立した publication は返さない（親ステップが terminal に
 * なるため manager 取り込み自体が走らない）。
 */
export async function runFindingEscalationReviewer(
  input: FindingEscalationReviewerInput,
): Promise<FindingEscalationReviewerOutcome | undefined> {
  const results: FindingEscalationPublishedResult[] = [];
  for (const ownerStep of input.ownerReviewerSteps) {
    const escalation = input.optionsBuilder.resolveStepProviderModel(ownerStep).escalation;
    if (escalation === undefined) {
      continue;
    }
    const outcome = await runFindingEscalationReviewerForOwner({
      ...input,
      ownerStep,
      escalation,
    });
    if (outcome === undefined) {
      continue;
    }
    if (outcome.kind === 'terminal') {
      return outcome;
    }
    results.push(...outcome.results);
  }
  return results.length === 0 ? undefined : { kind: 'published', results };
}

async function runFindingEscalationReviewerForOwner(
  input: FindingEscalationReviewerInput & {
    readonly ownerStep: AgentWorkflowStep;
    readonly escalation: NonNullable<StepProviderInfo['escalation']>;
  },
): Promise<FindingEscalationReviewerOutcome | undefined> {
  const escalationStep = buildFindingEscalationReviewerStep({
    ownerStep: input.ownerStep,
    escalation: input.escalation,
  });
  const runtime = escalationReviewerRuntime(input.runtime);
  const escalationContext = input.escalationContexts.get(input.ownerStep.name);

  // 提示予算を使い切った anomaly でも、前ラウンドの escalation publication が
  // 未取り込みのまま残ることがある（publication 成立後 / manager commit 前の crash）。
  // request の有無より先に stored publication を引き当てないと、
  // 「予算は消費済みなのに証拠は一度も intake されない」状態で終端する。
  const resumed = await input.stepExecutor.resumeFindingReviewPublication({
    step: escalationStep,
    parentStepName: input.parentStepName,
    stepIteration: input.stepIteration,
    state: input.state,
    runtime,
    ...(escalationContext?.reviewer?.presentationContext === undefined
      ? {}
      : { presentationContext: escalationContext.reviewer.presentationContext }),
  });
  if (resumed !== undefined && 'reportRejection' in resumed) {
    // 保存済みの格上げ報告も報告側の契約を満たさなかった。resume 側で保存記録は
    // 破棄済みなので、ここで打ち切らず新規生成の経路へ落とす。打ち切ると同じ
    // stored 報告を読み続けて格上げ枠が永久に塞がる。
    log.warn('Stored escalated re-review report could not be bound to its own text; regenerating', {
      step: escalationStep.name,
      owner: input.ownerStep.name,
      reason: resumed.reportRejection.reason,
    });
  } else if (resumed !== undefined) {
    if ('terminalResponse' in resumed) {
      return {
        kind: 'terminal',
        step: escalationStep,
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
      results: [{
        step: escalationStep,
        publication: resumed.publication,
        ...(resumed.relationClarification === undefined
          ? {}
          : { relationClarification: resumed.relationClarification }),
      }],
    };
  }
  if (escalationContext === undefined) {
    return undefined;
  }

  const presentationContext = escalationContext.reviewer?.presentationContext;
  const instruction = input.stepExecutor.buildInstruction(
    escalationStep,
    input.stepIteration,
    input.state,
    input.task,
    input.maxSteps,
    undefined,
    { mode: 'explicit', context: escalationContext },
  );
  const phase1Instruction = input.stepExecutor.buildPhase1Instruction(
    instruction,
    escalationStep,
    runtime,
  );
  const providerInfo = input.optionsBuilder.resolveStepProviderModel(escalationStep, runtime);
  const phase1Response = await runEscalationReviewerAttempt({
    escalationStep,
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
      buildSessionKey(escalationStep, {
        provider: providerInfo.provider,
        model: providerInfo.model,
      }),
      phase1Response.sessionId,
    );
  }
  if (phase1Response.status !== 'done') {
    return {
      kind: 'terminal',
      step: escalationStep,
      response: phase1Response,
      providerInfo,
      // blocked / rate_limited は既存の継続・fallback 経路が operation 単位で扱う。
      ...(phase1Response.status === 'blocked' || phase1Response.status === 'rate_limited'
        ? {
            terminalOperation: {
              origin: reviewerOperationOrigin(escalationStep.name),
              providerInfo,
            },
          }
        : {}),
    };
  }

  const prepared = await input.stepExecutor.prepareFindingReviewPublication({
    step: escalationStep,
    executableStep: escalationStep,
    parentStepName: input.parentStepName,
    stepIteration: input.stepIteration,
    state: input.state,
    phase1Response,
    agentOptions: buildEscalationReviewerAgentOptions(input.optionsBuilder, escalationStep, runtime),
    // Phase 2 も escalation slot の restatement-only 契約で動かす。既定の
    // context 再構築（reviewer 名でフィルタ）では request が0件になり、
    // Phase 2 の指示が通常レビュー契約へ化ける。
    findingContractContext: escalationContext,
    // report phase の fallback で provider が切り替わっても、実際に走った
    // attempt の provider/model をそのまま計上する。
    onProviderAttempt: (attemptProviderInfo, success, usage) => {
      input.stepExecutor.recordSynthesizedAgentUsage(
        escalationStep,
        success,
        usage,
        attemptProviderInfo,
      );
    },
    updatePersonaSession: input.updatePersonaSession,
    runtime,
    presentationContext,
  });
  if ('terminalResponse' in prepared) {
    return {
      kind: 'terminal',
      step: escalationStep,
      response: prepared.terminalResponse,
      providerInfo: prepared.reviewerProviderInfo ?? providerInfo,
      ...(prepared.terminalOperation === undefined
        ? {}
        : { terminalOperation: prepared.terminalOperation }),
    };
  }
  if ('reportRejection' in prepared) {
    // 格上げ先も報告側の契約（通常の markdown 散文）を満たさなかった。owner 側と
    // 違って専用の anomaly は積まない（意図的な非対称）:
    //   - 格上げは owner anomaly の最終提示枠なので、寄稿ゼロなら presentedCount が
    //     増えず、同じ request が次ラウンドで再発行される（stop_budget と
    //     review_budget が有限停止を保証する）。
    //   - 是正文言（「通常の markdown 散文で書き直せ」）は owner の anomaly サマリ
    //     経由で届くため、ここで別 anomaly を積むと同じラウンドの同じ主張が
    //     二重計上される。
    log.warn('Escalated re-review report could not be bound to its own text; contributing nothing', {
      step: escalationStep.name,
      owner: input.ownerStep.name,
      reason: prepared.reportRejection.reason,
    });
    return undefined;
  }
  return {
    kind: 'published',
    results: [{
      step: escalationStep,
      publication: prepared.publication,
      ...(prepared.relationClarification === undefined
        ? {}
        : { relationClarification: prepared.relationClarification }),
    }],
  };
}
