import type { AgentWorkflowStep } from '../../models/types.js';
import type { ProviderEscalationTarget, ProviderRoutingEntry } from '../../models/config-types.js';
import type { StepProviderOptions } from '../../models/workflow-types.js';
import type { ProviderType } from '../../../shared/types/provider.js';
import { internalAgentSeatOverride } from '../internal-agent-seat.js';
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
 * `model` は owner 側が model を持たない構成をそのまま引き継ぐため optional で、
 * 未指定は「この provider の既定に任せる」を意味する（下位層で再解決させない）。
 */
export interface RestatementSlotProviderTarget {
  provider: ProviderType;
  model?: string;
  providerOptions?: StepProviderOptions;
}

/**
 * 格上げ枠（最終提示）の宛先を決める。
 *
 * 1. runtime.yaml `provider.targets.internal_agents['escalation-reviewer']` の seat
 * 2. owner が解決された profile の `escalate` 先
 *
 * どちらも無ければ格上げ枠は発生せず、最終枠も通常の言い直しになる。提示フェーズの
 * 判定（WorkflowEngineSetup の escalationEnabled）と実際の宛先解決
 * （restatement-slot-runner）が同じ答えを出すよう、判定はここ1箇所に集約する。
 */
export function resolveFindingEscalationTarget(input: {
  readonly seat: ProviderRoutingEntry | undefined;
  readonly escalation: ProviderEscalationTarget | undefined;
}): RestatementSlotProviderTarget | undefined {
  const seat = internalAgentSeatOverride(input.seat);
  if (seat !== undefined) {
    return {
      provider: seat.provider,
      ...(seat.model === undefined ? {} : { model: seat.model }),
      ...(seat.providerOptions === undefined ? {} : { providerOptions: seat.providerOptions }),
    };
  }
  return input.escalation;
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
  // persona 未指定のレビュアーは正当な構成なので、そのまま undefined を継承する。
  //
  // 例外は格上げ枠だけ。lifecycle 上の観測者キーは `persona ?? step 名` で導出され、
  // 格上げ枠は step 名が 'escalation-reviewer' に変わる。persona を共有できないと
  // 代打の主張が owner の lifecycle を継がず別人の新規観測として二重計上される
  // ため、その構成は fail loud にする（言い直し枠は step 名が owner と同じなので
  // persona 無しでも観測者キーは一致する）。
  if (input.phase === 'escalation' && owner.persona === undefined) {
    throw new Error(
      `Finding contract reviewer "${owner.name}" has no persona to inherit for escalated re-review`,
    );
  }
  // full-review はレビュー手順そのものが決着条件（後続の完全レビュー成立）なので、
  // 手順が無いまま「完全な再レビュー」を名乗らせない。persona / report 形式と同じく
  // 継承元の欠落は fail loud にする。
  if (input.mode === 'full-review' && (owner.instruction ?? '').trim().length === 0) {
    throw new Error(
      `Finding contract reviewer "${owner.name}" has no instruction to inherit for a full re-review`,
    );
  }
  const ownerInstruction = owner.instruction;
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
    ...(owner.persona === undefined ? {} : { persona: owner.persona }),
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
    // model が undefined でも `modelSpecified` は立てる — 立てないと model だけが
    // routing 層で再解決され、別 provider 向けの model が混ざった組になる
    // （provider だけを指名した escalation-reviewer seat がこの経路を通る）。
    provider: input.target.provider,
    providerSpecified: true,
    ...(input.target.model === undefined ? {} : { model: input.target.model }),
    modelSpecified: true,
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
      ? ownerInstruction
      : 'Restate the requested claims for the owning reviewer.',
    session: 'refresh',
    edit: false,
    rules: [],
    outputContracts: [{ name: reportName, format: reportFormat }],
  };
}
