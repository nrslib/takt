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
 * dismissed は後続証拠による human-auditable reopen の既存経路を維持する。
 */
export function hasLifecycleProductTransitionCapability(input: {
  relation: Exclude<RawFindingRelation, 'new'>;
  target: FindingLedgerEntry | undefined;
}): boolean {
  if (input.target === undefined) {
    return false;
  }
  switch (input.relation) {
    case 'persists':
    case 'resolution_confirmation':
      return input.target.status === 'open';
    case 'reopened':
      return input.target.status === 'resolved'
        || input.target.status === 'waived'
        || input.target.status === 'dismissed';
  }
}
