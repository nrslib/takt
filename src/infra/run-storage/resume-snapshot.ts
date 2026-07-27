import type { RunReadContext } from './context.js';
import {
  readFindingLedgerProjection,
  validateFindingAuthority,
} from './finding-ledger.js';
import {
  operationRecordFromRow,
  type OperationRow,
} from './operation-record.js';
import {
  readAllFindingEntries,
  readFindingControls,
} from './resume-finding-query.js';
import { readScopeSnapshot } from './resume-scope-query.js';
import type {
  CompleteResumeSnapshot,
  SnapshotRow,
} from './resume-snapshot-types.js';
import {
  assertOperationIdentities,
  assertReportIdentities,
  assertRunSessionIdentities,
  assertWorkflowDefinitions,
} from './resume-snapshot-validation.js';
import { validateStoredReportHistory } from './reports.js';

export type {
  CompleteResumeSnapshot,
  ScopeResumeSnapshot,
} from './resume-snapshot-types.js';

export function readCompleteResumeSnapshot(
  context: RunReadContext,
): CompleteResumeSnapshot {
  const run = readRun(context);
  const workflowDefinitions = readWorkflowDefinitions(context);
  const scopeRows = readScopeRows(context, run.runId);
  const operations = readOperations(context, run.runId);
  const sessions = readSessions(context, run.runId);
  const reports = readReports(context, run.runId);
  const finding = run.findingContractEnabled === 1
    ? readFindingProjection(context, run.runId)
    : null;
  return {
    run,
    workflowDefinitions,
    engineBuilds: context.all<SnapshotRow>(`
      SELECT build_id AS buildId, version, digest
      FROM engine_builds
      ORDER BY build_id
    `),
    ancestry: context.all<SnapshotRow>(`
      SELECT
        ancestor_run_id AS ancestorRunId,
        depth,
        snapshot_digest AS snapshotDigest
      FROM run_ancestry
      WHERE run_id = ?
      ORDER BY depth
    `, run.runId),
    scopes: scopeRows.map((scope) => (
      readScopeSnapshot(context, run.runId, scope)
    )),
    sessions,
    leases: context.all<SnapshotRow>(`
      SELECT * FROM run_leases WHERE run_id = ?
    `, run.runId),
    operations,
    operationAttempts: context.all<SnapshotRow>(`
      SELECT attempts.*
      FROM operation_attempts AS attempts
      JOIN operations
        ON operations.run_id = attempts.run_id
        AND operations.scope_id = attempts.scope_id
        AND operations.operation_id = attempts.operation_id
      WHERE operations.run_id = ?
      ORDER BY attempts.started_at, attempts.operation_id, attempts.attempt
    `, run.runId),
    operationTransitions: context.all<SnapshotRow>(`
      SELECT transitions.*
      FROM operation_transitions AS transitions
      JOIN operations
        ON operations.run_id = transitions.run_id
        AND operations.scope_id = transitions.scope_id
        AND operations.operation_id = transitions.operation_id
      WHERE operations.run_id = ?
      ORDER BY
        transitions.occurred_at,
        transitions.operation_id,
        transitions.transition_seq
    `, run.runId),
    reports,
    findingReservations: context.all<SnapshotRow>(`
      SELECT
        scope_id AS scopeId,
        reservation_token AS reservationToken,
        claimed_at AS claimedAt
      FROM finding_adjudication_reservations
      WHERE run_id = ?
      ORDER BY scope_id, reservation_token
    `, run.runId),
    findingPublications: context.all<SnapshotRow>(`
      SELECT
        scope_id AS scopeId,
        revision,
        projection_digest AS projectionDigest,
        published_at AS publishedAt
      FROM finding_revision_publications
      WHERE run_id = ?
      ORDER BY scope_id, revision
    `, run.runId),
    findingRevisions: context.all<SnapshotRow>(`
      SELECT * FROM finding_ledger_revisions
      WHERE run_id = ?
      ORDER BY scope_id, revision
    `, run.runId),
    findingHeads: context.all<SnapshotRow>(`
      SELECT * FROM finding_ledger_heads
      WHERE run_id = ?
      ORDER BY scope_id
    `, run.runId),
    findingEntries: readAllFindingEntries(context, run.runId),
    findingControls: readFindingControls(context, run.runId),
    findingLedger: finding,
  };
}

function readRun(
  context: RunReadContext,
): CompleteResumeSnapshot['run'] {
  const run = context.get<CompleteResumeSnapshot['run']>(`
    SELECT
      run_id AS runId,
      slug,
      engine_build_id AS engineBuildId,
      workflow_definition_id AS workflowDefinitionId,
      finding_contract_enabled AS findingContractEnabled,
      status,
      created_at AS createdAt,
      terminal_at AS terminalAt
    FROM runs
  `);
  if (run === undefined) {
    throw new Error('Run storage has no authoritative run');
  }
  return run;
}

