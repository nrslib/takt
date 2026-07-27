import {
  OPERATION_NEW_TRANSITIONS_SQL,
  OPERATION_STATES_SQL,
  OPERATION_TRANSITIONS_SQL,
  OPERATION_UPDATE_TRANSITIONS_SQL,
} from '../operation-state-contract.js';

export const OPERATIONS_DDL = [
  `CREATE TABLE operations (
    operation_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
    kind TEXT NOT NULL CHECK (length(kind) > 0),
    state TEXT NOT NULL CHECK (
      state IN (${OPERATION_STATES_SQL})
    ),
    request_codec_name TEXT NOT NULL REFERENCES storage_codecs(codec_name),
    request_content TEXT NOT NULL,
    request_digest TEXT NOT NULL CHECK (
      length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
    ),
    response_codec_name TEXT REFERENCES storage_codecs(codec_name),
    response_content TEXT,
    response_digest TEXT,
    error_codec_name TEXT REFERENCES storage_codecs(codec_name),
    error_content TEXT,
    error_digest TEXT,
    owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
    owner_claim_token TEXT NOT NULL CHECK (length(owner_claim_token) > 0),
    prepared_at INTEGER NOT NULL CHECK (prepared_at >= 0),
    dispatching_at INTEGER,
    response_recorded_at INTEGER,
    terminal_at INTEGER,
    UNIQUE (run_id, scope_id, idempotency_key),
    UNIQUE (run_id, scope_id, operation_id),
    FOREIGN KEY (run_id, scope_id) REFERENCES scopes(run_id, scope_id) ON DELETE CASCADE,
    CHECK (
      (response_codec_name IS NULL AND response_content IS NULL AND response_digest IS NULL)
      OR (
        response_codec_name IS NOT NULL
        AND response_content IS NOT NULL
        AND response_digest IS NOT NULL
        AND length(response_digest) = 64
        AND response_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    CHECK (
      (error_codec_name IS NULL AND error_content IS NULL AND error_digest IS NULL)
      OR (
        error_codec_name IS NOT NULL
        AND error_content IS NOT NULL
        AND error_digest IS NOT NULL
        AND length(error_digest) = 64
        AND error_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    CHECK (
      (state IN ('prepared', 'dispatching', 'response_recorded') AND terminal_at IS NULL)
      OR (
        state IN ('applied', 'failed', 'unknown_after_dispatch', 'cancelled')
        AND terminal_at IS NOT NULL
      )
    ),
    CHECK (
      (state IN ('prepared', 'cancelled') AND dispatching_at IS NULL)
      OR state = 'failed'
      OR (
        state IN ('dispatching', 'response_recorded', 'applied', 'unknown_after_dispatch')
        AND dispatching_at IS NOT NULL
      )
    ),
    CHECK (
      (response_digest IS NULL AND response_recorded_at IS NULL)
      OR (response_digest IS NOT NULL AND response_recorded_at IS NOT NULL)
    ),
    CHECK (
      state NOT IN ('response_recorded', 'applied')
      OR response_digest IS NOT NULL
    ),
    CHECK (
      state <> 'failed'
      OR error_digest IS NOT NULL
    )
  ) STRICT`,
  `CREATE TABLE operation_attempts (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
    owner_claim_token TEXT NOT NULL CHECK (length(owner_claim_token) > 0),
    started_at INTEGER NOT NULL CHECK (started_at >= 0),
    terminal_at INTEGER,
    outcome TEXT CHECK (
      outcome IS NULL OR outcome IN ('response_recorded', 'failed', 'unknown_after_dispatch')
    ),
    PRIMARY KEY (run_id, scope_id, operation_id, attempt),
    FOREIGN KEY (run_id, scope_id, operation_id)
      REFERENCES operations(run_id, scope_id, operation_id) ON DELETE CASCADE,
    CHECK (
      (outcome IS NULL AND terminal_at IS NULL)
      OR (outcome IS NOT NULL AND terminal_at IS NOT NULL)
    )
  ) STRICT`,
  `CREATE TABLE operation_transitions (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    transition_seq INTEGER NOT NULL CHECK (transition_seq > 0),
    from_state TEXT,
    to_state TEXT NOT NULL CHECK (
      to_state IN (${OPERATION_STATES_SQL})
    ),
    owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
    owner_claim_token TEXT NOT NULL CHECK (length(owner_claim_token) > 0),
    occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
    PRIMARY KEY (run_id, scope_id, operation_id, transition_seq),
    FOREIGN KEY (run_id, scope_id, operation_id)
      REFERENCES operations(run_id, scope_id, operation_id) ON DELETE CASCADE,
    CHECK (
      (transition_seq = 1 AND from_state IS NULL AND to_state = 'prepared')
      OR (transition_seq > 1 AND from_state IS NOT NULL)
    ),
    CHECK (
      (from_state IS NULL AND to_state = 'prepared')
      OR ${OPERATION_TRANSITIONS_SQL}
    )
  ) STRICT`,
  `CREATE TRIGGER operations_current_lease_on_insert
    BEFORE INSERT ON operations
    WHEN NOT EXISTS (
      SELECT 1 FROM run_leases
      WHERE
        run_id = NEW.run_id
        AND generation = NEW.owner_generation
        AND claim_token = NEW.owner_claim_token
        AND released_at IS NULL
        AND terminalized_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'operation owner is not the current lease');
    END`,
  `CREATE TRIGGER operations_initial_state_guard
    BEFORE INSERT ON operations
    WHEN NOT (
      NEW.state = 'prepared'
      AND NEW.response_codec_name IS NULL
      AND NEW.response_content IS NULL
      AND NEW.response_digest IS NULL
      AND NEW.error_codec_name IS NULL
      AND NEW.error_content IS NULL
      AND NEW.error_digest IS NULL
      AND NEW.dispatching_at IS NULL
      AND NEW.response_recorded_at IS NULL
      AND NEW.terminal_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'initial operation state must be complete prepared');
    END`,
  `CREATE TRIGGER operations_current_lease_on_update
    BEFORE UPDATE ON operations
    WHEN NOT EXISTS (
      SELECT 1 FROM run_leases
      WHERE
        run_id = NEW.run_id
        AND generation = NEW.owner_generation
        AND claim_token = NEW.owner_claim_token
        AND released_at IS NULL
        AND terminalized_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'operation owner is not the current lease');
    END`,
  `CREATE TRIGGER operations_state_transition_guard
    BEFORE UPDATE OF state ON operations
    WHEN
      OLD.state <> NEW.state
      AND NOT (${OPERATION_UPDATE_TRANSITIONS_SQL})
    BEGIN
      SELECT RAISE(ABORT, 'invalid operation state transition');
    END`,
  `CREATE TRIGGER operations_legal_update_guard
    BEFORE UPDATE ON operations
    WHEN NOT (
      NEW.operation_id IS OLD.operation_id
      AND NEW.run_id IS OLD.run_id
      AND NEW.scope_id IS OLD.scope_id
      AND NEW.idempotency_key IS OLD.idempotency_key
      AND NEW.kind IS OLD.kind
      AND NEW.request_codec_name IS OLD.request_codec_name
      AND NEW.request_content IS OLD.request_content
      AND NEW.request_digest IS OLD.request_digest
      AND NEW.prepared_at IS OLD.prepared_at
      AND (
        (
          OLD.state = 'prepared'
          AND NEW.state = 'dispatching'
          AND NEW.owner_generation >= OLD.owner_generation
          AND (
            NEW.owner_generation > OLD.owner_generation
            OR NEW.owner_claim_token IS OLD.owner_claim_token
          )
          AND NEW.dispatching_at >= NEW.prepared_at
          AND NEW.response_codec_name IS NULL
          AND NEW.response_content IS NULL
          AND NEW.response_digest IS NULL
          AND NEW.response_recorded_at IS NULL
          AND NEW.error_codec_name IS NULL
          AND NEW.error_content IS NULL
          AND NEW.error_digest IS NULL
          AND NEW.terminal_at IS NULL
        )
        OR (
          OLD.state = 'dispatching'
          AND NEW.state = 'response_recorded'
          AND NEW.owner_generation IS OLD.owner_generation
          AND NEW.owner_claim_token IS OLD.owner_claim_token
          AND NEW.dispatching_at IS OLD.dispatching_at
          AND NEW.response_codec_name IS NOT NULL
          AND NEW.response_content IS NOT NULL
          AND NEW.response_digest IS NOT NULL
          AND NEW.response_recorded_at >= NEW.dispatching_at
          AND NEW.error_codec_name IS NULL
          AND NEW.error_content IS NULL
          AND NEW.error_digest IS NULL
          AND NEW.terminal_at IS NULL
        )
        OR (
          OLD.state = 'response_recorded'
          AND NEW.state = 'applied'
          AND NEW.owner_generation IS OLD.owner_generation
          AND NEW.owner_claim_token IS OLD.owner_claim_token
          AND NEW.dispatching_at IS OLD.dispatching_at
          AND NEW.response_codec_name IS OLD.response_codec_name
          AND NEW.response_content IS OLD.response_content
          AND NEW.response_digest IS OLD.response_digest
          AND NEW.response_recorded_at IS OLD.response_recorded_at
          AND NEW.error_codec_name IS NULL
          AND NEW.error_content IS NULL
          AND NEW.error_digest IS NULL
          AND NEW.terminal_at >= NEW.response_recorded_at
        )
        OR (
          OLD.state IN ('prepared', 'dispatching', 'response_recorded')
          AND NEW.state = 'failed'
          AND NEW.owner_generation IS OLD.owner_generation
          AND NEW.owner_claim_token IS OLD.owner_claim_token
          AND NEW.dispatching_at IS OLD.dispatching_at
          AND NEW.response_codec_name IS OLD.response_codec_name
          AND NEW.response_content IS OLD.response_content
          AND NEW.response_digest IS OLD.response_digest
          AND NEW.response_recorded_at IS OLD.response_recorded_at
          AND OLD.error_codec_name IS NULL
          AND OLD.error_content IS NULL
          AND OLD.error_digest IS NULL
          AND NEW.error_codec_name IS NOT NULL
          AND NEW.error_content IS NOT NULL
          AND NEW.error_digest IS NOT NULL
          AND NEW.terminal_at >= coalesce(
            NEW.response_recorded_at,
            NEW.dispatching_at,
            NEW.prepared_at
          )
        )
        OR (
          OLD.state = 'prepared'
          AND NEW.state = 'cancelled'
          AND NEW.owner_generation IS OLD.owner_generation
          AND NEW.owner_claim_token IS OLD.owner_claim_token
          AND NEW.dispatching_at IS NULL
          AND NEW.response_codec_name IS NULL
          AND NEW.response_content IS NULL
          AND NEW.response_digest IS NULL
          AND NEW.response_recorded_at IS NULL
          AND NEW.error_codec_name IS NULL
          AND NEW.error_content IS NULL
          AND NEW.error_digest IS NULL
          AND NEW.terminal_at >= NEW.prepared_at
        )
        OR (
          OLD.state = 'dispatching'
          AND NEW.state = 'unknown_after_dispatch'
          AND NEW.owner_generation >= OLD.owner_generation
          AND (
            NEW.owner_generation > OLD.owner_generation
            OR NEW.owner_claim_token IS OLD.owner_claim_token
          )
          AND NEW.dispatching_at IS OLD.dispatching_at
          AND NEW.response_codec_name IS NULL
          AND NEW.response_content IS NULL
          AND NEW.response_digest IS NULL
          AND NEW.response_recorded_at IS NULL
          AND NEW.error_codec_name IS NULL
          AND NEW.error_content IS NULL
          AND NEW.error_digest IS NULL
          AND NEW.terminal_at >= NEW.dispatching_at
        )
        OR (
          OLD.state = 'response_recorded'
          AND NEW.state = 'response_recorded'
          AND NEW.owner_generation > OLD.owner_generation
          AND NEW.dispatching_at IS OLD.dispatching_at
          AND NEW.response_codec_name IS OLD.response_codec_name
          AND NEW.response_content IS OLD.response_content
          AND NEW.response_digest IS OLD.response_digest
          AND NEW.response_recorded_at IS OLD.response_recorded_at
          AND NEW.error_codec_name IS OLD.error_codec_name
          AND NEW.error_content IS OLD.error_content
          AND NEW.error_digest IS OLD.error_digest
          AND NEW.terminal_at IS OLD.terminal_at
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'illegal operation update');
    END`,
  `CREATE TRIGGER operations_append_only
    BEFORE DELETE ON operations
    BEGIN
      SELECT RAISE(ABORT, 'operations are append-only');
    END`,
  `CREATE TRIGGER operation_attempts_current_lease
    BEFORE INSERT ON operation_attempts
    WHEN NOT EXISTS (
      SELECT 1
      FROM operations
      JOIN run_leases USING (run_id)
      WHERE
        operations.operation_id = NEW.operation_id
        AND operations.run_id = NEW.run_id
        AND operations.scope_id = NEW.scope_id
        AND run_leases.generation = NEW.owner_generation
        AND run_leases.claim_token = NEW.owner_claim_token
        AND run_leases.released_at IS NULL
        AND run_leases.terminalized_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'operation attempt owner is not the current lease');
    END`,
  `CREATE TRIGGER operation_attempts_insert_guard
    BEFORE INSERT ON operation_attempts
    WHEN NOT EXISTS (
      SELECT 1
      FROM operations
      WHERE
        operations.operation_id = NEW.operation_id
        AND operations.run_id = NEW.run_id
        AND operations.scope_id = NEW.scope_id
        AND operations.state = 'dispatching'
        AND operations.owner_generation = NEW.owner_generation
        AND operations.owner_claim_token = NEW.owner_claim_token
        AND operations.dispatching_at = NEW.started_at
        AND NEW.attempt = coalesce((
          SELECT max(existing.attempt) + 1
          FROM operation_attempts AS existing
          WHERE
            existing.run_id = NEW.run_id
            AND existing.scope_id = NEW.scope_id
            AND existing.operation_id = NEW.operation_id
        ), 1)
        AND NOT EXISTS (
          SELECT 1
          FROM operation_attempts AS active
          WHERE
            active.operation_id = NEW.operation_id
            AND active.run_id = NEW.run_id
            AND active.scope_id = NEW.scope_id
            AND active.outcome IS NULL
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'operation attempt history can only follow dispatch');
    END`,
  `CREATE TRIGGER operation_transitions_current_lease
    BEFORE INSERT ON operation_transitions
    WHEN NOT EXISTS (
      SELECT 1
      FROM operations
      JOIN run_leases USING (run_id)
      WHERE
        operations.operation_id = NEW.operation_id
        AND operations.run_id = NEW.run_id
        AND operations.scope_id = NEW.scope_id
        AND run_leases.generation = NEW.owner_generation
        AND run_leases.claim_token = NEW.owner_claim_token
        AND run_leases.released_at IS NULL
        AND run_leases.terminalized_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'operation transition owner is not the current lease');
    END`,
  `CREATE TRIGGER operation_transitions_insert_guard
    BEFORE INSERT ON operation_transitions
    WHEN NOT EXISTS (
      SELECT 1
      FROM operations
      WHERE
        operations.operation_id = NEW.operation_id
        AND operations.run_id = NEW.run_id
        AND operations.scope_id = NEW.scope_id
        AND operations.state = NEW.to_state
        AND operations.owner_generation = NEW.owner_generation
        AND operations.owner_claim_token = NEW.owner_claim_token
        AND NEW.transition_seq = coalesce((
          SELECT max(existing.transition_seq) + 1
          FROM operation_transitions AS existing
          WHERE
            existing.run_id = NEW.run_id
            AND existing.scope_id = NEW.scope_id
            AND existing.operation_id = NEW.operation_id
        ), 1)
        AND (
          (
            NEW.transition_seq = 1
            AND NEW.from_state IS NULL
            AND NEW.to_state = 'prepared'
            AND NEW.occurred_at = operations.prepared_at
          )
          OR (
            NEW.transition_seq > 1
            AND NEW.from_state = (
              SELECT previous.to_state
              FROM operation_transitions AS previous
              WHERE previous.operation_id = NEW.operation_id
                AND previous.run_id = NEW.run_id
                AND previous.scope_id = NEW.scope_id
              ORDER BY previous.transition_seq DESC
              LIMIT 1
            )
            AND (${OPERATION_NEW_TRANSITIONS_SQL})
            AND NEW.occurred_at = CASE NEW.to_state
              WHEN 'dispatching' THEN operations.dispatching_at
              WHEN 'response_recorded' THEN operations.response_recorded_at
              ELSE operations.terminal_at
            END
          )
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'operation transition history must match operation state');
    END`,
  `CREATE TRIGGER operations_record_initial_transition
    AFTER INSERT ON operations
    BEGIN
      INSERT INTO operation_transitions (
        run_id,
        scope_id,
        operation_id,
        transition_seq,
        from_state,
        to_state,
        owner_generation,
        owner_claim_token,
        occurred_at
      ) VALUES (
        NEW.run_id,
        NEW.scope_id,
        NEW.operation_id,
        1,
        NULL,
        'prepared',
        NEW.owner_generation,
        NEW.owner_claim_token,
        NEW.prepared_at
      );
    END`,
  `CREATE TRIGGER operations_record_state_transition
    AFTER UPDATE OF state ON operations
    WHEN OLD.state <> NEW.state
    BEGIN
      UPDATE operation_attempts
      SET
        outcome = NEW.state,
        terminal_at = coalesce(
          NEW.response_recorded_at,
          NEW.terminal_at
        )
      WHERE
        OLD.state = 'dispatching'
        AND NEW.state IN ('response_recorded', 'failed', 'unknown_after_dispatch')
        AND operation_id = NEW.operation_id
        AND run_id = NEW.run_id
        AND scope_id = NEW.scope_id
        AND attempt = (
          SELECT max(attempt)
          FROM operation_attempts
          WHERE operation_id = NEW.operation_id
            AND run_id = NEW.run_id
            AND scope_id = NEW.scope_id
        )
        AND outcome IS NULL;

      INSERT INTO operation_attempts (
        run_id,
        scope_id,
        operation_id,
        attempt,
        owner_generation,
        owner_claim_token,
        started_at
      )
      SELECT
        NEW.run_id,
        NEW.scope_id,
        NEW.operation_id,
        coalesce((
          SELECT max(attempt) + 1
          FROM operation_attempts
          WHERE
            run_id = NEW.run_id
            AND scope_id = NEW.scope_id
            AND operation_id = NEW.operation_id
        ), 1),
        NEW.owner_generation,
        NEW.owner_claim_token,
        NEW.dispatching_at
      WHERE NEW.state = 'dispatching';

      INSERT INTO operation_transitions (
        run_id,
        scope_id,
        operation_id,
        transition_seq,
        from_state,
        to_state,
        owner_generation,
        owner_claim_token,
        occurred_at
      ) VALUES (
        NEW.run_id,
        NEW.scope_id,
        NEW.operation_id,
        (
          SELECT coalesce(max(transition_seq), 0) + 1
          FROM operation_transitions
          WHERE
            run_id = NEW.run_id
            AND scope_id = NEW.scope_id
            AND operation_id = NEW.operation_id
        ),
        OLD.state,
        NEW.state,
        NEW.owner_generation,
        NEW.owner_claim_token,
        CASE
          WHEN NEW.state = 'dispatching' THEN NEW.dispatching_at
          WHEN NEW.state = 'response_recorded' THEN NEW.response_recorded_at
          ELSE NEW.terminal_at
        END
      );
    END`,
  `CREATE TRIGGER operation_attempts_transition_guard
    BEFORE UPDATE ON operation_attempts
    WHEN NOT (
      OLD.operation_id = NEW.operation_id
      AND OLD.run_id = NEW.run_id
      AND OLD.scope_id = NEW.scope_id
      AND OLD.attempt = NEW.attempt
      AND OLD.owner_generation = NEW.owner_generation
      AND OLD.owner_claim_token = NEW.owner_claim_token
      AND OLD.started_at = NEW.started_at
      AND OLD.outcome IS NULL
      AND OLD.terminal_at IS NULL
      AND NEW.outcome IN ('response_recorded', 'failed', 'unknown_after_dispatch')
      AND NEW.terminal_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM operations
        WHERE
          operations.operation_id = NEW.operation_id
          AND operations.run_id = NEW.run_id
          AND operations.scope_id = NEW.scope_id
          AND operations.state = NEW.outcome
          AND NEW.terminal_at = coalesce(
            operations.response_recorded_at,
            operations.terminal_at
          )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid operation attempt transition');
    END`,
  `CREATE TRIGGER operation_attempts_append_only
    BEFORE DELETE ON operation_attempts
    BEGIN
      SELECT RAISE(ABORT, 'operation attempts are append-only');
    END`,
  `CREATE TRIGGER operation_transitions_immutable_update
    BEFORE UPDATE ON operation_transitions
    BEGIN
      SELECT RAISE(ABORT, 'operation transitions are immutable');
    END`,
  `CREATE TRIGGER operation_transitions_immutable_delete
    BEFORE DELETE ON operation_transitions
    BEGIN
      SELECT RAISE(ABORT, 'operation transitions are immutable');
    END`,
];
