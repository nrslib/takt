export const REPORTS_DDL = [
  `CREATE TABLE report_streams (
    run_id TEXT NOT NULL,
    owner_scope_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    stream_name TEXT NOT NULL CHECK (length(stream_name) > 0),
    portable_identity TEXT NOT NULL CHECK (length(portable_identity) > 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (run_id, owner_scope_id, stream_id),
    UNIQUE (run_id, owner_scope_id, portable_identity),
    FOREIGN KEY (run_id, owner_scope_id)
      REFERENCES scope_runtime(run_id, scope_id) ON DELETE CASCADE
  ) STRICT`,
  `CREATE TABLE report_revisions (
    run_id TEXT NOT NULL,
    owner_scope_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    publication_id TEXT NOT NULL CHECK (length(publication_id) > 0),
    publication_key TEXT NOT NULL CHECK (length(publication_key) > 0),
    producer_scope_id TEXT NOT NULL,
    producer_execution_id TEXT NOT NULL,
    producer_step_id TEXT NOT NULL CHECK (length(producer_step_id) > 0),
    producer_run_session_id TEXT,
    producer_persona_session_id TEXT,
    producer_persona_name TEXT,
    codec_name TEXT NOT NULL REFERENCES storage_codecs(codec_name),
    content TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (
      length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (run_id, owner_scope_id, stream_id, revision),
    UNIQUE (run_id, owner_scope_id, publication_id),
    UNIQUE (run_id, owner_scope_id, publication_key),
    FOREIGN KEY (run_id, owner_scope_id, stream_id)
      REFERENCES report_streams(run_id, owner_scope_id, stream_id)
      ON DELETE CASCADE,
    FOREIGN KEY (run_id, producer_scope_id, producer_execution_id)
      REFERENCES step_executions(run_id, scope_id, execution_id),
    FOREIGN KEY (run_id, producer_scope_id, producer_run_session_id)
      REFERENCES run_sessions(run_id, scope_id, session_id),
    FOREIGN KEY (run_id, producer_scope_id, producer_persona_session_id)
      REFERENCES persona_sessions(run_id, scope_id, persona_session_id),
    CHECK (
      (producer_persona_session_id IS NULL AND producer_persona_name IS NULL)
      OR (
        producer_persona_session_id IS NOT NULL
        AND producer_persona_name IS NOT NULL
        AND length(producer_persona_name) > 0
      )
    )
  ) STRICT`,
  `CREATE TRIGGER report_revisions_producer_identity_guard
    BEFORE INSERT ON report_revisions
    WHEN NOT EXISTS (
      SELECT 1
      FROM step_executions
      WHERE
        run_id = NEW.run_id
        AND scope_id = NEW.producer_scope_id
        AND execution_id = NEW.producer_execution_id
        AND step_id = NEW.producer_step_id
        AND run_session_id IS NEW.producer_run_session_id
        AND persona_session_id IS NEW.producer_persona_session_id
        AND (
          NEW.producer_persona_session_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM persona_sessions
            WHERE
              run_id = NEW.run_id
              AND scope_id = NEW.producer_scope_id
              AND persona_session_id = NEW.producer_persona_session_id
              AND persona_name = NEW.producer_persona_name
          )
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'report producer identity mismatch');
    END`,
  `CREATE TRIGGER report_revisions_producer_terminal_seal
    BEFORE INSERT ON report_revisions
    WHEN EXISTS (
      SELECT 1
      FROM scope_runtime
      JOIN runs USING (run_id)
      WHERE
        scope_runtime.run_id = NEW.run_id
        AND scope_runtime.scope_id = NEW.producer_scope_id
        AND (
          scope_runtime.status IN ('completed', 'failed', 'cancelled')
          OR runs.status IN ('completed', 'failed', 'cancelled')
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'terminal report producer authority is sealed');
    END`,
  `CREATE TRIGGER report_streams_identity_guard
    BEFORE UPDATE ON report_streams
    BEGIN
      SELECT RAISE(ABORT, 'report stream identity is immutable');
    END`,
  `CREATE TRIGGER report_streams_delete_guard
    BEFORE DELETE ON report_streams
    BEGIN
      SELECT RAISE(ABORT, 'report streams cannot be deleted');
    END`,
  `CREATE TRIGGER report_revisions_sequence_guard
    BEFORE INSERT ON report_revisions
    WHEN NEW.revision <> (
      SELECT count(*) + 1
      FROM report_revisions
      WHERE
        run_id = NEW.run_id
        AND owner_scope_id = NEW.owner_scope_id
        AND stream_id = NEW.stream_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid report revision sequence');
    END`,
  `CREATE TRIGGER report_revisions_update_guard
    BEFORE UPDATE ON report_revisions
    BEGIN
      SELECT RAISE(ABORT, 'report revisions are append-only');
    END`,
  `CREATE TRIGGER report_revisions_delete_guard
    BEFORE DELETE ON report_revisions
    BEGIN
      SELECT RAISE(ABORT, 'report revisions cannot be deleted');
    END`,
];
