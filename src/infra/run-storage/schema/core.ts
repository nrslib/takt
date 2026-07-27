export const CORE_DDL = [
  `CREATE TABLE storage_contract (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    database_instance_id TEXT NOT NULL UNIQUE CHECK (
      length(database_instance_id) = 36
      AND substr(database_instance_id, 9, 1) = '-'
      AND substr(database_instance_id, 14, 1) = '-'
      AND substr(database_instance_id, 19, 1) = '-'
      AND substr(database_instance_id, 24, 1) = '-'
      AND replace(database_instance_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    application_id INTEGER NOT NULL CHECK (application_id = 1413565268),
    schema_hash TEXT NOT NULL CHECK (
      length(schema_hash) = 64 AND schema_hash NOT GLOB '*[^0-9a-f]*'
    ),
    fingerprint TEXT NOT NULL CHECK (
      length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
    )
  ) STRICT`,
  `CREATE TABLE storage_codecs (
    codec_name TEXT PRIMARY KEY,
    content_kind TEXT NOT NULL CHECK (content_kind IN ('json', 'text')),
    digest_algorithm TEXT NOT NULL CHECK (digest_algorithm = 'sha256')
  ) STRICT`,
  `CREATE TABLE engine_builds (
    build_id TEXT PRIMARY KEY,
    version TEXT NOT NULL CHECK (length(version) > 0),
    digest TEXT NOT NULL CHECK (
      length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'
    )
  ) STRICT`,
  `CREATE TABLE workflow_definitions (
    definition_id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) > 0),
    codec_name TEXT NOT NULL REFERENCES storage_codecs(codec_name),
    definition TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (
      length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'
    )
  ) STRICT`,
  `CREATE TABLE runs (
    singleton_id INTEGER PRIMARY KEY DEFAULT 1 CHECK (singleton_id = 1),
    run_id TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE CHECK (
      length(slug) > 0 AND slug NOT LIKE '%/%' AND slug NOT LIKE '%\\%'
    ),
    engine_build_id TEXT NOT NULL REFERENCES engine_builds(build_id),
    workflow_definition_id TEXT NOT NULL REFERENCES workflow_definitions(definition_id),
    finding_contract_enabled INTEGER NOT NULL CHECK (finding_contract_enabled IN (0, 1)),
    status TEXT NOT NULL CHECK (
      status IN ('running', 'completed', 'failed', 'cancelled')
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    terminal_at INTEGER,
    CHECK (
      (status = 'running' AND terminal_at IS NULL)
      OR (status <> 'running' AND terminal_at IS NOT NULL)
    )
  ) STRICT`,
  `CREATE TABLE run_ancestry (
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    ancestor_run_id TEXT NOT NULL,
    depth INTEGER NOT NULL CHECK (depth > 0),
    snapshot_digest TEXT NOT NULL CHECK (
      length(snapshot_digest) = 64 AND snapshot_digest NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (run_id, ancestor_run_id),
    UNIQUE (run_id, depth)
  ) STRICT`,
  `CREATE TABLE run_resume_sources (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    source_run_id TEXT NOT NULL,
    source_snapshot_digest TEXT NOT NULL CHECK (
      length(source_snapshot_digest) = 64
      AND source_snapshot_digest NOT GLOB '*[^0-9a-f]*'
    ),
    source_finding_scope_id TEXT,
    source_finding_revision INTEGER CHECK (source_finding_revision > 0),
    imported_finding_revision INTEGER CHECK (imported_finding_revision > 0),
    source_finding_projection_digest TEXT CHECK (
      source_finding_projection_digest IS NULL
      OR (
        length(source_finding_projection_digest) = 64
        AND source_finding_projection_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    CHECK (
      (
        source_finding_scope_id IS NULL
        AND source_finding_revision IS NULL
        AND imported_finding_revision IS NULL
        AND source_finding_projection_digest IS NULL
      )
      OR (
        source_finding_scope_id IS NOT NULL
        AND source_finding_revision IS NOT NULL
        AND imported_finding_revision IS NOT NULL
        AND source_finding_projection_digest IS NOT NULL
      )
    ),
    FOREIGN KEY (run_id, source_run_id)
      REFERENCES run_ancestry(run_id, ancestor_run_id)
  ) STRICT`,
  `CREATE TABLE run_sessions (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    session_key TEXT NOT NULL CHECK (length(session_key) > 0),
    started_at INTEGER NOT NULL CHECK (started_at >= 0),
    ended_at INTEGER,
    PRIMARY KEY (run_id, scope_id, session_id),
    UNIQUE (run_id, scope_id, session_key),
    FOREIGN KEY (run_id, scope_id)
      REFERENCES scopes(run_id, scope_id) ON DELETE CASCADE,
    CHECK (ended_at IS NULL OR ended_at >= started_at)
  ) STRICT`,
  `CREATE TABLE run_leases (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    generation INTEGER NOT NULL CHECK (generation > 0),
    owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
    claim_token TEXT NOT NULL CHECK (length(claim_token) > 0),
    claimed_at INTEGER NOT NULL CHECK (claimed_at >= 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > claimed_at),
    heartbeat_at INTEGER NOT NULL CHECK (heartbeat_at >= claimed_at),
    released_at INTEGER,
    terminalized_at INTEGER,
    terminal_status TEXT CHECK (
      terminal_status IN ('completed', 'failed', 'cancelled')
    ),
    validation_count INTEGER NOT NULL DEFAULT 0 CHECK (validation_count >= 0),
    CHECK (released_at IS NULL OR released_at >= claimed_at),
    CHECK (terminalized_at IS NULL OR terminalized_at >= claimed_at),
    CHECK (
      (terminalized_at IS NULL AND terminal_status IS NULL)
      OR (terminalized_at IS NOT NULL AND terminal_status IS NOT NULL)
    )
  ) STRICT`,
  `CREATE TABLE run_events (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    event_seq INTEGER NOT NULL CHECK (event_seq > 0),
    event_type TEXT NOT NULL CHECK (length(event_type) > 0),
    codec_name TEXT REFERENCES storage_codecs(codec_name),
    payload TEXT,
    payload_digest TEXT,
    occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
    CHECK (
      (codec_name IS NULL AND payload IS NULL AND payload_digest IS NULL)
      OR (
        codec_name IS NOT NULL
        AND payload IS NOT NULL
        AND payload_digest IS NOT NULL
        AND length(payload_digest) = 64
        AND payload_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    PRIMARY KEY (run_id, scope_id, event_seq),
    FOREIGN KEY (run_id, scope_id) REFERENCES scopes(run_id, scope_id) ON DELETE CASCADE
  ) STRICT`,
  `CREATE TABLE scopes (
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    scope_id TEXT NOT NULL CHECK (length(scope_id) > 0),
    parent_scope_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('root', 'workflow_call', 'parallel')),
    workflow_definition_id TEXT NOT NULL REFERENCES workflow_definitions(definition_id),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    terminal_at INTEGER,
    PRIMARY KEY (run_id, scope_id),
    FOREIGN KEY (run_id, parent_scope_id) REFERENCES scopes(run_id, scope_id),
    FOREIGN KEY (run_id, scope_id)
      REFERENCES scope_runtime(run_id, scope_id)
      DEFERRABLE INITIALLY DEFERRED,
    CHECK (
      (kind = 'root' AND parent_scope_id IS NULL)
      OR (kind IN ('workflow_call', 'parallel') AND parent_scope_id IS NOT NULL)
    )
  ) STRICT`,
  `CREATE UNIQUE INDEX scopes_one_root_per_run
    ON scopes(run_id)
    WHERE kind = 'root'`,
  `CREATE TRIGGER child_scope_parent_guard
    BEFORE INSERT ON scopes
    WHEN
      NEW.kind <> 'root'
      AND NOT EXISTS (
        SELECT 1
        FROM scopes AS parent
        JOIN scope_runtime AS parent_runtime
          ON parent_runtime.run_id = parent.run_id
          AND parent_runtime.scope_id = parent.scope_id
        WHERE
          parent.run_id = NEW.run_id
          AND parent.scope_id = NEW.parent_scope_id
          AND parent.terminal_at IS NULL
          AND parent_runtime.status IN ('ready', 'running')
          AND (
            NEW.kind <> 'parallel'
            OR NEW.workflow_definition_id = parent.workflow_definition_id
          )
      )
    BEGIN
      SELECT RAISE(ABORT, 'child scope parent relationship is invalid');
    END`,
  `CREATE TABLE scope_runtime (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    current_step_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('ready', 'running', 'completed', 'failed', 'cancelled')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    PRIMARY KEY (run_id, scope_id),
    FOREIGN KEY (run_id, scope_id)
      REFERENCES scopes(run_id, scope_id) ON DELETE CASCADE
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT`,
  `CREATE TRIGGER storage_contract_instance_identity_immutable
    BEFORE UPDATE OF database_instance_id ON storage_contract
    WHEN NEW.database_instance_id <> OLD.database_instance_id
    BEGIN
      SELECT RAISE(ABORT, 'database instance identity is immutable');
    END`,
  `CREATE TRIGGER runs_exactly_one_delete_guard
    BEFORE DELETE ON runs
    BEGIN
      SELECT RAISE(ABORT, 'the authoritative run cannot be deleted');
    END`,
  `CREATE TRIGGER runs_identity_immutable
    BEFORE UPDATE ON runs
    WHEN
      NEW.singleton_id <> OLD.singleton_id
      OR NEW.run_id <> OLD.run_id
      OR NEW.slug <> OLD.slug
      OR NEW.engine_build_id <> OLD.engine_build_id
      OR NEW.workflow_definition_id <> OLD.workflow_definition_id
      OR NEW.finding_contract_enabled <> OLD.finding_contract_enabled
      OR NEW.created_at <> OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'run authority identity is immutable');
    END`,
  `CREATE TRIGGER runs_state_transition_guard
    BEFORE UPDATE ON runs
    WHEN NOT (
      OLD.status = 'running'
      AND OLD.terminal_at IS NULL
      AND NEW.status IN ('completed', 'failed', 'cancelled')
      AND NEW.terminal_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM run_leases
        WHERE
          run_leases.run_id = NEW.run_id
          AND run_leases.terminalized_at = NEW.terminal_at
          AND run_leases.terminal_status = NEW.status
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'run state transition is terminal and one-way');
    END`,
  `CREATE TRIGGER run_ancestry_update_guard
    BEFORE UPDATE ON run_ancestry
    BEGIN
      SELECT RAISE(ABORT, 'run ancestry is immutable');
    END`,
  `CREATE TRIGGER run_ancestry_delete_guard
    BEFORE DELETE ON run_ancestry
    BEGIN
      SELECT RAISE(ABORT, 'run ancestry cannot be deleted');
    END`,
  `CREATE TRIGGER run_resume_sources_update_guard
    BEFORE UPDATE ON run_resume_sources
    BEGIN
      SELECT RAISE(ABORT, 'run resume source is immutable');
    END`,
  `CREATE TRIGGER run_resume_sources_delete_guard
    BEFORE DELETE ON run_resume_sources
    BEGIN
      SELECT RAISE(ABORT, 'run resume source cannot be deleted');
    END`,
  `CREATE TRIGGER run_leases_delete_guard
    BEFORE DELETE ON run_leases
    BEGIN
      SELECT RAISE(ABORT, 'run lease authority cannot be deleted');
    END`,
  `CREATE TRIGGER run_leases_initial_claim_guard
    BEFORE INSERT ON run_leases
    WHEN NOT (
      NEW.generation = 1
      AND NEW.claimed_at = NEW.heartbeat_at
      AND NEW.expires_at > NEW.claimed_at
      AND NEW.released_at IS NULL
      AND NEW.terminalized_at IS NULL
      AND NEW.terminal_status IS NULL
      AND NEW.validation_count = 0
      AND EXISTS (
        SELECT 1 FROM runs
        WHERE runs.run_id = NEW.run_id AND runs.status = 'running'
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'initial lease claim is incomplete');
    END`,
  `CREATE TRIGGER run_leases_legal_update_guard
    BEFORE UPDATE ON run_leases
    WHEN NOT (
      (
        NEW.run_id IS OLD.run_id
        AND NEW.generation IS OLD.generation
        AND NEW.owner_id IS OLD.owner_id
        AND NEW.claim_token IS OLD.claim_token
        AND NEW.claimed_at IS OLD.claimed_at
        AND NEW.expires_at IS OLD.expires_at
        AND NEW.heartbeat_at IS OLD.heartbeat_at
        AND NEW.released_at IS OLD.released_at
        AND NEW.terminalized_at IS OLD.terminalized_at
        AND NEW.terminal_status IS OLD.terminal_status
        AND NEW.validation_count = OLD.validation_count + 1
        AND OLD.released_at IS NULL
        AND OLD.terminalized_at IS NULL
        AND EXISTS (
          SELECT 1 FROM runs
          WHERE runs.run_id = NEW.run_id AND runs.status = 'running'
        )
      )
      OR (
        NEW.run_id IS OLD.run_id
        AND NEW.generation IS OLD.generation
        AND NEW.owner_id IS OLD.owner_id
        AND NEW.claim_token IS OLD.claim_token
        AND NEW.claimed_at IS OLD.claimed_at
        AND NEW.heartbeat_at >= OLD.heartbeat_at
        AND NEW.expires_at > NEW.heartbeat_at
        AND NEW.released_at IS OLD.released_at
        AND NEW.terminalized_at IS OLD.terminalized_at
        AND NEW.terminal_status IS OLD.terminal_status
        AND NEW.validation_count IS OLD.validation_count
        AND OLD.released_at IS NULL
        AND OLD.terminalized_at IS NULL
        AND EXISTS (
          SELECT 1 FROM runs
          WHERE runs.run_id = NEW.run_id AND runs.status = 'running'
        )
      )
      OR (
        NEW.run_id IS OLD.run_id
        AND NEW.generation IS OLD.generation
        AND NEW.owner_id IS OLD.owner_id
        AND NEW.claim_token IS OLD.claim_token
        AND NEW.claimed_at IS OLD.claimed_at
        AND NEW.expires_at IS OLD.expires_at
        AND NEW.heartbeat_at IS OLD.heartbeat_at
        AND OLD.released_at IS NULL
        AND NEW.released_at >= NEW.heartbeat_at
        AND NEW.terminalized_at IS OLD.terminalized_at
        AND NEW.terminal_status IS OLD.terminal_status
        AND NEW.validation_count IS OLD.validation_count
        AND OLD.terminalized_at IS NULL
        AND EXISTS (
          SELECT 1 FROM runs
          WHERE runs.run_id = NEW.run_id AND runs.status = 'running'
        )
      )
      OR (
        NEW.run_id IS OLD.run_id
        AND NEW.generation IS OLD.generation
        AND NEW.owner_id IS OLD.owner_id
        AND NEW.claim_token IS OLD.claim_token
        AND NEW.claimed_at IS OLD.claimed_at
        AND NEW.expires_at IS OLD.expires_at
        AND NEW.heartbeat_at IS OLD.heartbeat_at
        AND NEW.released_at IS OLD.released_at
        AND OLD.terminalized_at IS NULL
        AND NEW.terminalized_at >= NEW.heartbeat_at
        AND NEW.terminal_status IN ('completed', 'failed', 'cancelled')
        AND NEW.validation_count IS OLD.validation_count
        AND OLD.released_at IS NULL
        AND EXISTS (
          SELECT 1 FROM runs
          WHERE runs.run_id = NEW.run_id AND runs.status = 'running'
        )
      )
      OR (
        NEW.run_id IS OLD.run_id
        AND NEW.generation = OLD.generation + 1
        AND NEW.claimed_at >= OLD.claimed_at
        AND NEW.expires_at > NEW.claimed_at
        AND NEW.heartbeat_at IS NEW.claimed_at
        AND NEW.released_at IS NULL
        AND NEW.terminalized_at IS NULL
        AND NEW.terminal_status IS NULL
        AND NEW.validation_count = 0
        AND OLD.terminalized_at IS NULL
        AND OLD.terminal_status IS NULL
        AND EXISTS (
          SELECT 1 FROM runs
          WHERE runs.run_id = NEW.run_id AND runs.status = 'running'
        )
        AND (
          OLD.released_at IS NOT NULL
          OR OLD.expires_at <= NEW.claimed_at
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'illegal run lease transition');
    END`,
  `CREATE TRIGGER run_leases_apply_terminal_state
    AFTER UPDATE OF terminalized_at, terminal_status ON run_leases
    WHEN
      OLD.terminalized_at IS NULL
      AND NEW.terminalized_at IS NOT NULL
      AND NEW.terminal_status IS NOT NULL
    BEGIN
      UPDATE runs
      SET status = NEW.terminal_status, terminal_at = NEW.terminalized_at
      WHERE run_id = NEW.run_id AND status = 'running';
      SELECT CASE
        WHEN changes() <> 1
        THEN RAISE(ABORT, 'run and lease terminal state must advance together')
      END;
    END`,
  `CREATE TRIGGER root_scope_delete_guard
    BEFORE DELETE ON scopes
    WHEN OLD.kind = 'root'
    BEGIN
      SELECT RAISE(ABORT, 'root scope cannot be deleted');
    END`,
  `CREATE TRIGGER root_scope_identity_guard
    BEFORE UPDATE ON scopes
    WHEN
      OLD.kind = 'root'
      AND (
        NEW.run_id <> OLD.run_id
        OR NEW.scope_id <> OLD.scope_id
        OR NEW.parent_scope_id IS NOT OLD.parent_scope_id
        OR NEW.kind <> OLD.kind
        OR NEW.workflow_definition_id <> OLD.workflow_definition_id
        OR NEW.created_at <> OLD.created_at
        OR (
          OLD.terminal_at IS NOT NULL
          AND NEW.terminal_at IS NOT OLD.terminal_at
        )
        OR (
          OLD.terminal_at IS NULL
          AND NEW.terminal_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM scope_runtime
            WHERE
              scope_runtime.run_id = OLD.run_id
              AND scope_runtime.scope_id = OLD.scope_id
              AND scope_runtime.status IN ('completed', 'failed', 'cancelled')
              AND scope_runtime.updated_at = NEW.terminal_at
          )
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'root scope identity is immutable');
    END`,
  `CREATE TRIGGER child_scope_identity_guard
    BEFORE UPDATE ON scopes
    WHEN
      OLD.kind <> 'root'
      AND (
        NEW.run_id <> OLD.run_id
        OR NEW.scope_id <> OLD.scope_id
        OR NEW.parent_scope_id IS NOT OLD.parent_scope_id
        OR NEW.kind <> OLD.kind
        OR NEW.workflow_definition_id <> OLD.workflow_definition_id
        OR NEW.created_at <> OLD.created_at
        OR (
          OLD.terminal_at IS NOT NULL
          AND NEW.terminal_at IS NOT OLD.terminal_at
        )
        OR (
          OLD.terminal_at IS NULL
          AND NEW.terminal_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM scope_runtime
            WHERE
              scope_runtime.run_id = OLD.run_id
              AND scope_runtime.scope_id = OLD.scope_id
              AND scope_runtime.status IN ('completed', 'failed', 'cancelled')
              AND scope_runtime.updated_at = NEW.terminal_at
          )
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'child scope identity or terminal state is immutable');
    END`,
  `CREATE TRIGGER root_scope_runtime_delete_guard
    BEFORE DELETE ON scope_runtime
    WHEN EXISTS (
      SELECT 1
      FROM scopes
      WHERE
        scopes.run_id = OLD.run_id
        AND scopes.scope_id = OLD.scope_id
        AND scopes.kind = 'root'
    )
    BEGIN
      SELECT RAISE(ABORT, 'root scope runtime cannot be deleted');
    END`,
  `CREATE TRIGGER root_scope_runtime_identity_guard
    BEFORE UPDATE ON scope_runtime
    WHEN
      EXISTS (
        SELECT 1
        FROM scopes
        WHERE
          scopes.run_id = OLD.run_id
          AND scopes.scope_id = OLD.scope_id
          AND scopes.kind = 'root'
      )
      AND (
        NEW.run_id <> OLD.run_id
        OR NEW.scope_id <> OLD.scope_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'root scope runtime identity is immutable');
    END`,
  `CREATE TRIGGER scope_runtime_transition_guard
    BEFORE UPDATE OF current_step_id, status, revision, updated_at ON scope_runtime
    WHEN
      (
        NEW.current_step_id IS NOT OLD.current_step_id
        OR NEW.status IS NOT OLD.status
        OR NEW.revision IS NOT OLD.revision
      )
      AND NOT (
      NEW.run_id IS OLD.run_id
      AND NEW.scope_id IS OLD.scope_id
      AND NEW.revision = OLD.revision + 1
      AND NEW.updated_at >= OLD.updated_at
      AND (
        (OLD.status = 'ready' AND NEW.status IN ('running', 'completed', 'failed', 'cancelled'))
        OR (OLD.status = 'running' AND NEW.status IN ('running', 'completed', 'failed', 'cancelled'))
      )
      AND (
        NEW.status <> 'running'
        OR NEW.current_step_id IS NOT NULL
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid scope runtime transition');
    END`,
  `CREATE TRIGGER scope_runtime_apply_terminal_state
    AFTER UPDATE OF status ON scope_runtime
    WHEN
      OLD.status IN ('ready', 'running')
      AND NEW.status IN ('completed', 'failed', 'cancelled')
    BEGIN
      UPDATE scopes
      SET terminal_at = NEW.updated_at
      WHERE
        run_id = NEW.run_id
        AND scope_id = NEW.scope_id
        AND terminal_at IS NULL;
      SELECT CASE
        WHEN changes() <> 1
        THEN RAISE(ABORT, 'scope and runtime terminal state must advance together')
      END;
    END`,
  `CREATE TRIGGER child_scope_delete_guard
    BEFORE DELETE ON scopes
    WHEN OLD.kind <> 'root'
    BEGIN
      SELECT RAISE(ABORT, 'child scope cannot be deleted');
    END`,
  `CREATE TRIGGER child_scope_runtime_delete_guard
    BEFORE DELETE ON scope_runtime
    WHEN EXISTS (
      SELECT 1
      FROM scopes
      WHERE
        scopes.run_id = OLD.run_id
        AND scopes.scope_id = OLD.scope_id
        AND scopes.kind <> 'root'
    )
    BEGIN
      SELECT RAISE(ABORT, 'child scope runtime cannot be deleted');
    END`,
  `CREATE TRIGGER run_events_delete_guard
    BEFORE DELETE ON run_events
    BEGIN
      SELECT RAISE(ABORT, 'run events cannot be deleted');
    END`,
  `CREATE TRIGGER run_events_update_guard
    BEFORE UPDATE ON run_events
    BEGIN
      SELECT RAISE(ABORT, 'run events are append-only');
    END`,
  `CREATE TRIGGER run_events_sequence_guard
    BEFORE INSERT ON run_events
    WHEN NEW.event_seq <> (
      SELECT count(*) + 1
      FROM run_events
      WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid run event sequence');
    END`,
  `CREATE TRIGGER run_sessions_identity_guard
    BEFORE UPDATE ON run_sessions
    WHEN NOT (
      NEW.run_id IS OLD.run_id
      AND NEW.scope_id IS OLD.scope_id
      AND NEW.session_id IS OLD.session_id
      AND NEW.session_key IS OLD.session_key
      AND NEW.started_at IS OLD.started_at
      AND OLD.ended_at IS NULL
      AND NEW.ended_at >= OLD.started_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid run session transition');
    END`,
  `CREATE TRIGGER run_sessions_delete_guard
    BEFORE DELETE ON run_sessions
    BEGIN
      SELECT RAISE(ABORT, 'run sessions cannot be deleted');
    END`,
];
