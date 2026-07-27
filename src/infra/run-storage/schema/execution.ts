const DIGEST_CHECK = `
  length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'
`;

export const EXECUTION_DDL = [
  `CREATE TABLE step_executions (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    step_id TEXT NOT NULL CHECK (length(step_id) > 0),
    run_session_id TEXT,
    persona_session_id TEXT,
    iteration INTEGER NOT NULL CHECK (iteration > 0),
    status TEXT NOT NULL CHECK (
      status IN ('running', 'completed', 'failed', 'cancelled')
    ),
    started_at INTEGER NOT NULL CHECK (started_at >= 0),
    terminal_at INTEGER,
    PRIMARY KEY (run_id, scope_id, execution_id),
    UNIQUE (run_id, scope_id, step_id, iteration),
    FOREIGN KEY (run_id, scope_id)
      REFERENCES scope_runtime(run_id, scope_id) ON DELETE CASCADE,
    FOREIGN KEY (run_id, scope_id, run_session_id)
      REFERENCES run_sessions(run_id, scope_id, session_id),
    FOREIGN KEY (run_id, scope_id, persona_session_id)
      REFERENCES persona_sessions(run_id, scope_id, persona_session_id),
    CHECK (
      (status = 'running' AND terminal_at IS NULL)
      OR (status <> 'running' AND terminal_at IS NOT NULL)
    )
  ) STRICT`,
  `CREATE TRIGGER step_executions_iteration_sequence_guard
    BEFORE INSERT ON step_executions
    WHEN NEW.iteration <> coalesce((
      SELECT max(iteration) + 1
      FROM step_executions
      WHERE
        run_id = NEW.run_id
        AND scope_id = NEW.scope_id
        AND step_id = NEW.step_id
    ), 1)
    BEGIN
      SELECT RAISE(ABORT, 'invalid step iteration sequence');
    END`,
  `CREATE TABLE phase_executions (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    phase_execution_id TEXT NOT NULL,
    step_execution_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (length(phase) > 0),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    status TEXT NOT NULL CHECK (
      status IN ('running', 'completed', 'failed', 'cancelled')
    ),
    started_at INTEGER NOT NULL CHECK (started_at >= 0),
    terminal_at INTEGER,
    PRIMARY KEY (run_id, scope_id, phase_execution_id),
    UNIQUE (run_id, scope_id, step_execution_id, phase, ordinal),
    FOREIGN KEY (run_id, scope_id, step_execution_id)
      REFERENCES step_executions(run_id, scope_id, execution_id)
      ON DELETE CASCADE,
    CHECK (
      (status = 'running' AND terminal_at IS NULL)
      OR (status <> 'running' AND terminal_at IS NOT NULL)
    )
  ) STRICT`,
  `CREATE TABLE judge_stage_results (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    phase_execution_id TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (length(stage) > 0),
    codec_name TEXT NOT NULL REFERENCES storage_codecs(codec_name),
    result TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (${DIGEST_CHECK}),
    PRIMARY KEY (run_id, scope_id, phase_execution_id, stage),
    FOREIGN KEY (run_id, scope_id, phase_execution_id)
      REFERENCES phase_executions(run_id, scope_id, phase_execution_id)
      ON DELETE CASCADE
  ) STRICT`,
  `CREATE TABLE step_outputs (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    step_execution_id TEXT NOT NULL,
    output_name TEXT NOT NULL CHECK (length(output_name) > 0),
    codec_name TEXT NOT NULL REFERENCES storage_codecs(codec_name),
    output TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (${DIGEST_CHECK}),
    PRIMARY KEY (run_id, scope_id, step_execution_id, output_name),
    FOREIGN KEY (run_id, scope_id, step_execution_id)
      REFERENCES step_executions(run_id, scope_id, execution_id)
      ON DELETE CASCADE
  ) STRICT`,
  `CREATE TABLE structured_outputs (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    step_execution_id TEXT NOT NULL,
    codec_name TEXT NOT NULL REFERENCES storage_codecs(codec_name),
    output TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (${DIGEST_CHECK}),
    PRIMARY KEY (run_id, scope_id, step_execution_id),
    FOREIGN KEY (run_id, scope_id, step_execution_id)
      REFERENCES step_executions(run_id, scope_id, execution_id)
      ON DELETE CASCADE
  ) STRICT`,
  `CREATE TABLE system_contexts (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    context_id TEXT NOT NULL,
    codec_name TEXT NOT NULL REFERENCES storage_codecs(codec_name),
    content TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (${DIGEST_CHECK}),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (run_id, scope_id, context_id),
    FOREIGN KEY (run_id, scope_id)
      REFERENCES scope_runtime(run_id, scope_id) ON DELETE CASCADE
  ) STRICT`,
  `CREATE TABLE effect_results (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    effect_id TEXT NOT NULL,
    effect_type TEXT NOT NULL CHECK (length(effect_type) > 0),
    codec_name TEXT NOT NULL REFERENCES storage_codecs(codec_name),
    result TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (${DIGEST_CHECK}),
    recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
    PRIMARY KEY (run_id, scope_id, effect_id),
    FOREIGN KEY (run_id, scope_id)
      REFERENCES scope_runtime(run_id, scope_id) ON DELETE CASCADE
  ) STRICT`,
  `CREATE TABLE user_inputs (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    input_id TEXT NOT NULL,
    codec_name TEXT NOT NULL REFERENCES storage_codecs(codec_name),
    input TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (${DIGEST_CHECK}),
    received_at INTEGER NOT NULL CHECK (received_at >= 0),
    PRIMARY KEY (run_id, scope_id, input_id),
    FOREIGN KEY (run_id, scope_id)
      REFERENCES scope_runtime(run_id, scope_id) ON DELETE CASCADE
  ) STRICT`,
  `CREATE TABLE persona_sessions (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    persona_session_id TEXT NOT NULL,
    persona_name TEXT NOT NULL CHECK (length(persona_name) > 0),
    started_at INTEGER NOT NULL CHECK (started_at >= 0),
    ended_at INTEGER,
    PRIMARY KEY (run_id, scope_id, persona_session_id),
    FOREIGN KEY (run_id, scope_id)
      REFERENCES scope_runtime(run_id, scope_id) ON DELETE CASCADE,
    CHECK (ended_at IS NULL OR ended_at >= started_at)
  ) STRICT`,
  `CREATE TABLE persona_session_history (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    persona_session_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    codec_name TEXT NOT NULL REFERENCES storage_codecs(codec_name),
    content TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (${DIGEST_CHECK}),
    recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
    PRIMARY KEY (run_id, scope_id, persona_session_id, revision),
    FOREIGN KEY (run_id, scope_id, persona_session_id)
      REFERENCES persona_sessions(run_id, scope_id, persona_session_id)
      ON DELETE CASCADE
  ) STRICT`,
  `CREATE TABLE fallback_attempts (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    reason TEXT NOT NULL,
    attempted_at INTEGER NOT NULL CHECK (attempted_at >= 0),
    PRIMARY KEY (run_id, scope_id, attempt_id),
    FOREIGN KEY (run_id, scope_id)
      REFERENCES scope_runtime(run_id, scope_id) ON DELETE CASCADE
  ) STRICT`,
  `CREATE TABLE response_snapshots (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    codec_name TEXT NOT NULL REFERENCES storage_codecs(codec_name),
    response TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (${DIGEST_CHECK}),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (run_id, scope_id, snapshot_id),
    UNIQUE (run_id, scope_id, sequence),
    FOREIGN KEY (run_id, scope_id)
      REFERENCES scope_runtime(run_id, scope_id) ON DELETE CASCADE
  ) STRICT`,
  `CREATE TABLE recovery_items (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    recovery_item_id TEXT NOT NULL,
    recovery_key TEXT NOT NULL CHECK (length(recovery_key) > 0),
    item_type TEXT NOT NULL CHECK (length(item_type) > 0),
    codec_name TEXT NOT NULL REFERENCES storage_codecs(codec_name),
    content TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (${DIGEST_CHECK}),
    status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected')),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    terminal_at INTEGER,
    PRIMARY KEY (run_id, scope_id, recovery_item_id),
    UNIQUE (run_id, scope_id, recovery_key),
    FOREIGN KEY (run_id, scope_id)
      REFERENCES scope_runtime(run_id, scope_id) ON DELETE CASCADE,
    CHECK (
      (status = 'pending' AND terminal_at IS NULL)
      OR (status <> 'pending' AND terminal_at IS NOT NULL)
    )
  ) STRICT`,
  `CREATE TRIGGER step_executions_transition_guard
    BEFORE UPDATE ON step_executions
    WHEN NOT (
      NEW.run_id IS OLD.run_id
      AND NEW.scope_id IS OLD.scope_id
      AND NEW.execution_id IS OLD.execution_id
      AND NEW.step_id IS OLD.step_id
      AND NEW.run_session_id IS OLD.run_session_id
      AND NEW.persona_session_id IS OLD.persona_session_id
      AND NEW.iteration IS OLD.iteration
      AND NEW.started_at IS OLD.started_at
      AND OLD.status = 'running'
      AND NEW.status IN ('completed', 'failed', 'cancelled')
      AND NEW.terminal_at >= NEW.started_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid step execution transition');
    END`,
  `CREATE TRIGGER phase_executions_transition_guard
    BEFORE UPDATE ON phase_executions
    WHEN NOT (
      NEW.run_id IS OLD.run_id
      AND NEW.scope_id IS OLD.scope_id
      AND NEW.phase_execution_id IS OLD.phase_execution_id
      AND NEW.step_execution_id IS OLD.step_execution_id
      AND NEW.phase IS OLD.phase
      AND NEW.ordinal IS OLD.ordinal
      AND NEW.started_at IS OLD.started_at
      AND OLD.status = 'running'
      AND NEW.status IN ('completed', 'failed', 'cancelled')
      AND NEW.terminal_at >= NEW.started_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid phase execution transition');
    END`,
  `CREATE TRIGGER persona_sessions_terminal_guard
    BEFORE UPDATE ON persona_sessions
    WHEN NOT (
      NEW.run_id IS OLD.run_id
      AND NEW.scope_id IS OLD.scope_id
      AND NEW.persona_session_id IS OLD.persona_session_id
      AND NEW.persona_name IS OLD.persona_name
      AND NEW.started_at IS OLD.started_at
      AND OLD.ended_at IS NULL
      AND NEW.ended_at >= OLD.started_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid persona session transition');
    END`,
  `CREATE TRIGGER recovery_items_transition_guard
    BEFORE UPDATE ON recovery_items
    WHEN NOT (
      NEW.run_id IS OLD.run_id
      AND NEW.scope_id IS OLD.scope_id
      AND NEW.recovery_item_id IS OLD.recovery_item_id
      AND NEW.recovery_key IS OLD.recovery_key
      AND NEW.item_type IS OLD.item_type
      AND NEW.codec_name IS OLD.codec_name
      AND NEW.content IS OLD.content
      AND NEW.digest IS OLD.digest
      AND NEW.created_at IS OLD.created_at
      AND OLD.status = 'pending'
      AND NEW.status IN ('applied', 'rejected')
      AND NEW.terminal_at >= NEW.created_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid recovery item transition');
    END`,
  `CREATE TRIGGER response_snapshots_sequence_guard
    BEFORE INSERT ON response_snapshots
    WHEN NEW.sequence <> (
      SELECT count(*) + 1
      FROM response_snapshots
      WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid response snapshot sequence');
    END`,
];

const IMMUTABLE_EXECUTION_TABLES = [
  'judge_stage_results',
  'step_outputs',
  'structured_outputs',
  'system_contexts',
  'effect_results',
  'user_inputs',
  'persona_session_history',
  'fallback_attempts',
  'response_snapshots',
] as const;

for (const table of IMMUTABLE_EXECUTION_TABLES) {
  EXECUTION_DDL.push(
    `CREATE TRIGGER ${table}_update_guard
      BEFORE UPDATE ON ${table}
      BEGIN
        SELECT RAISE(ABORT, '${table} is append-only');
      END`,
    `CREATE TRIGGER ${table}_delete_guard
      BEFORE DELETE ON ${table}
      BEGIN
        SELECT RAISE(ABORT, '${table} cannot be deleted');
      END`,
  );
}

for (const table of ['step_executions', 'phase_executions', 'recovery_items', 'persona_sessions'] as const) {
  EXECUTION_DDL.push(`CREATE TRIGGER ${table}_delete_guard
    BEFORE DELETE ON ${table}
    BEGIN
      SELECT RAISE(ABORT, '${table} cannot be deleted');
    END`);
}
