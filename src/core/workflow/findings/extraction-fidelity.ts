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

function itemLostTheClaim(item: unknown): boolean {
  if (!isPlainObject(item)) {
    return false;
  }
  const rawExcerpt = Reflect.get(item, 'rawExcerpt');
  if (typeof rawExcerpt !== 'string' || rawExcerpt.length === 0) {
    return false;
  }
  const candidate = Reflect.get(item, 'candidate');
  if (candidate === null || candidate === undefined) {
    return true;
  }
  if (!isPlainObject(candidate)) {
    return false;
  }
  return Reflect.get(candidate, 'description') === null;
}

/**
 * `{ rawFindings: [...] }` を含む構造化出力（raw findings / publication のどちらでも
 * 同じ形）を受け取り、抽出忠実性の退行が1件でもあれば true を返す。
 */
export function hasRawFindingExtractionFidelityFailure(
  structuredOutput: unknown,
): boolean {
  if (!isPlainObject(structuredOutput)) {
    return false;
  }
  const rawFindings = Reflect.get(structuredOutput, 'rawFindings');
  if (!Array.isArray(rawFindings)) {
    return false;
  }
  return rawFindings.some(itemLostTheClaim);
}

/**
 * 失敗の内訳（何番目の item が、candidate 全欠けか description 欠けか）を
 * 1行で返す。判定対象は projection 後の structuredOutput なので、モデルが
 * 出した生テキストだけを見ても失敗理由が分からない — projection が candidate を
 * null へ畳んだのか、モデルが本当に claim を落としたのかを切り分けるために
 * エラーメッセージへ載せる。
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
  const reasons = rawFindings.flatMap((item, index) => {
    if (!itemLostTheClaim(item)) {
      return [];
    }
    const candidate = isPlainObject(item) ? Reflect.get(item, 'candidate') : undefined;
    return [`#${index}: ${
      candidate === null || candidate === undefined
        ? 'candidate is null after projection'
        : 'candidate description is null'
    }`];
  });
  return `${reasons.length}/${rawFindings.length} projected items lost the claim (${reasons.join('; ')})`;
}
