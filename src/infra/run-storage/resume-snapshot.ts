import type { RunReadContext } from './context.js';
import {
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
  const scopeRows = readScopeRows(context, run.runId);
  const operations = readOperations(context, run.runId);
  const sessions = readSessions(context, run.runId);
  const reports = readReports(context, run.runId);
  const findingHeads = context.all<SnapshotRow>(`
    SELECT * FROM finding_ledger_heads
    WHERE run_id = ?
    ORDER BY scope_id
  `, run.runId);
  const currentRevisions = new Map(
    findingHeads.map((head) => [head.scope_id, head.current_revision]),
  );
  const findingEntries = readAllFindingEntries(context, run.runId).filter(
    (entry) => currentRevisions.get(entry.scopeId) === entry.revision,
  );
  const findingControls = readFindingControls(context, run.runId).filter(
    (control) => currentRevisions.get(control.scopeId) === control.revision,
  );
  validateFindingAuthority(context, run.runId);
  return {
    run,
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
    findingRevisions: context.all<SnapshotRow>(`
      SELECT revisions.*
      FROM finding_ledger_revisions AS revisions
      JOIN finding_ledger_heads AS heads
        ON heads.run_id = revisions.run_id
        AND heads.scope_id = revisions.scope_id
        AND heads.current_revision = revisions.revision
      WHERE revisions.run_id = ?
      ORDER BY revisions.scope_id
    `, run.runId),
    findingHeads,
    findingEntries,
    findingControls,
  };
}

function readRun(
  context: RunReadContext,
): CompleteResumeSnapshot['run'] {
  const run = context.get<CompleteResumeSnapshot['run']>(`
    SELECT
      run_id AS runId,
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
      finding_contract_enabled AS findingContractEnabled,
      created_at AS createdAt,
      terminal_at AS terminalAt
    FROM scopes
    WHERE run_id = ?
    ORDER BY created_at, scope_id
  `, runId);
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
