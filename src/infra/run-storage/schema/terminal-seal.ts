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
  ['finding_ledger_heads', 'scope_id'],
  ['finding_ledger_controls', 'scope_id'],
  ['finding_entries', 'scope_id'],
  ['finding_evidence_records', 'scope_id'],
  ['finding_evidence_bindings', 'scope_id'],
  ['finding_lifecycle_reservations', 'scope_id'],
  ['finding_lifecycle_events', 'scope_id'],
  ['finding_raw_recovery_attempts', 'scope_id'],
  ['finding_raw_recovery_results', 'scope_id'],
  ['finding_raw_entries', 'scope_id'],
  ['finding_conflict_entries', 'scope_id'],
  ['finding_interpretation_entries', 'scope_id'],
  ['finding_reviewer_anomaly_entries', 'scope_id'],
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
          SELECT 1
          FROM finding_ledger_heads AS heads
          JOIN finding_lifecycle_reservations AS reservations
            ON reservations.run_id = heads.run_id
            AND reservations.scope_id = heads.scope_id
            AND reservations.revision = heads.current_revision
          LEFT JOIN finding_lifecycle_events AS events
            ON events.run_id = reservations.run_id
            AND events.scope_id = reservations.scope_id
            AND events.revision = reservations.revision
            AND json_extract(events.record, '$.mutationId')
              = json_extract(reservations.record, '$.mutationId')
          WHERE
            heads.run_id = NEW.run_id
            AND heads.scope_id = NEW.scope_id
            AND events.event_id IS NULL
        )
        OR EXISTS (
          SELECT 1
          FROM finding_ledger_heads AS heads
          JOIN finding_raw_recovery_attempts AS attempts
            ON attempts.run_id = heads.run_id
            AND attempts.scope_id = heads.scope_id
            AND attempts.revision = heads.current_revision
          LEFT JOIN finding_raw_recovery_results AS results
            ON results.run_id = attempts.run_id
            AND results.scope_id = attempts.scope_id
            AND results.revision = attempts.revision
            AND json_extract(results.record, '$.attemptId')
              = json_extract(attempts.record, '$.attemptId')
            AND (
              (
                json_extract(results.record, '$.outcome') IN ('stale', 'failed')
                AND json_array_length(json_extract(results.record, '$.mutationIds')) = 0
              )
              OR (
                json_extract(results.record, '$.outcome') = 'applied'
                AND json_type(results.record, '$.replayRawFindingId') = 'text'
                AND json_array_length(json_extract(results.record, '$.mutationIds')) > 0
                AND json_array_length(json_extract(results.record, '$.mutationIds')) = (
                  SELECT count(DISTINCT result_mutation.value)
                  FROM json_each(results.record, '$.mutationIds') AS result_mutation
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM json_each(results.record, '$.mutationIds') AS result_mutation
                  WHERE (
                    SELECT count(*)
                    FROM finding_lifecycle_events AS recovery_event
                    WHERE
                      recovery_event.run_id = results.run_id
                      AND recovery_event.scope_id = results.scope_id
                      AND recovery_event.revision = results.revision
                      AND json_extract(recovery_event.record, '$.mutationId')
                        = result_mutation.value
                  ) <> 1
                  OR (
                    SELECT count(*)
                    FROM finding_lifecycle_events AS recovery_event
                    JOIN json_each(
                      recovery_event.record,
                      '$.transitions'
                    ) AS recovery_transition
                    WHERE
                      recovery_event.run_id = results.run_id
                      AND recovery_event.scope_id = results.scope_id
                      AND recovery_event.revision = results.revision
                      AND json_extract(recovery_event.record, '$.mutationId')
                        = result_mutation.value
                      AND json_extract(
                        recovery_transition.value,
                        '$.after.entityKind'
                      ) = 'finding'
                      AND json_extract(
                        recovery_transition.value,
                        '$.after.entityId'
                      ) = json_extract(
                        attempts.record,
                        '$.provisionalFindingId'
                      )
                  ) <> 1
                  OR NOT EXISTS (
                    SELECT 1
                    FROM finding_lifecycle_events AS recovery_event
                    WHERE
                      recovery_event.run_id = results.run_id
                      AND recovery_event.scope_id = results.scope_id
                      AND recovery_event.revision = results.revision
                      AND json_extract(recovery_event.record, '$.mutationId')
                        = result_mutation.value
                      AND EXISTS (
                        SELECT 1
                        FROM json_each(
                          recovery_event.record,
                          '$.evidenceBindingIds'
                        ) AS recovery_binding_id
                        JOIN finding_evidence_bindings AS recovery_binding
                          ON recovery_binding.run_id = recovery_event.run_id
                          AND recovery_binding.scope_id = recovery_event.scope_id
                          AND recovery_binding.revision = recovery_event.revision
                          AND recovery_binding.binding_id = recovery_binding_id.value
                        WHERE json_extract(
                          recovery_binding.record,
                          '$.sourceRawFindingId'
                        ) = json_extract(
                          results.record,
                          '$.replayRawFindingId'
                        )
                      )
                  )
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM json_each(results.record, '$.mutationIds') AS current_mutation
                  JOIN json_each(results.record, '$.mutationIds') AS prior_mutation
                    ON prior_mutation.key = current_mutation.key - 1
                  JOIN finding_lifecycle_events AS current_event
                    ON current_event.run_id = results.run_id
                    AND current_event.scope_id = results.scope_id
                    AND current_event.revision = results.revision
                    AND json_extract(current_event.record, '$.mutationId')
                      = current_mutation.value
                  JOIN finding_lifecycle_events AS prior_event
                    ON prior_event.run_id = results.run_id
                    AND prior_event.scope_id = results.scope_id
                    AND prior_event.revision = results.revision
                    AND json_extract(prior_event.record, '$.mutationId')
                      = prior_mutation.value
                  WHERE current_event.ordinal <= prior_event.ordinal
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM json_each(results.record, '$.mutationIds') AS result_mutation
                  JOIN finding_lifecycle_events AS recovery_event
                    ON recovery_event.run_id = results.run_id
                    AND recovery_event.scope_id = results.scope_id
                    AND recovery_event.revision = results.revision
                    AND json_extract(recovery_event.record, '$.mutationId')
                      = result_mutation.value
                  JOIN json_each(
                    recovery_event.record,
                    '$.transitions'
                  ) AS recovery_transition
                    ON json_extract(
                      recovery_transition.value,
                      '$.after.entityKind'
                    ) = 'finding'
                    AND json_extract(
                      recovery_transition.value,
                      '$.after.entityId'
                    ) = json_extract(
                      attempts.record,
                      '$.provisionalFindingId'
                    )
                  WHERE result_mutation.key = 0
                    AND (
                      json_type(recovery_transition.value, '$.before') <> 'object'
                      OR json_extract(recovery_transition.value, '$.before.entityKind')
                        <> json_extract(attempts.record, '$.expectedHead.entityKind')
                      OR json_extract(recovery_transition.value, '$.before.entityId')
                        <> json_extract(attempts.record, '$.expectedHead.entityId')
                      OR json_extract(recovery_transition.value, '$.before.revision')
                        <> json_extract(attempts.record, '$.expectedHead.revision')
                      OR json_extract(recovery_transition.value, '$.before.eventId')
                        <> json_extract(attempts.record, '$.expectedHead.eventId')
                      OR json_extract(recovery_transition.value, '$.before.projectionDigest')
                        <> json_extract(attempts.record, '$.expectedHead.projectionDigest')
                    )
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM json_each(results.record, '$.mutationIds') AS current_mutation
                  JOIN json_each(results.record, '$.mutationIds') AS prior_mutation
                    ON prior_mutation.key = current_mutation.key - 1
                  JOIN finding_lifecycle_events AS current_event
                    ON current_event.run_id = results.run_id
                    AND current_event.scope_id = results.scope_id
                    AND current_event.revision = results.revision
                    AND json_extract(current_event.record, '$.mutationId')
                      = current_mutation.value
                  JOIN json_each(
                    current_event.record,
                    '$.transitions'
                  ) AS current_transition
                    ON json_extract(current_transition.value, '$.after.entityKind') = 'finding'
                    AND json_extract(current_transition.value, '$.after.entityId')
                      = json_extract(attempts.record, '$.provisionalFindingId')
                  JOIN finding_lifecycle_events AS prior_event
                    ON prior_event.run_id = results.run_id
                    AND prior_event.scope_id = results.scope_id
                    AND prior_event.revision = results.revision
                    AND json_extract(prior_event.record, '$.mutationId')
                      = prior_mutation.value
                  JOIN json_each(
                    prior_event.record,
                    '$.transitions'
                  ) AS prior_transition
                    ON json_extract(prior_transition.value, '$.after.entityKind') = 'finding'
                    AND json_extract(prior_transition.value, '$.after.entityId')
                      = json_extract(attempts.record, '$.provisionalFindingId')
                  WHERE
                    json_type(current_transition.value, '$.before') <> 'object'
                    OR json_extract(current_transition.value, '$.before.entityKind')
                      <> json_extract(prior_transition.value, '$.after.entityKind')
                    OR json_extract(current_transition.value, '$.before.entityId')
                      <> json_extract(prior_transition.value, '$.after.entityId')
                    OR json_extract(current_transition.value, '$.before.revision')
                      <> json_extract(prior_transition.value, '$.after.revision')
                    OR json_extract(current_transition.value, '$.before.eventId')
                      <> json_extract(prior_transition.value, '$.after.eventId')
                    OR json_extract(current_transition.value, '$.before.projectionDigest')
                      <> json_extract(prior_transition.value, '$.after.projectionDigest')
                )
              )
            )
          WHERE
            heads.run_id = NEW.run_id
            AND heads.scope_id = NEW.scope_id
            AND results.result_id IS NULL
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
