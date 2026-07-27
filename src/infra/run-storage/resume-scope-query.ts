import type { RunReadContext } from './context.js';
import type {
  ScopeResumeSnapshot,
  SnapshotRow,
} from './resume-snapshot-types.js';
import {
  assertEncodedRows,
  assertEventRows,
  assertExecutionIdentities,
} from './resume-snapshot-validation.js';

export function readScopeSnapshot(
  context: RunReadContext,
  runId: string,
  scope: SnapshotRow & { readonly scopeId: string },
): ScopeResumeSnapshot {
  const scopeId = scope.scopeId;
  const runtime = context.get<SnapshotRow>(`
    SELECT
      current_step_id AS currentStepId,
      status,
      revision,
      updated_at AS updatedAt
    FROM scope_runtime
    WHERE run_id = ? AND scope_id = ?
  `, runId, scopeId);
  if (runtime === undefined) {
    throw new Error(`Scope "${runId}/${scopeId}" has no runtime`);
  }
  const events = context.all<SnapshotRow>(`
    SELECT
      event_seq AS sequence,
      event_type AS eventType,
      codec_name AS codecName,
      payload,
      payload_digest AS payloadDigest,
      occurred_at AS occurredAt
    FROM run_events
    WHERE run_id = ? AND scope_id = ?
    ORDER BY event_seq
  `, runId, scopeId);
  const responses = context.all<SnapshotRow>(`
    SELECT
      snapshot_id AS snapshotId,
      sequence,
      codec_name AS codecName,
      response,
      digest,
      created_at AS createdAt
    FROM response_snapshots
    WHERE run_id = ? AND scope_id = ?
    ORDER BY sequence
  `, runId, scopeId);
  const stepExecutions = context.all<SnapshotRow>(`
    SELECT
      execution_id AS executionId,
      step_id AS stepId,
      run_session_id AS runSessionId,
      persona_session_id AS personaSessionId,
      iteration,
      status,
      started_at AS startedAt,
      terminal_at AS terminalAt
    FROM step_executions
    WHERE run_id = ? AND scope_id = ?
    ORDER BY started_at, execution_id
  `, runId, scopeId);
  const stepIterations = context.all<SnapshotRow>(`
    SELECT step_id AS stepId, max(iteration) AS iteration
    FROM step_executions
    WHERE run_id = ? AND scope_id = ?
    GROUP BY step_id
    ORDER BY step_id
  `, runId, scopeId);
  const phaseExecutions = context.all<SnapshotRow>(`
    SELECT
      phase_execution_id AS phaseExecutionId,
      step_execution_id AS stepExecutionId,
      phase,
      ordinal,
      status,
      started_at AS startedAt,
      terminal_at AS terminalAt
    FROM phase_executions
    WHERE run_id = ? AND scope_id = ?
    ORDER BY started_at, phase_execution_id
  `, runId, scopeId);
  const personaSessions = context.all<SnapshotRow>(`
    SELECT
      persona_session_id AS personaSessionId,
      persona_name AS personaName,
      started_at AS startedAt,
      ended_at AS endedAt
    FROM persona_sessions
    WHERE run_id = ? AND scope_id = ?
    ORDER BY started_at, persona_session_id
  `, runId, scopeId);
  const personaSessionHistory = context.all<SnapshotRow>(`
    SELECT
      persona_session_id AS personaSessionId,
      revision,
      codec_name AS codecName,
      content,
      digest,
      recorded_at AS recordedAt
    FROM persona_session_history
    WHERE run_id = ? AND scope_id = ?
    ORDER BY persona_session_id, revision
  `, runId, scopeId);
  const fallbackAttempts = context.all<SnapshotRow>(`
    SELECT *
    FROM fallback_attempts
    WHERE run_id = ? AND scope_id = ?
    ORDER BY attempted_at, attempt_id
  `, runId, scopeId);
  const recoveryItems = context.all<SnapshotRow>(`
    SELECT
      recovery_item_id AS recoveryItemId,
      recovery_key AS recoveryKey,
      item_type AS itemType,
      codec_name AS codecName,
      content,
      digest,
      status,
      created_at AS createdAt,
      terminal_at AS terminalAt
    FROM recovery_items
    WHERE run_id = ? AND scope_id = ?
    ORDER BY created_at, recovery_item_id
  `, runId, scopeId);
  const snapshot = {
    ...scope,
    runtime,
    events,
    responses,
    stepIterations,
    stepExecutions,
    phaseExecutions,
    judgeStageResults: readEncodedScopeTable(
      context,
      'judge_stage_results',
      'result',
      runId,
      scopeId,
    ),
    stepOutputs: readEncodedScopeTable(
      context,
      'step_outputs',
      'output',
      runId,
      scopeId,
    ),
    structuredOutputs: readEncodedScopeTable(
      context,
      'structured_outputs',
      'output',
      runId,
      scopeId,
    ),
    systemContexts: readEncodedScopeTable(
      context,
      'system_contexts',
      'content',
      runId,
      scopeId,
    ),
    effectResults: readEncodedScopeTable(
      context,
      'effect_results',
      'result',
      runId,
      scopeId,
    ),
    userInputs: readEncodedScopeTable(
      context,
      'user_inputs',
      'input',
      runId,
      scopeId,
    ),
    personaSessions,
    personaSessionHistory,
    fallbackAttempts,
    recoveryItems,
  };
  assertEventRows(events);
  assertEncodedRows(responses, 'response');
  assertEncodedRows(personaSessionHistory, 'content');
  assertEncodedRows(recoveryItems, 'content');
  assertExecutionIdentities(
    runId,
    scopeId,
    stepExecutions,
    phaseExecutions,
    responses,
  );
  return snapshot;
}

function readEncodedScopeTable(
  context: RunReadContext,
  table: string,
  contentField: string,
  runId: string,
  scopeId: string,
): SnapshotRow[] {
  const rows = context.all<SnapshotRow>(`
    SELECT
      *,
      codec_name AS codecName
    FROM ${table}
    WHERE run_id = ? AND scope_id = ?
    ORDER BY rowid
  `, runId, scopeId);
  assertEncodedRows(rows, contentField);
  return rows;
}
