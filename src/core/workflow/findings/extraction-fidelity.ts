/**
 * 抽出忠実性（extraction fidelity）の退行検出。
 *
 * 非空の `rawExcerpt` は claim 本文が抽出できたことを意味するのに、同じ item の
 * `candidate` 側が claim を失っている状態を「モデル出力の退行」として扱う。
 * schema は candidate の null を許すため post-hoc 検証では捕まらず、canonicalization
 * まで進んだあと `Normalizer extraction candidate is null or has no canonicalizable
 * target` として protocol anomaly に落ちる — つまり訂正も fail-loud もないまま
 * レビュー主張が黙って消える。ここで検出して既存の1回訂正へ載せる。
 *
 * 検出対象は projection 後の item 形（`{ rawExcerpt, candidate }`）で判定する。
 * `projectReviewerRawStructuredOutputWithEnvelope` は不完全・不正な candidate を
 * すべて `candidate: null` へ畳むため、次の2形態がまとめて対象になる。
 *
 * - candidate 自体が null（全欠け）
 * - candidate object が必須フィールドを欠く／形が不正（projection で null へ畳まれる）
 *
 * candidate は完全だが `description` だけ null という半欠けも、同じく claim 本文を
 * 失っているので対象に含める。
 */

export const EXTRACTION_FIDELITY_INVALID_DETAIL =
  'Reviewer raw finding intake lost the claim: an item has a non-empty rawExcerpt but no usable candidate';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 退行の理由。undefined は「この item は退行していない」。 */
function itemClaimLossReason(item: unknown): string | undefined {
  if (!isPlainObject(item)) {
    return undefined;
  }
  const rawExcerpt = Reflect.get(item, 'rawExcerpt');
  if (typeof rawExcerpt !== 'string' || rawExcerpt.length === 0) {
    return undefined;
  }
  const candidate = Reflect.get(item, 'candidate');
  if (candidate === null || candidate === undefined) {
    return 'candidate is null after projection';
  }
  if (!isPlainObject(candidate)) {
    return undefined;
  }
  return Reflect.get(candidate, 'description') === null
    ? 'candidate description is null'
    : undefined;
}

function rawFindingIdOf(item: unknown, index: number): string {
  if (isPlainObject(item)) {
    const rawFindingId = Reflect.get(item, 'rawFindingId');
    if (typeof rawFindingId === 'string' && rawFindingId.length > 0) {
      return rawFindingId;
    }
  }
  return `#${index}`;
}

/**
 * 退行した item を「どの item がどの検証に落ちたか」の形で列挙する。
 *
 * 空配列は退行なし。エラーメッセージはこの列挙を必ず含める — 理由のない
 * 「correction failed:」だけの表面化は、実走で失敗理由が空文字になる事故を
 * 起こした（provider 応答の error / content が両方空になる経路がある）。
 */
export function describeRawFindingExtractionFidelityFailures(
  structuredOutput: unknown,
): readonly string[] {
  if (!isPlainObject(structuredOutput)) {
    return [];
  }
  const rawFindings = Reflect.get(structuredOutput, 'rawFindings');
  if (!Array.isArray(rawFindings)) {
    return [];
  }
  const failures: string[] = [];
  rawFindings.forEach((item, index) => {
    const reason = itemClaimLossReason(item);
    if (reason !== undefined) {
      failures.push(`${rawFindingIdOf(item, index)}: ${reason}`);
    }
  });
  return failures;
}

/**
 * 失敗の内訳（どの item が、candidate 全欠けか description 欠けか）を1行で返す。
 * 判定対象は projection 後の structuredOutput なので、モデルが出した生テキストだけを
 * 見ても失敗理由が分からない — projection が candidate を null へ畳んだのか、モデルが
 * 本当に claim を落としたのかを切り分けるためにエラーメッセージへ載せる。
 */
export function describeRawFindingExtractionFidelityFailure(
  structuredOutput: unknown,
): string {
  if (!isPlainObject(structuredOutput)) {
    return 'projected structured output is not an object';
  }
  const rawFindings = Reflect.get(structuredOutput, 'rawFindings');
  if (!Array.isArray(rawFindings)) {
    return 'projected structured output has no rawFindings array';
  }
  const reasons = describeRawFindingExtractionFidelityFailures(structuredOutput);
  return `${reasons.length}/${rawFindings.length} projected items lost the claim (${reasons.join('; ')})`;
}
