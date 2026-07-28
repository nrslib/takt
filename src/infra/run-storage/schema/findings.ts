const JSON_RECORD_TABLES = [
  ['finding_entries', 'finding_id', '$.id'],
  ['finding_raw_entries', 'raw_finding_id', '$.rawFindingId'],
  ['finding_conflict_entries', 'conflict_id', '$.id'],
  ['finding_interpretation_entries', 'interpretation_key', '$.interpretationKey'],
  ['finding_reviewer_anomaly_entries', 'anomaly_id', '$.id'],
] as const;

export const FINDINGS_DDL = [
  `CREATE TABLE finding_resume_authorities (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    source_run_id TEXT NOT NULL,
    source_scope_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL CHECK (source_revision > 0),
    imported_revision INTEGER NOT NULL CHECK (imported_revision > 0),
    projection_digest TEXT NOT NULL CHECK (
      length(projection_digest) = 64
      AND projection_digest NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (run_id, scope_id),
    FOREIGN KEY (run_id, scope_id)
      REFERENCES scopes(run_id, scope_id) ON DELETE CASCADE,
    FOREIGN KEY (run_id, source_run_id)
      REFERENCES run_ancestry(run_id, ancestor_run_id),
    FOREIGN KEY (run_id, scope_id, imported_revision, projection_digest)
      REFERENCES finding_ledger_revisions(
        run_id, scope_id, revision, projection_digest
      ) DEFERRABLE INITIALLY DEFERRED
  ) STRICT`,
  `CREATE TABLE finding_revision_publications (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    projection_digest TEXT NOT NULL CHECK (
      length(projection_digest) = 64
      AND projection_digest NOT GLOB '*[^0-9a-f]*'
    ),
    published_at INTEGER NOT NULL CHECK (published_at >= 0),
    PRIMARY KEY (run_id, scope_id, revision),
    UNIQUE (run_id, scope_id, revision, projection_digest),
    FOREIGN KEY (run_id, scope_id, revision)
      REFERENCES finding_ledger_revisions(run_id, scope_id, revision)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT`,
  `CREATE TABLE finding_ledger_revisions (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    workflow_name TEXT NOT NULL CHECK (length(workflow_name) > 0),
    next_id INTEGER NOT NULL CHECK (next_id > 0),
    finding_count INTEGER NOT NULL CHECK (finding_count >= 0),
    raw_finding_count INTEGER NOT NULL CHECK (raw_finding_count >= 0),
    conflict_count INTEGER NOT NULL CHECK (conflict_count >= 0),
    interpretation_count INTEGER NOT NULL CHECK (interpretation_count >= 0),
    reviewer_anomaly_count INTEGER NOT NULL CHECK (reviewer_anomaly_count >= 0),
    control_count INTEGER NOT NULL CHECK (control_count >= 0),
    projection_digest TEXT NOT NULL CHECK (
      length(projection_digest) = 64
      AND projection_digest NOT GLOB '*[^0-9a-f]*'
    ),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    PRIMARY KEY (run_id, scope_id, revision),
    UNIQUE (run_id, scope_id, revision, projection_digest),
    FOREIGN KEY (run_id, scope_id)
      REFERENCES scope_runtime(run_id, scope_id) ON DELETE CASCADE,
    FOREIGN KEY (run_id, scope_id, revision, projection_digest)
      REFERENCES finding_revision_publications(
        run_id, scope_id, revision, projection_digest
      ) DEFERRABLE INITIALLY DEFERRED
  ) STRICT`,
  `CREATE TABLE finding_ledger_heads (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    workflow_name TEXT NOT NULL CHECK (length(workflow_name) > 0),
    current_revision INTEGER NOT NULL CHECK (current_revision > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    PRIMARY KEY (run_id, scope_id),
    FOREIGN KEY (run_id, scope_id, current_revision)
      REFERENCES finding_ledger_revisions(run_id, scope_id, revision)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT`,
  `CREATE TABLE finding_ledger_controls (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    control_kind TEXT NOT NULL CHECK (
      control_kind IN (
        'fixpoint',
        'stop_budget',
        'review_integrity',
        'pending_manager_commit'
      )
    ),
    record TEXT NOT NULL CHECK (json_valid(record)),
    digest TEXT NOT NULL CHECK (
      length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (run_id, scope_id, revision, control_kind),
    FOREIGN KEY (run_id, scope_id, revision)
      REFERENCES finding_ledger_revisions(run_id, scope_id, revision)
      ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
  ) STRICT`,
  `CREATE TABLE finding_adjudication_reservations (
    run_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    reservation_token TEXT NOT NULL CHECK (length(reservation_token) > 0),
    claimed_at INTEGER NOT NULL CHECK (claimed_at >= 0),
    PRIMARY KEY (run_id, scope_id, reservation_token),
    FOREIGN KEY (run_id, scope_id)
      REFERENCES finding_ledger_heads(run_id, scope_id) ON DELETE CASCADE
  ) STRICT`,
];

