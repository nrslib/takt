import type { InternalAgentSeats } from '../models/config-types.js';
import type { LoopMonitorJudge } from '../models/types.js';
import type { ProviderType } from '../../shared/types/provider.js';
import type { StepProviderOptions } from '../models/workflow-types.js';
import { internalAgentSeatOverride } from './internal-agent-seat.js';

/**
 * loop monitor の判定役が provider routing で使う固定 persona キー。judge に設定された
 * persona 名ではなくこのキーで引く（`personaDisplayName` はセッションキー等に使う表示名で、
 * ルーティング専用のキーとは役割が違う）。
 */
export const LOOP_JUDGE_ROUTING_KEY = 'loop-judge';

/** 実行時に合成される judge ステップ名。検証と実行で同じ名前を使う（routing が step 名で引けるため）。 */
export function loopJudgeStepName(cycle: readonly string[]): string {
  return `_loop_judge_${cycle.join('_')}`;
}

/** judge ステップへ焼き込む provider/model 指定。 */
export interface LoopJudgeProviderFields {
  provider?: ProviderType;
  providerSpecified?: true;
  model?: string;
  modelSpecified?: boolean;
  providerOptions?: StepProviderOptions;
}

/**
 * judge ステップの provider/model 指定を決める。
 *
 * runtime.yaml の `internal_agents['loop-judge']` seat があればそれを step 直指定として
 * 焼き込み、無ければ workflow の `loop_monitors[].judge.provider` / `model` をそのまま使う
 * （どちらも無ければ judge ステップの通常解決 → トリガー元へのフォールバックが働く）。
 *
 * 検証（WorkflowValidator）と実行（LoopMonitorJudgeRunner）が同じ判定を通るよう、
 * 生成はここ1箇所に集約する。
 */
export function loopJudgeProviderFields(
  judge: Pick<LoopMonitorJudge, 'provider' | 'model' | 'modelSpecified'>,
  seats: InternalAgentSeats | undefined,
): LoopJudgeProviderFields {
  const seat = internalAgentSeatOverride(seats?.loopJudge);
  if (seat !== undefined) {
    return seat;
  }
  return {
    ...(judge.provider === undefined ? {} : { provider: judge.provider }),
    ...(judge.model === undefined ? {} : { model: judge.model }),
    ...(judge.modelSpecified === undefined ? {} : { modelSpecified: judge.modelSpecified }),
  };
}
