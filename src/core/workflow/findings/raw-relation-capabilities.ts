import type {
  FindingLedgerEntry,
  RawFindingRelation,
} from './types.js';

/**
 * reviewer が既存 finding の lifecycle 変更を意図した主張かを判定する。
 *
 * relation が正規化で null になっても、元の target が残っていれば lifecycle
 * intent として扱う。こうした主張は new claim の recovery 経路へ流さない。
 */
export function hasLifecycleTransitionIntent(input: {
  relation: RawFindingRelation | null;
  targetFindingId?: string | null;
}): boolean {
  return input.relation !== 'new'
    && (
      input.relation !== null
      || (input.targetFindingId !== undefined && input.targetFindingId !== null)
    );
}

/**
 * 現在の target 状態に対して product lifecycle transition を実行できるか。
 *
 * invalidated / superseded target の reopen は、検証済み証拠があっても過去の
 * terminal adjudication を reviewer observation だけで覆せないため audit-only。
 * dismissed は後続の検証済み証拠による reopen の既存経路を維持するが、
 * outside_task_scope は同一 workflow task の観測では覆さず audit-only にする。
 * task digest が変われば新しい scope として reopen を評価できる。
 */
export function hasLifecycleProductTransitionCapability(input: {
  relation: Exclude<RawFindingRelation, 'new'>;
  target: FindingLedgerEntry | undefined;
  workflowTaskDigest: string;
}): boolean {
  if (input.target === undefined) {
    return false;
  }
  switch (input.relation) {
    case 'persists':
    case 'resolution_confirmation':
      return input.target.status === 'open';
    case 'reopened':
      if (
        input.target.status === 'dismissed'
        && input.target.dismissal?.basis === 'outside_task_scope'
        && input.target.dismissal.workflowTaskDigest === input.workflowTaskDigest
      ) {
        return false;
      }
      return input.target.status === 'resolved'
        || input.target.status === 'waived'
        || input.target.status === 'dismissed';
  }
}
