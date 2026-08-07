import type { ProviderEscalationTarget, ProviderRoutingEntry } from '../../models/config-types.js';
import type { AgentWorkflowStep, WorkflowConfig } from '../../models/types.js';
import type { StepProviderOptions } from '../../models/workflow-types.js';
import type { ProviderType } from '../../../shared/types/provider.js';
import {
  providerSupportsIsolatedStructuredExecution,
} from '../../../infra/providers/provider-capabilities.js';
import { createRawFindingsStructuredOutput } from './manager-agent.js';

/** 正規化係の合成ステップへ焼き込む provider/model 上書き。空は既定解決に委ねる。 */
export interface FindingIntakeNormalizerOverride {
  provider?: ProviderType;
  providerSpecified?: true;
  model?: string;
  modelSpecified?: true;
  providerOptions?: StepProviderOptions;
}

/**
 * 正規化係（プレーンテキストのレビュー報告から raw findings を隔離 structured
 * 実行で取り出す係）の provider/model 解決チェーン:
 *
 * 1. runtime.yaml `provider.targets.internal_agents['intake-normalizer']` の明示上書き。
 * 2. そのレビュアーが解決された profile の `escalate` 先。格上げ先は「構造化出力を
 *    任せられる強いモデル」という前提が既にあるので、正規化係にもそのまま使える。
 * 3. どちらも無ければ通常の既定解決（runtime defaults → グローバル / provider 既定）に
 *    委ねる。ここでは新しい既定値を発明せず、合成ステップを既存の解決経路へ通すだけ。
 *
 * 先頭が今回使う候補で、後続は「先頭が検証と訂正1回でも通らなかったとき」の
 * やり直し先。レビュアーが唯一の関門になった以上、正規化の1回失敗でラウンドを
 * 落とさないための1段だけの後退である（同じ provider/model への再試行は
 * 呼び出し側が除外する）。
 *
 * workflow / project config 側に正規化係の設定口は作らない。
 */
export function findingIntakeNormalizerOverrideChain(input: {
  readonly seat: ProviderRoutingEntry | undefined;
  readonly escalation: ProviderEscalationTarget | undefined;
}): readonly FindingIntakeNormalizerOverride[] {
  const chain: FindingIntakeNormalizerOverride[] = [];
  const seat = input.seat;
  if (seat?.provider !== undefined) {
    chain.push({
      provider: seat.provider,
      providerSpecified: true,
      ...(seat.model === undefined ? {} : { model: seat.model, modelSpecified: true as const }),
      ...(seat.providerOptions === undefined ? {} : { providerOptions: seat.providerOptions }),
    });
  }
  const escalation = input.escalation;
  if (escalation !== undefined) {
    chain.push({
      provider: escalation.provider,
      providerSpecified: true,
      model: escalation.model,
      modelSpecified: true,
      ...(escalation.providerOptions === undefined
        ? {}
        : { providerOptions: escalation.providerOptions }),
    });
  }
  chain.push({});
  return chain;
}

/**
 * 正規化係の合成ステップ列。先頭が今回使う候補、後続がやり直し先。
 *
 * ロード時の preflight（WorkflowValidator）と実行時（StepExecutor）が同じ形の
 * ステップを解決するよう、生成はここ1箇所に集約する。ロード時と実行時で解決が
 * 分岐するのは過去に出荷したバグ種別である。
 */
export function buildFindingIntakeNormalizerSteps(input: {
  readonly reviewerStepName: string;
  readonly seat: ProviderRoutingEntry | undefined;
  readonly escalation: ProviderEscalationTarget | undefined;
  readonly workflowProvider: WorkflowConfig['provider'];
  readonly workflowModel: WorkflowConfig['model'];
}): readonly AgentWorkflowStep[] {
  return findingIntakeNormalizerOverrideChain({
    seat: input.seat,
    escalation: input.escalation,
  }).map((override): AgentWorkflowStep => ({
    kind: 'agent',
    name: `${input.reviewerStepName}:intake-normalize`,
    personaDisplayName: 'Finding intake normalizer',
    instruction: 'Extract raw findings from one reviewer report.',
    engineSynthesized: true,
    // 明示上書きの無い候補（既定解決）は findings-manager と同じ優先度ティアで
    // 扱う。`providerSpecified: false` を省くと provider-resolution は step 直指定
    // （PROVIDER_MODEL_SOURCE_PRIORITY の step = 2）とみなし、routing 層
    // （provider_routing.steps = 4 以降）を飛び越えてワークフロー値
    // （workflow = 9）を掴んでしまう。未指定と「直指定ではない」は別物である。
    ...(override.provider === undefined
      ? {
          provider: input.workflowProvider,
          providerSpecified: false,
          model: input.workflowModel,
          modelSpecified: false,
        }
      : override),
    session: 'refresh',
    edit: false,
    structuredOutput: createRawFindingsStructuredOutput(),
  }));
}

/** 正規化係を任せられる provider か。やり直し候補の選別に使う。 */
export function supportsFindingIntakeNormalizerExecution(
  provider: ProviderType | undefined,
): boolean {
  return provider !== undefined && providerSupportsIsolatedStructuredExecution(provider) === true;
}

/**
 * 正規化係は隔離 structured 実行でしか成立しない。解決先がそれを満たさない場合だけ
 * 止める（理由を message に含める）。
 */
export function assertFindingIntakeNormalizerProvider(
  provider: ProviderType | undefined,
  reviewerStepName: string,
): asserts provider is ProviderType {
  if (provider === undefined) {
    throw new Error(
      `Finding intake normalizer provider could not be resolved for reviewer "${reviewerStepName}"`,
    );
  }
  if (!supportsFindingIntakeNormalizerExecution(provider)) {
    throw new Error(
      `Finding intake normalizer for reviewer "${reviewerStepName}" resolved to provider "${provider}", `
      + 'which does not support isolated structured execution',
    );
  }
}
