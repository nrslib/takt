/**
 * intake anomaly の言い直し提示1回分の宛先を決める判定。
 *
 * owner reviewer への通常 restatement と格上げ再レビューは
 * 同じ提示予算を分け合うため、判定はこの1関数に集約する。owner batch と
 * escalation batch の両方がここを通ることで、同じ anomaly が両方の batch に
 * 入ることがない。
 */
export type RestatementPresentationPhase = 'restatement' | 'escalation' | 'exhausted';

/**
 * - `presentedCount < presentationLimit - 1`: 元レビュアーへの通常 restatement
 * - `presentedCount === presentationLimit - 1`: 最終1回。owner が解決された
 *   profile に `escalate` があれば格上げ、無ければ従来どおり元レビュアーへ戻す
 * - `presentedCount >= presentationLimit`: 新しい request を作らない
 *
 * `presentationLimit === 1` のときは最初の提示がそのまま最終1回になる。
 */
export function resolveRestatementPresentationPhase(input: {
  presentedCount: number;
  presentationLimit: number;
  /** この anomaly の owner reviewer が格上げ先を持つか。 */
  escalationEnabled: boolean;
}): RestatementPresentationPhase {
  if (input.presentedCount >= input.presentationLimit) {
    return 'exhausted';
  }
  return input.escalationEnabled
    && input.presentedCount === input.presentationLimit - 1
    ? 'escalation'
    : 'restatement';
}
