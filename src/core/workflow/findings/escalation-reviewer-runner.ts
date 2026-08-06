/**
 * escalation reviewer の実行。findings-manager / terminal adjudication と同じく、
 * workflow の step としてではなく engine が合成ステップ経由で直接 provider call を
 * 発行し、その出力を通常の intake pipeline
 * （StepExecutor.prepareFindingReviewPublication → canonical publication →
 * findings-manager の取り込み）へ載せる。
 *
 * 呼び出しタイミングは「全 owner reviewer の canonical publication が揃った後、
 * findings-manager の取り込み前」。owner publication は既に成立しているため、
 * escalation の失敗だけで owner の計上を巻き込まない。
 */
import type {
  AgentResponse,
  AgentWorkflowStep,
  FindingContractConfig,
  WorkflowConfig,
  WorkflowMaxSteps,
  WorkflowState,
} from '../../models/types.js';
import { executeAgent } from '../../../agents/agent-usecases.js';
import { FINDING_ESCALATION_REVIEWER_ROUTING_KEY } from '../../models/finding-types.js';
import type { OptionsBuilder } from '../engine/OptionsBuilder.js';
import type { StepExecutor } from '../engine/StepExecutor.js';
import { reviewerOperationOrigin, runtimeForOperation } from '../engine/fallback-operation.js';
import type { RuntimeStepResolution, StepProviderInfo, StepRunResult } from '../types.js';
import { buildSessionKey } from '../session-key.js';
import type { FindingContractInstructionContext } from '../instruction/instruction-context.js';
import { withFindingContractStructuredOutput } from './contract-intake.js';
import {
  buildFindingEscalationReviewerStep,
  requireEscalationOwnerOutputContractFormat,
} from './escalation-reviewer-step.js';
import type { CanonicalFindingReviewPublication } from './review-publication.js';
import type { ReviewerRelationClarification } from './relation-coherence.js';
import type { RunAgentOptions } from '../../../agents/runner.js';

/** escalation reviewer の出力 strategy は owner step によらず structured raw findings で固定。 */
const ESCALATION_REVIEWER_OUTPUT_STRATEGY = Object.freeze({
  kind: 'structured',
  reportGeneration: 'structured',
  intake: 'reviewer_structured',
} as const);

/**
 * escalation reviewer は「レビュアー」であって manager ではない。対象コードを
 * 自分で読み、新規の byte-exact な引用証拠を作れなければ格上げの意味がないため、
 * 通常レビュアーの Phase 1 と同じ読み取り専用ツールセットを与える
 * （2026-08-07 裁定。findings-manager の allowedTools: [] は流用しない）。
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
 * provider/model は escalation reviewer の routing persona key で解決させたいので、
 * 親（owner reviewer / parallel 親）が持つ `providerInfo` の上書きは引き継がない。
 * 一方 rate-limit fallback は透過させる — escalation reviewer 自身の operation を
 * 対象とする fallback だけが `runtimeForOperation` によって providerInfo へ反映され、
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

export type FindingEscalationReviewerOutcome =
  | {
      readonly kind: 'published';
      readonly step: AgentWorkflowStep;
      readonly publication: CanonicalFindingReviewPublication;
      readonly relationClarification?: ReviewerRelationClarification;
    }
  | {
      readonly kind: 'terminal';
      readonly step: AgentWorkflowStep;
      readonly response: AgentResponse;
      readonly providerInfo?: StepProviderInfo;
      readonly terminalOperation?: NonNullable<StepRunResult['terminalOperation']>;
    };

export interface FindingEscalationReviewerInput {
  readonly contract: FindingContractConfig;
  readonly workflowProvider?: WorkflowConfig['provider'];
  readonly workflowModel?: WorkflowConfig['model'];
  /**
   * buildFindingEscalationInstructionContext が返した escalation slot 専用 context。
   * 今ラウンドに格上げ対象の anomaly が無ければ undefined。その場合でも、
   * 前ラウンドで永続化済みの escalation publication があれば resume して返す
   * （提示は計上済みなので request は作られないが、raw findings はまだ
   * manager へ渡っていない）。
   */
  readonly escalationContext?: FindingContractInstructionContext;
  /** owner reviewer step。escalation_reviewer.output_contract 未設定時に report 形式を継承する。 */
  readonly ownerReviewerSteps: readonly AgentWorkflowStep[];
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

export async function runFindingEscalationReviewer(
  input: FindingEscalationReviewerInput,
): Promise<FindingEscalationReviewerOutcome | undefined> {
  const baseStep = buildFindingEscalationReviewerStep({
    contract: input.contract,
    workflowProvider: input.workflowProvider,
    workflowModel: input.workflowModel,
    ownerOutputContractFormat: requireEscalationOwnerOutputContractFormat(input.ownerReviewerSteps),
  });
  const runtime = escalationReviewerRuntime(input.runtime);

  // 提示予算を使い切った anomaly でも、前ラウンドの escalation publication が
  // 未取り込みのまま残ることがある（publication 成立後 / manager commit 前の crash）。
  // request の有無より先に stored publication を引き当てないと、
  // 「予算は消費済みなのに証拠は一度も intake されない」状態で終端する。
  const resumed = await input.stepExecutor.resumeFindingReviewPublication({
    step: baseStep,
    parentStepName: input.parentStepName,
    stepIteration: input.stepIteration,
    state: input.state,
    runtime,
    ...(input.escalationContext?.reviewer?.presentationContext === undefined
      ? {}
      : { presentationContext: input.escalationContext.reviewer.presentationContext }),
  });
  if (resumed !== undefined) {
    return 'terminalResponse' in resumed
      ? {
          kind: 'terminal',
          step: baseStep,
          response: resumed.terminalResponse,
          ...(resumed.reviewerProviderInfo === undefined
            ? {}
            : { providerInfo: resumed.reviewerProviderInfo }),
          terminalOperation: resumed.terminalOperation,
        }
      : {
          kind: 'published',
          step: baseStep,
          publication: resumed.publication,
          ...(resumed.relationClarification === undefined
            ? {}
            : { relationClarification: resumed.relationClarification }),
        };
  }
  if (input.escalationContext === undefined) {
    return undefined;
  }

  const escalationContext = input.escalationContext;
  const escalationStep = withFindingContractStructuredOutput(baseStep, escalationContext);
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
    reviewerOutputStrategy: ESCALATION_REVIEWER_OUTPUT_STRATEGY,
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
  return {
    kind: 'published',
    step: escalationStep,
    publication: prepared.publication,
    ...(prepared.relationClarification === undefined
      ? {}
      : { relationClarification: prepared.relationClarification }),
  };
}