function readScopeRows(
  context: RunReadContext,
  runId: string,
): Array<SnapshotRow & { readonly scopeId: string }> {
  return context.all<SnapshotRow & { readonly scopeId: string }>(`
    SELECT
      scope_id AS scopeId,
      parent_scope_id AS parentScopeId,
      kind,
      workflow_definition_id AS workflowDefinitionId,
      created_at AS createdAt,
      terminal_at AS terminalAt
    FROM scopes
    WHERE run_id = ?
    ORDER BY created_at, scope_id
  `, runId);
}

function readWorkflowDefinitions(
  context: RunReadContext,
): SnapshotRow[] {
  const definitions = context.all<SnapshotRow>(`
    SELECT
      definition_id AS definitionId,
      name,
      codec_name AS codecName,
      definition,
      digest
    FROM workflow_definitions
    ORDER BY definition_id
  `);
  assertWorkflowDefinitions(definitions);
  return definitions;
}

function readOperations(
  context: RunReadContext,
  runId: string,
): CompleteResumeSnapshot['operations'] {
  const operations = context.all<OperationRow>(`
    SELECT
      operation_id AS operationId,
      run_id AS runId,
      scope_id AS scopeId,
      idempotency_key AS idempotencyKey,
      kind,
      state,
      request_codec_name AS requestCodecName,
      request_content AS requestContent,
      request_digest AS requestDigest,
      response_codec_name AS responseCodecName,
      response_content AS responseContent,
      response_digest AS responseDigest,
      error_codec_name AS errorCodecName,
      error_content AS errorContent,
      error_digest AS errorDigest,
      owner_generation AS ownerGeneration,
      owner_claim_token AS ownerClaimToken,
      prepared_at AS preparedAt,
      dispatching_at AS dispatchingAt,
      response_recorded_at AS responseRecordedAt,
      terminal_at AS terminalAt
    FROM operations
    WHERE run_id = ?
    ORDER BY prepared_at, operation_id
  `, runId).map(operationRecordFromRow);
  assertOperationIdentities(operations);
  return operations;
}

function readSessions(
  context: RunReadContext,
  runId: string,
): SnapshotRow[] {
  const sessions = context.all<SnapshotRow>(`
    SELECT
      scope_id AS scopeId,
      session_id AS sessionId,
      session_key AS sessionKey,
      started_at AS startedAt,
      ended_at AS endedAt
    FROM run_sessions
    WHERE run_id = ?
    ORDER BY started_at, scope_id, session_id
  `, runId);
  assertRunSessionIdentities(runId, sessions);
  return sessions;
}

function readReports(
  context: RunReadContext,
  runId: string,
): SnapshotRow[] {
  validateStoredReportHistory(context, runId);
  const reports = context.all<SnapshotRow>(`
    SELECT
      streams.owner_scope_id AS ownerScopeId,
      streams.stream_id AS streamId,
      streams.stream_name AS streamName,
      streams.portable_identity AS portableIdentity,
      streams.created_at AS streamCreatedAt,
      revisions.revision,
      revisions.publication_id AS publicationId,
      revisions.publication_key AS publicationKey,
      revisions.producer_scope_id AS producerScopeId,
      revisions.producer_execution_id AS producerExecutionId,
      revisions.producer_step_id AS producerStepId,
      revisions.producer_run_session_id AS producerRunSessionId,
      revisions.producer_persona_session_id AS producerPersonaSessionId,
      revisions.producer_persona_name AS producerPersonaName,
      revisions.codec_name AS codecName,
      revisions.content,
      revisions.digest,
      revisions.created_at AS createdAt
    FROM report_streams AS streams
    JOIN report_revisions AS revisions
      ON revisions.run_id = streams.run_id
      AND revisions.owner_scope_id = streams.owner_scope_id
      AND revisions.stream_id = streams.stream_id
    WHERE streams.run_id = ?
    ORDER BY
      streams.owner_scope_id,
      streams.stream_name,
      revisions.revision
  `, runId);
  assertReportIdentities(runId, reports);
  return reports;
}

function readFindingProjection(
  context: RunReadContext,
  runId: string,
): NonNullable<CompleteResumeSnapshot['findingLedger']> {
  validateFindingAuthority(context, runId);
  const finding = readFindingLedgerProjection(
    context,
    { runId, scopeId: 'root' },
  );
  return {
    revision: finding.revision,
    updatedAt: finding.updatedAt,
    ledger: finding.ledger,
  };
}
