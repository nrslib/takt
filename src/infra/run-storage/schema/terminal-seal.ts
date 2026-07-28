const SCOPED_AUTHORITY_TABLES = [
  ['run_events', 'scope_id'],
  ['run_sessions', 'scope_id'],
  ['step_executions', 'scope_id'],
  ['phase_executions', 'scope_id'],
  ['judge_stage_results', 'scope_id'],
  ['step_outputs', 'scope_id'],
  ['structured_outputs', 'scope_id'],
  ['system_contexts', 'scope_id'],
  ['effect_results', 'scope_id'],
  ['user_inputs', 'scope_id'],
  ['persona_sessions', 'scope_id'],
  ['persona_session_history', 'scope_id'],
  ['fallback_attempts', 'scope_id'],
  ['response_snapshots', 'scope_id'],
  ['recovery_items', 'scope_id'],
  ['operations', 'scope_id'],
  ['operation_attempts', 'scope_id'],
  ['operation_transitions', 'scope_id'],
  ['report_streams', 'owner_scope_id'],
  ['report_revisions', 'owner_scope_id'],
  ['finding_ledger_revisions', 'scope_id'],
  ['finding_revision_publications', 'scope_id'],
  ['finding_ledger_heads', 'scope_id'],
  ['finding_ledger_controls', 'scope_id'],
  ['finding_entries', 'scope_id'],
  ['finding_evidence_records', 'scope_id'],
  ['finding_raw_entries', 'scope_id'],
  ['finding_conflict_entries', 'scope_id'],
  ['finding_interpretation_entries', 'scope_id'],
  ['finding_reviewer_anomaly_entries', 'scope_id'],
  ['finding_adjudication_reservations', 'scope_id'],
] as const;

export const TERMINAL_SEAL_DDL = [
  `CREATE UNIQUE INDEX step_executions_one_running_per_scope
    ON step_executions(run_id, scope_id)
    WHERE status = 'running'`,
  `CREATE TRIGGER step_executions_scope_state_guard
    BEFORE INSERT ON step_executions
    WHEN NOT EXISTS (
      SELECT 1
      FROM scope_runtime
      JOIN runs USING (run_id)
      WHERE
        scope_runtime.run_id = NEW.run_id
        AND scope_runtime.scope_id = NEW.scope_id
        AND scope_runtime.status = 'running'
        AND scope_runtime.current_step_id = NEW.step_id
        AND runs.status = 'running'
        AND (
          NEW.run_session_id IS NULL
          OR EXISTS (
            SELECT 1 FROM run_sessions
            WHERE
              run_id = NEW.run_id
              AND scope_id = NEW.scope_id
              AND session_id = NEW.run_session_id
              AND ended_at IS NULL
          )
        )
        AND (
          NEW.persona_session_id IS NULL
          OR EXISTS (
            SELECT 1 FROM persona_sessions
            WHERE
              run_id = NEW.run_id
              AND scope_id = NEW.scope_id
              AND persona_session_id = NEW.persona_session_id
              AND ended_at IS NULL
          )
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'step execution requires active scope runtime');
    END`,
  `CREATE TRIGGER phase_executions_parent_state_guard
    BEFORE INSERT ON phase_executions
    WHEN NOT EXISTS (
      SELECT 1
      FROM step_executions
      JOIN scope_runtime USING (run_id, scope_id)
      JOIN runs USING (run_id)
      WHERE
        step_executions.run_id = NEW.run_id
        AND step_executions.scope_id = NEW.scope_id
        AND step_executions.execution_id = NEW.step_execution_id
        AND step_executions.status = 'running'
        AND scope_runtime.status = 'running'
        AND runs.status = 'running'
    )
    BEGIN
      SELECT RAISE(ABORT, 'phase execution requires running step authority');
    END`,
  `CREATE TRIGGER step_executions_terminal_phase_guard
    BEFORE UPDATE OF status ON step_executions
    WHEN
      NEW.status IN ('completed', 'failed', 'cancelled')
      AND EXISTS (
        SELECT 1
        FROM phase_executions
        WHERE
          run_id = NEW.run_id
          AND scope_id = NEW.scope_id
          AND step_execution_id = NEW.execution_id
          AND status = 'running'
      )
    BEGIN
      SELECT RAISE(ABORT, 'step execution contains a running phase');
    END`,
  `CREATE TRIGGER scope_runtime_terminal_seal_guard
    BEFORE UPDATE OF status ON scope_runtime
    WHEN
      OLD.status IN ('ready', 'running')
      AND NEW.status IN ('completed', 'failed', 'cancelled')
      AND (
        EXISTS (
          SELECT 1
          FROM scopes AS child
          JOIN scope_runtime AS child_runtime
            ON child_runtime.run_id = child.run_id
            AND child_runtime.scope_id = child.scope_id
          WHERE
            child.run_id = NEW.run_id
            AND child.parent_scope_id = NEW.scope_id
            AND child_runtime.status IN ('ready', 'running')
        )
        OR EXISTS (
          SELECT 1 FROM step_executions
          WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id AND status = 'running'
        )
        OR EXISTS (
          SELECT 1 FROM phase_executions
          WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id AND status = 'running'
        )
        OR EXISTS (
          SELECT 1 FROM persona_sessions
          WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id AND ended_at IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM run_sessions
          WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id AND ended_at IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM operations
          WHERE
            run_id = NEW.run_id
            AND scope_id = NEW.scope_id
            AND state IN ('prepared', 'dispatching', 'response_recorded')
        )
        OR EXISTS (
          SELECT 1 FROM recovery_items
          WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id AND status = 'pending'
        )
        OR EXISTS (
          SELECT 1 FROM finding_adjudication_reservations
          WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id
        )
        OR EXISTS (
          SELECT 1
          FROM finding_ledger_heads AS heads
          JOIN finding_ledger_controls AS controls
            ON controls.run_id = heads.run_id
            AND controls.scope_id = heads.scope_id
            AND controls.revision = heads.current_revision
          WHERE
            heads.run_id = NEW.run_id
            AND heads.scope_id = NEW.scope_id
            AND controls.control_kind = 'pending_manager_commit'
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'scope contains active authority');
    END`,
];

for (const [table, scopeColumn] of SCOPED_AUTHORITY_TABLES) {
  for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
    const row = operation === 'DELETE' ? 'OLD' : 'NEW';
    TERMINAL_SEAL_DDL.push(
      `CREATE TRIGGER ${table}_${operation.toLowerCase()}_terminal_seal
        BEFORE ${operation} ON ${table}
        WHEN EXISTS (
          SELECT 1
          FROM scope_runtime
          JOIN runs USING (run_id)
          WHERE
            scope_runtime.run_id = ${row}.run_id
            AND scope_runtime.scope_id = ${row}.${scopeColumn}
            AND (
              scope_runtime.status IN ('completed', 'failed', 'cancelled')
              OR runs.status IN ('completed', 'failed', 'cancelled')
            )
        )
        BEGIN
          SELECT RAISE(ABORT, 'terminal scope authority is sealed');
        END`,
    );
  }
}
