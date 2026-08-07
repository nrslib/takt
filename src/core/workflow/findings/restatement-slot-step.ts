import type { AgentWorkflowStep } from '../../models/types.js';
import type { StepProviderOptions } from '../../models/workflow-types.js';
import type { ProviderType } from '../../../shared/types/provider.js';
import { FINDING_ESCALATION_REVIEWER_ROUTING_KEY } from '../../models/finding-types.js';
import type { RestatementPresentationPhase } from './restatement-presentation-phase.js';

/** slot が実際に発行する呼び出しの種別（`exhausted` は呼び出しにならない）。 */
export type RestatementSlotPhase = Exclude<RestatementPresentationPhase, 'exhausted'>;

/**
 * slot 呼び出しの中身。
 *
 * - `restatement-only`: エンジンの言い直し専用指示で走る。intake anomaly の
 *   言い直しだけが目的
 * - `full-review`: owner のレビュー手順をそのまま使う完全な再レビュー。後続の
 *   完全レビュー成立でしか決着しない anomaly（protocol / verdict-claims /
 *   報告拒否由来）の取り下げ条件を満たすために必要。言い直し request があれば
 *   同じ呼び出しへ同梱する
 */
export type RestatementSlotMode = 'restatement-only' | 'full-review';

/**
 * slot が公開する report 名。
 *
 * 同一レビューラウンド内で複数回呼び出すため、pass 番号まで identity に入れる。
 * publication identity は reportName を含むので、これが無いと2回目の呼び出しが
 * 1回目と同じ publication ID になり、提示が計上されない。
 *
 * mode には依存させない。resume は「その pass の identity」で保存済み
 * publication を引き当てるため、実行のたびに mode が変わると引き当てられなくなる。
 */
export function findingRestatementSlotReportName(input: {
  ownerStepName: string;
  phase: RestatementSlotPhase;
  presentationPass: number;
}): string {
  const prefix = input.phase === 'escalation'
    ? FINDING_ESCALATION_REVIEWER_ROUTING_KEY
    : 'followup';
  return `${prefix}-${input.ownerStepName}-${input.presentationPass}`;
}

/**
 * 言い直し slot の1呼び出しが使う provider/model。呼び出し側が解決済みの値を渡す。
 * `model` は owner 側が model を持たない構成をそのまま引き継ぐため optional。
 */
export interface RestatementSlotProviderTarget {
  provider: ProviderType;
  model?: string;
  providerOptions?: StepProviderOptions;
}

/**
 * 言い直し slot の合成ステップ。owner レビュアーの完全な代打であり、専用の
 * persona も workflow 設定ブロックも持たない。owner step の persona / policy /
 * knowledge / MCP サーバ / report 形式をそのまま継承し、変わるのは
 * provider/model と、エンジンが注入する言い直し専用指示だけ。`ownerStep` には
 * dynamic facets 適用後の実行用ステップを渡すこと — 設定上の step を渡すと、
 * その回の owner が実際に使った facet 集合と代打の判断基準がずれる。
 *
 * `restatement` フェーズでは step 名を owner と同じにする。publication の
 * `reviewerStepName` は step 名から決まり、restatement request の `reviewer`
 * （= owner 名）と一致していなければ publication invariant を破るため。
 * `escalation` フェーズだけ reviewer キーが `escalation-reviewer` になる。
 *
 * persona を owner と共有する帰結として、slot が出した raw finding の
 * reviewerStableKey は owner のものと一致する。これは意図した挙動で、代打の
 * 主張が owner の lifecycle をそのまま継ぐために必要。
 *
 * workflow の step ではなく、findings-manager / terminal adjudication と同じく
 * engine が直接 provider call を発行するための AgentWorkflowStep で、
 * config.steps へは注入しない。
 */
export function buildFindingRestatementSlotStep(input: {
  ownerStep: AgentWorkflowStep;
  phase: RestatementSlotPhase;
  mode: RestatementSlotMode;
  presentationPass: number;
  target: RestatementSlotProviderTarget;
}): AgentWorkflowStep {
  const owner = input.ownerStep;
  const reportFormat = owner.outputContracts?.[0]?.format;
  if (reportFormat === undefined) {
    throw new Error(
      `Finding contract reviewer "${owner.name}" has no output contract to inherit for restatement`,
    );
  }
  if (owner.persona === undefined) {
    throw new Error(
      `Finding contract reviewer "${owner.name}" has no persona to inherit for restatement`,
    );
  }
  const reportName = findingRestatementSlotReportName({
    ownerStepName: owner.name,
    phase: input.phase,
    presentationPass: input.presentationPass,
  });
  return {
    kind: 'agent',
    name: input.phase === 'escalation'
      ? FINDING_ESCALATION_REVIEWER_ROUTING_KEY
      : owner.name,
    engineSynthesized: true,
    persona: owner.persona,
    ...(owner.personaPath === undefined ? {} : { personaPath: owner.personaPath }),
    personaDisplayName: owner.personaDisplayName,
    ...(input.phase === 'escalation'
      ? { providerRoutingPersonaKey: FINDING_ESCALATION_REVIEWER_ROUTING_KEY }
      : owner.providerRoutingPersonaKey === undefined
        ? {}
        : { providerRoutingPersonaKey: owner.providerRoutingPersonaKey }),
    // owner と persona を共有するため、セッションを owner のものと混ぜない。
    sessionKey: reportName,
    ...(owner.policyContents === undefined ? {} : { policyContents: owner.policyContents }),
    ...(owner.knowledgeContents === undefined ? {} : { knowledgeContents: owner.knowledgeContents }),
    // MCP 経由でしか読めない証拠を owner が引用していた場合、代打がそれを
    // 再取得できないと言い直しの意味がないので MCP サーバも継承する。
    ...(owner.mcpServers === undefined ? {} : { mcpServers: owner.mcpServers }),
    // ツール集合は providerOptions（allowed_tools 等）と edit から導出される。
    // owner の解決済み providerOptions をそのまま持つことで、フルレビュー枠は
    // owner と同じ道具立てで走る。target が providerOptions を持たない場合
    // （格上げ先 profile が指定していない）は owner のものを引き継ぐ。
    // provider/model は呼び出し側で解決済み。以降の routing 層で再解決させない。
    provider: input.target.provider,
    providerSpecified: true,
    ...(input.target.model === undefined
      ? {}
      : { model: input.target.model, modelSpecified: true }),
    ...(input.target.providerOptions === undefined
      ? (owner.providerOptions === undefined ? {} : { providerOptions: owner.providerOptions })
      : { providerOptions: input.target.providerOptions }),
    // restatement-only では手順はエンジンが注入する言い直し契約が担う。owner の
    // 通常レビュー手順を持ち込むと「言い直しだけ」の契約と矛盾するので継承しない。
    // InstructionBuilder は step.instruction をテンプレート本体として扱うため
    // 空にはできない。役割を1文で述べる固定文にとどめる。
    // full-review では逆に owner のレビュー手順そのものが必要 — 取り下げ条件が
    // 「そのレビュアーの後続完全レビュー成立」なので、手順を落とすと決着の前提が
    // 崩れる。
    instruction: input.mode === 'full-review'
      ? owner.instruction
      : 'Restate the requested claims for the owning reviewer.',
    session: 'refresh',
    edit: false,
    rules: [],
    outputContracts: [{ name: reportName, format: reportFormat }],
  };
}
