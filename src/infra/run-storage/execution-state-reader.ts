import type { RunReadContext } from './context.js';
import { assertCodecContent } from './codec-contract.js';
import { sha256 } from './canonical-json.js';

type RuntimeRow = Readonly<Record<string, unknown>>;

function assertEncodedRows(
  rows: readonly RuntimeRow[],
  contentField: string,
): void {
  for (const row of rows) {
    const content = row[contentField];
    const codecName = row.codecName;
    const digest = row.digest;
    if (content === null && codecName === null && digest === null) {
      continue;
    }
    if (
      typeof content !== 'string'
      || typeof codecName !== 'string'
      || typeof digest !== 'string'
      || sha256(content) !== digest
    ) {
      throw new Error(`Execution runtime ${contentField} digest mismatch`);
    }
    assertCodecContent(codecName, content);
  }
}

function readEncodedRows(
  context: RunReadContext,
  sql: string,
  runId: string,
  scopeId: string,
  contentField: string,
): RuntimeRow[] {
  const rows = context.all<RuntimeRow>(sql, runId, scopeId);
  assertEncodedRows(rows, contentField);
  return rows;
}

export interface ExecutionRuntimeState {
  readonly scope: RuntimeRow;
  readonly stepIterations: Readonly<Record<string, number>>;
  readonly stepExecutions: readonly RuntimeRow[];
  readonly phaseExecutions: readonly RuntimeRow[];
  readonly judgeStageResults: readonly RuntimeRow[];
  readonly stepOutputs: readonly RuntimeRow[];
  readonly structuredOutputs: readonly RuntimeRow[];
  readonly systemContexts: readonly RuntimeRow[];
  readonly effectResults: readonly RuntimeRow[];
  readonly userInputs: readonly RuntimeRow[];
  readonly personaSessions: readonly RuntimeRow[];
  readonly fallbackAttempts: readonly RuntimeRow[];
  readonly recoveryItems: readonly RuntimeRow[];
  readonly latestResponse: RuntimeRow | null;
}

export function readExecutionRuntime(
  context: RunReadContext,
  runId: string,
  scopeId: string,
): ExecutionRuntimeState {
  const scope = context.get<RuntimeRow>(`
    SELECT
      current_step_id AS currentStepId,
      status,
      revision,
      (
        SELECT count(*) FROM run_events
        WHERE run_id = ? AND scope_id = ?
      ) AS eventSequence,
      (
        SELECT count(*) FROM response_snapshots
        WHERE run_id = ? AND scope_id = ?
      ) AS responseSequence
    FROM scope_runtime
    WHERE run_id = ? AND scope_id = ?
  `, runId, scopeId, runId, scopeId, runId, scopeId);
  if (scope === undefined) {
    throw new Error(`Scope "${runId}/${scopeId}" does not exist`);
  }
  const counters = context.all<{ stepId: string; iteration: number }>(`
    SELECT step_id AS stepId, max(iteration) AS iteration
    FROM step_executions
    WHERE run_id = ? AND scope_id = ?
    GROUP BY step_id
    ORDER BY step_id
  `, runId, scopeId);
  const latestResponse = context.get<RuntimeRow>(`
    SELECT
      snapshot_id AS snapshotId,
      codec_name AS codecName,
      response,
      digest,
      sequence
    FROM response_snapshots
    WHERE run_id = ? AND scope_id = ?
    ORDER BY sequence DESC
    LIMIT 1
  `, runId, scopeId);
  if (latestResponse !== undefined) {
    assertEncodedRows([latestResponse], 'response');
  }
  return {
    scope,
    stepIterations: Object.fromEntries(
      counters.map((counter) => [counter.stepId, counter.iteration]),
    ),
    stepExecutions: readStepExecutions(context, runId, scopeId),
    phaseExecutions: readPhaseExecutions(context, runId, scopeId),
    judgeStageResults: readJudgeStageResults(context, runId, scopeId),
    stepOutputs: readStepOutputs(context, runId, scopeId),
    structuredOutputs: readStructuredOutputs(context, runId, scopeId),
    systemContexts: readEncodedRows(context, `
      SELECT
        context_id AS contextId, codec_name AS codecName, content, digest,
        created_at AS createdAt
      FROM system_contexts
      WHERE run_id = ? AND scope_id = ?
      ORDER BY created_at, context_id
    `, runId, scopeId, 'content'),
    effectResults: readEncodedRows(context, `
      SELECT
        effect_id AS effectId, effect_type AS effectType,
        codec_name AS codecName, result, digest, recorded_at AS recordedAt
      FROM effect_results
      WHERE run_id = ? AND scope_id = ?
      ORDER BY recorded_at, effect_id
    `, runId, scopeId, 'result'),
    userInputs: readEncodedRows(context, `
      SELECT
        input_id AS inputId, codec_name AS codecName, input, digest,
        received_at AS receivedAt
      FROM user_inputs
      WHERE run_id = ? AND scope_id = ?
      ORDER BY received_at, input_id
    `, runId, scopeId, 'input'),
    personaSessions: readPersonaSessions(context, runId, scopeId),
    fallbackAttempts: context.all(`
      SELECT
        attempt_id AS attemptId, source, target, reason,
        attempted_at AS attemptedAt
      FROM fallback_attempts
      WHERE run_id = ? AND scope_id = ?
      ORDER BY attempted_at, attempt_id
    `, runId, scopeId),
    recoveryItems: readEncodedRows(context, `
      SELECT
        recovery_item_id AS recoveryItemId, item_type AS itemType,
        codec_name AS codecName, content, digest, status,
        created_at AS createdAt, terminal_at AS terminalAt
      FROM recovery_items
      WHERE run_id = ? AND scope_id = ?
      ORDER BY created_at, recovery_item_id
    `, runId, scopeId, 'content'),
    latestResponse: latestResponse ?? null,
  };
}

