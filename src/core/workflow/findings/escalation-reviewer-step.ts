import type { AgentWorkflowStep } from '../../models/types.js';
import type { ProviderEscalationTarget } from '../../models/config-types.js';
import { FINDING_ESCALATION_REVIEWER_ROUTING_KEY } from '../../models/finding-types.js';

/**
 * 格上げ再レビューが公開する report 名。owner reviewer の report 名を継承すると
 * 別 identity の publication が同じ report ファイルへ別内容を公開して衝突する。
 * owner ごとに1呼び出しへ分けるため、report 名も owner で分ける。
 */
export function findingEscalationReviewerReportName(ownerStepName: string): string {
  return `${FINDING_ESCALATION_REVIEWER_ROUTING_KEY}-${ownerStepName}`;
}

/**
 * escalation reviewer は owner レビュアーの完全な代打であり、専用の persona も
 * workflow 設定ブロックも持たない。owner step の persona / policy / knowledge /
 * MCP サーバ / report 形式をそのまま継承し、変わるのは provider/model（owner が
 * 解決された profile の `escalate` 先）と、エンジンが注入する restatement-only
 * 指示だけ。`ownerStep` には dynamic facets 適用後の実行用ステップを渡すこと —
 * 設定上の step を渡すと、その回の owner が実際に使った facet 集合と代打の
 * 判断基準がずれる。
 *
 * persona を owner と共有する帰結として、格上げが出した raw finding の
 * reviewerStableKey は owner のものと一致する。これは意図した挙動で、代打の
 * 主張が owner の lifecycle をそのまま継ぐ（別人の新規観測として二重計上され
 * ない）ために必要。publication identity だけは reviewer キー
 * 'escalation-reviewer' と owner 別 report 名で owner と分かれる。
 *
 * workflow の step ではなく、findings-manager / terminal adjudication と同じく
 * engine が直接 provider call を発行するための AgentWorkflowStep で、
 * config.steps へは注入しない。
 */
export function buildFindingEscalationReviewerStep(input: {
  ownerStep: AgentWorkflowStep;
  escalation: ProviderEscalationTarget;
}): AgentWorkflowStep {
  const owner = input.ownerStep;
  const reportFormat = owner.outputContracts?.[0]?.format;
  if (reportFormat === undefined) {
    throw new Error(
      `Finding contract reviewer "${owner.name}" has no output contract to inherit for escalation review`,
    );
  }
  if (owner.persona === undefined) {
    throw new Error(
      `Finding contract reviewer "${owner.name}" has no persona to inherit for escalation review`,
    );
  }
  const reportName = findingEscalationReviewerReportName(owner.name);
  return {
    kind: 'agent',
    name: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
    engineSynthesized: true,
    persona: owner.persona,
    ...(owner.personaPath === undefined ? {} : { personaPath: owner.personaPath }),
    personaDisplayName: owner.personaDisplayName,
    providerRoutingPersonaKey: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
    // owner と persona を共有するため、セッションを owner のものと混ぜない。
    sessionKey: reportName,
    ...(owner.policyContents === undefined ? {} : { policyContents: owner.policyContents }),
    ...(owner.knowledgeContents === undefined ? {} : { knowledgeContents: owner.knowledgeContents }),
    // MCP 経由でしか読めない証拠を owner が引用していた場合、代打がそれを
    // 再取得できないと格上げの意味がないので MCP サーバも継承する。
    ...(owner.mcpServers === undefined ? {} : { mcpServers: owner.mcpServers }),
    // 格上げ先は解決済みの provider/model。以降の routing 層で再解決させない。
    provider: input.escalation.provider,
    providerSpecified: true,
    model: input.escalation.model,
    modelSpecified: true,
    ...(input.escalation.providerOptions === undefined
      ? {}
      : { providerOptions: input.escalation.providerOptions }),
    // 手順はエンジンが注入する restatement-only 契約が担う。owner の通常レビュー
    // 手順を持ち込むと「言い直しだけ」の契約と矛盾するので継承しない。
    // InstructionBuilder は step.instruction をテンプレート本体として扱うため
    // 空にはできない。役割を1文で述べる固定文にとどめる。
    instruction: 'Restate the requested claims for the owning reviewer.',
    session: 'refresh',
    edit: false,
    rules: [],
    outputContracts: [{ name: reportName, format: reportFormat }],
  };
}
