import type { InternalAgentSeats, ProviderRoutingEntry } from '../models/config-types.js';
import type { StepProviderOptions } from '../models/workflow-types.js';
import type { ProviderType } from '../../shared/types/provider.js';

export type { InternalAgentSeats };

/**
 * runtime.yaml の internal_agents seat を合成ステップへ焼き込む形。
 *
 * `providerSpecified` / `modelSpecified` を立てることで、resolveStepProviderModel は
 * これを step 直指定（PROVIDER_MODEL_SOURCE_PRIORITY の step）として扱う。CLI/環境変数の
 * 明示 override だけがこれより上に立ち、`provider_routing` 以下の層は効かなくなる。
 */
export interface InternalAgentSeatOverride {
  provider: ProviderType;
  providerSpecified: true;
  model?: string;
  modelSpecified: true;
  providerOptions?: StepProviderOptions;
}

/**
 * seat が provider を持つときだけ上書きを返す。持たない（seat 未指定、または pool 等で
 * provider が確定しない）場合は undefined を返し、呼び出し側は既定解決へ落とす。
 *
 * seat 指定は常にオプショナルであり、「未指定 = 既定解決」がこのモジュールの契約である。
 *
 * `modelSpecified` は model の有無にかかわらず立てる。provider だけを差し替えて model の
 * 解決を下位層へ残すと、別 provider 向けの model（persona routing 等）が混ざった
 * provider/model の組が出来上がるため。runtime.yaml の profile 経由の seat は provider と
 * model を対で持つのが通常なので、model 無しの枝を通るのは主にプログラム的な組み立て
 * （テストや将来の別ソース）である。
 */
export function internalAgentSeatOverride(
  seat: ProviderRoutingEntry | undefined,
): InternalAgentSeatOverride | undefined {
  if (seat?.provider === undefined) {
    return undefined;
  }
  return {
    provider: seat.provider,
    providerSpecified: true,
    ...(seat.model === undefined ? {} : { model: seat.model }),
    modelSpecified: true,
    ...(seat.providerOptions === undefined ? {} : { providerOptions: seat.providerOptions }),
  };
}