function readStepExecutions(
  context: RunReadContext,
  runId: string,
  scopeId: string,
): RuntimeRow[] {
  return context.all(`
    SELECT
      execution_id AS executionId, step_id AS stepId, iteration, status,
      started_at AS startedAt, terminal_at AS terminalAt
    FROM step_executions
    WHERE run_id = ? AND scope_id = ?
    ORDER BY started_at, execution_id
  `, runId, scopeId);
}

function readPhaseExecutions(
  context: RunReadContext,
  runId: string,
  scopeId: string,
): RuntimeRow[] {
  return context.all(`
    SELECT
      phase_executions.phase_execution_id AS phaseExecutionId,
      phase_executions.step_execution_id AS stepExecutionId,
      phase_executions.phase,
      phase_executions.ordinal,
      phase_executions.status,
      phase_executions.started_at AS startedAt,
      phase_executions.terminal_at AS terminalAt
    FROM phase_executions
    WHERE phase_executions.run_id = ? AND phase_executions.scope_id = ?
    ORDER BY phase_executions.started_at, phase_executions.ordinal
  `, runId, scopeId);
}

function readStepOutputs(
  context: RunReadContext,
  runId: string,
  scopeId: string,
): RuntimeRow[] {
  return readEncodedRows(context, `
    SELECT
      step_outputs.step_execution_id AS stepExecutionId,
      step_outputs.output_name AS outputName,
      step_outputs.codec_name AS codecName,
      step_outputs.output,
      step_outputs.digest
    FROM step_outputs
    WHERE step_outputs.run_id = ? AND step_outputs.scope_id = ?
    ORDER BY step_outputs.step_execution_id, step_outputs.output_name
  `, runId, scopeId, 'output');
}

function readJudgeStageResults(
  context: RunReadContext,
  runId: string,
  scopeId: string,
): RuntimeRow[] {
  return readEncodedRows(context, `
    SELECT
      judge_stage_results.phase_execution_id AS phaseExecutionId,
      judge_stage_results.stage,
      judge_stage_results.codec_name AS codecName,
      judge_stage_results.result,
      judge_stage_results.digest
    FROM judge_stage_results
    JOIN phase_executions
      ON phase_executions.run_id = judge_stage_results.run_id
      AND phase_executions.scope_id = judge_stage_results.scope_id
      AND phase_executions.phase_execution_id = judge_stage_results.phase_execution_id
    JOIN step_executions
      ON step_executions.run_id = phase_executions.run_id
      AND step_executions.scope_id = phase_executions.scope_id
      AND step_executions.execution_id = phase_executions.step_execution_id
    WHERE judge_stage_results.run_id = ? AND judge_stage_results.scope_id = ?
    ORDER BY
      step_executions.started_at,
      phase_executions.ordinal,
      judge_stage_results.stage
  `, runId, scopeId, 'result');
}

function readStructuredOutputs(
  context: RunReadContext,
  runId: string,
  scopeId: string,
): RuntimeRow[] {
  return readEncodedRows(context, `
    SELECT
      structured_outputs.step_execution_id AS stepExecutionId,
      structured_outputs.codec_name AS codecName,
      structured_outputs.output,
      structured_outputs.digest
    FROM structured_outputs
    WHERE structured_outputs.run_id = ? AND structured_outputs.scope_id = ?
    ORDER BY structured_outputs.step_execution_id
  `, runId, scopeId, 'output');
}

function readPersonaSessions(
  context: RunReadContext,
  runId: string,
  scopeId: string,
): RuntimeRow[] {
  const rows = context.all<RuntimeRow>(`
    SELECT
      persona_sessions.persona_session_id AS personaSessionId,
      persona_sessions.persona_name AS personaName,
      persona_sessions.started_at AS startedAt,
      persona_sessions.ended_at AS endedAt,
      persona_session_history.revision,
      persona_session_history.codec_name AS codecName,
      persona_session_history.content,
      persona_session_history.digest,
      persona_session_history.recorded_at AS recordedAt
    FROM persona_sessions
    LEFT JOIN persona_session_history
      ON persona_session_history.run_id = persona_sessions.run_id
      AND persona_session_history.scope_id = persona_sessions.scope_id
      AND persona_session_history.persona_session_id = persona_sessions.persona_session_id
    WHERE persona_sessions.run_id = ? AND persona_sessions.scope_id = ?
    ORDER BY
      persona_sessions.started_at,
      persona_sessions.persona_session_id,
      persona_session_history.revision
  `, runId, scopeId);
  assertEncodedRows(rows, 'content');
  return rows;
}