for (const [table, idColumn, jsonPath] of JSON_RECORD_TABLES) {
  FINDINGS_DDL.push(
    `CREATE TABLE ${table} (
      run_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      ${idColumn} TEXT NOT NULL CHECK (length(${idColumn}) > 0),
      record TEXT NOT NULL CHECK (
        json_valid(record)
        AND json_extract(record, '${jsonPath}') = ${idColumn}
      ),
      digest TEXT NOT NULL CHECK (
        length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'
      ),
      PRIMARY KEY (run_id, scope_id, revision, ordinal),
      UNIQUE (run_id, scope_id, revision, ${idColumn}),
      FOREIGN KEY (run_id, scope_id, revision)
        REFERENCES finding_ledger_revisions(run_id, scope_id, revision)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
    ) STRICT`,
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

FINDINGS_DDL.push(
  `CREATE TRIGGER finding_ledger_revision_seal_guard
    BEFORE INSERT ON finding_ledger_revisions
    WHEN NOT (
      NEW.revision = coalesce((
        SELECT current_revision + 1
        FROM finding_ledger_heads
        WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id
      ), 1)
      AND NEW.finding_count = (
        SELECT count(*) FROM finding_entries
        WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id
          AND revision = NEW.revision
      )
      AND NEW.raw_finding_count = (
        SELECT count(*) FROM finding_raw_entries
        WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id
          AND revision = NEW.revision
      )
      AND NEW.conflict_count = (
        SELECT count(*) FROM finding_conflict_entries
        WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id
          AND revision = NEW.revision
      )
      AND NEW.interpretation_count = (
        SELECT count(*) FROM finding_interpretation_entries
        WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id
          AND revision = NEW.revision
      )
      AND NEW.reviewer_anomaly_count = (
        SELECT count(*) FROM finding_reviewer_anomaly_entries
        WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id
          AND revision = NEW.revision
      )
      AND NEW.control_count = (
        SELECT count(*) FROM finding_ledger_controls
        WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id
          AND revision = NEW.revision
      )
      AND coalesce((
        SELECT workflow_name
        FROM finding_ledger_heads
        WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id
      ), NEW.workflow_name) = NEW.workflow_name
      AND EXISTS (
        SELECT 1 FROM finding_revision_publications
        WHERE
          run_id = NEW.run_id
          AND scope_id = NEW.scope_id
          AND revision = NEW.revision
          AND projection_digest = NEW.projection_digest
          AND published_at = NEW.updated_at
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'finding ledger revision is incomplete');
    END`,
  `CREATE TRIGGER finding_ledger_revision_advance_head
    AFTER INSERT ON finding_ledger_revisions
    BEGIN
      INSERT INTO finding_ledger_heads (
        run_id, scope_id, workflow_name, current_revision, updated_at
      ) VALUES (
        NEW.run_id, NEW.scope_id, NEW.workflow_name, NEW.revision, NEW.updated_at
      )
      ON CONFLICT (run_id, scope_id) DO UPDATE SET
        current_revision = excluded.current_revision,
        updated_at = excluded.updated_at;
    END`,
  `CREATE TRIGGER finding_ledger_head_insert_guard
    BEFORE INSERT ON finding_ledger_heads
    WHEN NOT EXISTS (
      SELECT 1 FROM finding_ledger_revisions
      WHERE
        run_id = NEW.run_id
        AND scope_id = NEW.scope_id
        AND revision = NEW.current_revision
        AND workflow_name = NEW.workflow_name
        AND updated_at = NEW.updated_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'finding ledger head is derived from a sealed revision');
    END`,
  `CREATE TRIGGER finding_ledger_head_transition_guard
    BEFORE UPDATE ON finding_ledger_heads
    WHEN NOT (
      NEW.run_id IS OLD.run_id
      AND NEW.scope_id IS OLD.scope_id
      AND NEW.workflow_name IS OLD.workflow_name
      AND NEW.current_revision = OLD.current_revision + 1
      AND NEW.updated_at >= OLD.updated_at
      AND EXISTS (
        SELECT 1 FROM finding_ledger_revisions
        WHERE
          run_id = NEW.run_id
          AND scope_id = NEW.scope_id
          AND revision = NEW.current_revision
          AND workflow_name = NEW.workflow_name
          AND updated_at = NEW.updated_at
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid finding ledger head transition');
    END`,
  `CREATE TRIGGER finding_ledger_heads_delete_guard
    BEFORE DELETE ON finding_ledger_heads
    BEGIN
      SELECT RAISE(ABORT, 'finding ledger authority cannot be deleted');
    END`,
  `CREATE TRIGGER finding_ledger_revisions_update_guard
    BEFORE UPDATE ON finding_ledger_revisions
    BEGIN
      SELECT RAISE(ABORT, 'finding ledger revisions are append-only');
    END`,
  `CREATE TRIGGER finding_revision_publications_update_guard
    BEFORE UPDATE ON finding_revision_publications
    BEGIN
      SELECT RAISE(ABORT, 'finding revision publications are append-only');
    END`,
  `CREATE TRIGGER finding_revision_publications_delete_guard
    BEFORE DELETE ON finding_revision_publications
    BEGIN
      SELECT RAISE(ABORT, 'finding revision publications cannot be deleted');
    END`,
  `CREATE TRIGGER finding_ledger_revisions_delete_guard
    BEFORE DELETE ON finding_ledger_revisions
    BEGIN
      SELECT RAISE(ABORT, 'finding ledger revisions cannot be deleted');
    END`,
  `CREATE TRIGGER finding_ledger_controls_update_guard
    BEFORE UPDATE ON finding_ledger_controls
    BEGIN
      SELECT RAISE(ABORT, 'finding ledger controls are append-only');
    END`,
  `CREATE TRIGGER finding_ledger_controls_delete_guard
    BEFORE DELETE ON finding_ledger_controls
    BEGIN
      SELECT RAISE(ABORT, 'finding ledger controls cannot be deleted');
    END`,
);

export const FINDING_AUTHORITY_TABLES = Object.freeze([
  'finding_resume_authorities',
  'finding_revision_publications',
  'finding_ledger_revisions',
  'finding_ledger_heads',
  'finding_entries',
  'finding_raw_entries',
  'finding_conflict_entries',
  'finding_interpretation_entries',
  'finding_reviewer_anomaly_entries',
  'finding_ledger_controls',
  'finding_adjudication_reservations',
]);

for (const table of FINDING_AUTHORITY_TABLES) {
  FINDINGS_DDL.push(`CREATE TRIGGER ${table}_requires_finding_contract
    BEFORE INSERT ON ${table}
    WHEN NOT EXISTS (
      SELECT 1
      FROM scopes
      WHERE
        run_id = NEW.run_id
        AND scope_id = NEW.scope_id
        AND finding_contract_enabled = 1
    )
    BEGIN
      SELECT RAISE(ABORT, 'Finding Contract is disabled');
    END`);
}

FINDINGS_DDL.push(
  `CREATE TRIGGER finding_resume_authorities_update_guard
    BEFORE UPDATE ON finding_resume_authorities
    BEGIN
      SELECT RAISE(ABORT, 'finding resume authority is immutable');
    END`,
  `CREATE TRIGGER finding_resume_authorities_delete_guard
    BEFORE DELETE ON finding_resume_authorities
    BEGIN
      SELECT RAISE(ABORT, 'finding resume authority cannot be deleted');
    END`,
);
