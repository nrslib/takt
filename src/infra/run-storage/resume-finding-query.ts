import type { RunReadContext } from './context.js';
import type { SnapshotRow } from './resume-snapshot-types.js';
import {
  assertFindingControlRows,
  assertFindingEntryRows,
} from './resume-snapshot-validation.js';

export function readAllFindingEntries(
  context: RunReadContext,
  runId: string,
): SnapshotRow[] {
  const rows = context.all<SnapshotRow>(`
    SELECT 'finding' AS entryKind, scope_id AS scopeId, revision, ordinal,
      finding_id AS authorityId, record, digest
    FROM finding_entries WHERE run_id = ?
    UNION ALL
    SELECT 'evidence', scope_id, revision, ordinal,
      evidence_id, record, digest
    FROM finding_evidence_records WHERE run_id = ?
    UNION ALL
    SELECT 'evidence_binding', scope_id, revision, ordinal,
      binding_id, record, digest
    FROM finding_evidence_bindings WHERE run_id = ?
    UNION ALL
    SELECT 'lifecycle_reservation', scope_id, revision, ordinal,
      reservation_id, record, digest
    FROM finding_lifecycle_reservations WHERE run_id = ?
    UNION ALL
    SELECT 'lifecycle_event', scope_id, revision, ordinal,
      event_id, record, digest
    FROM finding_lifecycle_events WHERE run_id = ?
    UNION ALL
    SELECT 'raw_recovery_attempt', scope_id, revision, ordinal,
      attempt_id, record, digest
    FROM finding_raw_recovery_attempts WHERE run_id = ?
    UNION ALL
    SELECT 'raw_recovery_result', scope_id, revision, ordinal,
      result_id, record, digest
    FROM finding_raw_recovery_results WHERE run_id = ?
    UNION ALL
    SELECT 'raw', scope_id, revision, ordinal,
      raw_finding_id, record, digest
    FROM finding_raw_entries WHERE run_id = ?
    UNION ALL
    SELECT 'conflict', scope_id, revision, ordinal,
      conflict_id, record, digest
    FROM finding_conflict_entries WHERE run_id = ?
    UNION ALL
    SELECT 'interpretation', scope_id, revision, ordinal,
      interpretation_key, record, digest
    FROM finding_interpretation_entries WHERE run_id = ?
    UNION ALL
    SELECT 'reviewer_anomaly', scope_id, revision, ordinal,
      anomaly_id, record, digest
    FROM finding_reviewer_anomaly_entries WHERE run_id = ?
    ORDER BY scopeId, revision, entryKind, ordinal
  `, runId, runId, runId, runId, runId, runId, runId, runId, runId, runId, runId);
  assertFindingEntryRows(rows);
  return rows;
}

export function readFindingControls(
  context: RunReadContext,
  runId: string,
): SnapshotRow[] {
  const controls = context.all<SnapshotRow>(`
    SELECT
      scope_id AS scopeId,
      revision,
      control_kind AS controlKind,
      record,
      digest
    FROM finding_ledger_controls
    WHERE run_id = ?
    ORDER BY scope_id, revision, control_kind
  `, runId);
  assertFindingControlRows(controls);
  return controls;
}
