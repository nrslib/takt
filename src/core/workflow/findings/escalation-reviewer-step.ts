import type {
  AgentWorkflowStep,
  FindingContractConfig,
  WorkflowConfig,
} from '../../models/types.js';
import { FINDING_ESCALATION_REVIEWER_ROUTING_KEY } from '../../models/finding-types.js';

/**
 * escalation reviewer が公開する report 名。owner reviewer の report 名を
 * 継承すると、別 identity の publication が同じ report ファイルへ別内容を
 * 公開して衝突する。escalation_reviewer.output_contract の有無によらず固定する。
 */
export const FINDING_ESCALATION_REVIEWER_REPORT_NAME = FINDING_ESCALATION_REVIEWER_ROUTING_KEY;

interface FindingEscalationReviewerStepInput {
  contract: FindingContractConfig;
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
}

/**
 * escalation_reviewer.output_contract を省略したときに継承する report 形式。
 * FC reviewer step は必ず1件の output contract を持つ（publication 準備の前提）
 * ため、先頭の owner reviewer から決定的に取る。
 */
export function requireEscalationOwnerOutputContractFormat(
  ownerReviewerSteps: readonly AgentWorkflowStep[],
): string {
  const format = ownerReviewerSteps[0]?.outputContracts?.[0]?.format;
  if (format === undefined) {
    throw new Error(
      'Finding contract reviewer has no output contract to inherit for escalation review',
    );
  }
  return format;
}

/**
 * provider/model 解決の検証だけに使う escalation reviewer ステップ。
 * report 形式は実行時に owner step から継承するため検証には不要で、
 * 検証のためだけの空ダミー契約を実行用 builder へ持ち込まないよう分けている。
 *
 * provider/model の優先順位は adjudicator と同形（直接指定 > workflow）。
 * routing key は persona 名ではなく固定の 'escalation-reviewer' で、
 * provider_routing.personas はこのキーで解決する。
 */
export function buildFindingEscalationReviewerPreflightStep(
  input: FindingEscalationReviewerStepInput,
): AgentWorkflowStep {
  const escalationReviewer = input.contract.escalationReviewer;
  if (escalationReviewer === undefined) {
    throw new Error('Finding escalation review requires finding_contract.escalation_reviewer');
  }
  const providerIsDirect = escalationReviewer.provider !== undefined;
  const modelIsDirect = escalationReviewer.model !== undefined;
  return {
    kind: 'agent',
    name: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
    engineSynthesized: true,
    persona: escalationReviewer.persona,
    personaDisplayName: escalationReviewer.personaDisplayName ?? FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
    providerRoutingPersonaKey: escalationReviewer.providerRoutingPersonaKey,
    // owner reviewer と persona を共有していてもセッションを混ぜない。
    sessionKey: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
    ...(escalationReviewer.personaPath !== undefined ? { personaPath: escalationReviewer.personaPath } : {}),
    provider: providerIsDirect ? escalationReviewer.provider : input.workflowProvider,
    providerSpecified: providerIsDirect,
    model: modelIsDirect ? escalationReviewer.model : providerIsDirect ? undefined : input.workflowModel,
    modelSpecified: modelIsDirect || providerIsDirect,
    instruction: escalationReviewer.instruction ?? escalationReviewer.persona,
    session: 'refresh',
    edit: false,
    rules: [],
  };
}

/**
 * escalation reviewer の実行用合成ステップ。workflow の step ではなく、
 * findings-manager / terminal adjudication と同じく engine が直接 provider call を
 * 発行するための AgentWorkflowStep で、config.steps へは注入しない。
 *
 * report 形式（outputContracts[].format）だけは owner reviewer step から継承でき、
 * report 名は衝突回避のため常に FINDING_ESCALATION_REVIEWER_REPORT_NAME。
 * 出力 strategy は owner step によらず常に structured raw findings
 * （呼び出し側が withFindingContractStructuredOutput で付与する）。
 */
export function buildFindingEscalationReviewerStep(
  input: FindingEscalationReviewerStepInput & {
    /** owner reviewer step の report 形式。escalation_reviewer.output_contract 未設定時に継承する。 */
    ownerOutputContractFormat: string;
  },
): AgentWorkflowStep {
  const step = buildFindingEscalationReviewerPreflightStep(input);
  const configuredOutputContract = input.contract.escalationReviewer?.outputContract;
  return {
    ...step,
    outputContracts: [{
      name: FINDING_ESCALATION_REVIEWER_REPORT_NAME,
      format: configuredOutputContract ?? input.ownerOutputContractFormat,
    }],
  };
}
