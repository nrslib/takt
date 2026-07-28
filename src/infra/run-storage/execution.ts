import type { RunReadContext, RunWriteContext } from './context.js';
import { assertCodecContent } from './codec-contract.js';
import { sha256 } from './canonical-json.js';
import {
  readExecutionRuntime,
  type ExecutionRuntimeState,
} from './execution-state-reader.js';

type TerminalStatus = 'completed' | 'failed' | 'cancelled';

function encode(codecName: string, content: string): {
  readonly content: string;
  readonly digest: string;
} {
  assertCodecContent(codecName, content);
  return { content, digest: sha256(content) };
}

function assertBoundExecution(
  context: RunReadContext,
  input: {
    readonly runId: string;
    readonly scopeId: string;
    readonly executionId: string;
  },
): void {
  const row = context.get<{ readonly found: number }>(`
    SELECT 1 AS found
    FROM step_executions
    WHERE run_id = ? AND scope_id = ? AND execution_id = ?
  `, input.runId, input.scopeId, input.executionId);
  if (row === undefined) {
    const foreign = context.get<{ readonly found: number }>(`
      SELECT 1 AS found
      FROM step_executions
      WHERE run_id = ? AND execution_id = ?
    `, input.runId, input.executionId);
    throw new Error(
      foreign === undefined
        ? `Step execution "${input.executionId}" does not exist`
        : `Step execution "${input.executionId}" cross-scope reference rejected`,
    );
  }
}

export class ExecutionRepository {
  terminalizeActive(
    context: RunWriteContext,
    input: {
      readonly runId: string;
      readonly status: TerminalStatus;
      readonly terminalAt: number;
    },
  ): void {
    context.run(`
      UPDATE phase_executions
      SET status = ?, terminal_at = ?
      WHERE run_id = ? AND status = 'running' AND terminal_at IS NULL
    `, input.status, input.terminalAt, input.runId);
    context.run(`
      UPDATE step_executions
      SET status = ?, terminal_at = ?
      WHERE run_id = ? AND status = 'running' AND terminal_at IS NULL
    `, input.status, input.terminalAt, input.runId);
  }

  startStep(context: RunWriteContext, input: {
    readonly runId: string;
    readonly scopeId: string;
    readonly stepId: string;
    readonly runSessionId?: string;
    readonly personaSessionId?: string;
    readonly expectedScopeRevision: number;
    readonly startedAt: number;
  }): {
    readonly executionId: string;
    readonly iteration: number;
    readonly scopeRevision: number;
    readonly startedAt: number;
  } {
    const runtime = context.get<{
      readonly revision: number;
      readonly status: string;
    }>(`
      SELECT revision, status
      FROM scope_runtime
      WHERE run_id = ? AND scope_id = ?
    `, input.runId, input.scopeId);
    if (
      runtime === undefined
      || runtime.revision !== input.expectedScopeRevision
      || (runtime.status !== 'ready' && runtime.status !== 'running')
    ) {
      throw new Error(`Scope runtime CAS mismatch for "${input.runId}/${input.scopeId}"`);
    }
    const counter = context.get<{ readonly iteration: number | null }>(`
      SELECT max(iteration) AS iteration
      FROM step_executions
      WHERE run_id = ? AND scope_id = ? AND step_id = ?
    `, input.runId, input.scopeId, input.stepId);
    const iteration = (counter?.iteration ?? 0) + 1;
    const runtimeResult = context.run(`
      UPDATE scope_runtime
      SET
        current_step_id = ?,
        status = 'running',
        revision = revision + 1,
        updated_at = ?
      WHERE
        run_id = ?
        AND scope_id = ?
        AND revision = ?
        AND status IN ('ready', 'running')
    `,
    input.stepId,
    input.startedAt,
    input.runId,
    input.scopeId,
    input.expectedScopeRevision);
    if (Number(runtimeResult.changes) !== 1) {
      throw new Error(`Scope runtime CAS mismatch for "${input.runId}/${input.scopeId}"`);
    }
    const executionId = sha256([
      input.runId,
      input.scopeId,
      input.stepId,
      String(iteration),
    ].join('\0'));
    context.run(`
      INSERT INTO step_executions (
        run_id,
        scope_id,
        execution_id,
        step_id,
        run_session_id,
        persona_session_id,
        iteration,
        status,
        started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)
    `,
    input.runId,
    input.scopeId,
    executionId,
    input.stepId,
    input.runSessionId ?? null,
    input.personaSessionId ?? null,
    iteration,
    input.startedAt);
    return {
      executionId,
      iteration,
      scopeRevision: input.expectedScopeRevision + 1,
      startedAt: input.startedAt,
    };
  }

  finishStep(context: RunWriteContext, input: {
    readonly runId: string;
    readonly scopeId: string;
    readonly executionId: string;
    readonly status: TerminalStatus;
    readonly terminalAt: number;
  }): void {
    assertBoundExecution(context, input);
    const result = context.run(`
      UPDATE step_executions
      SET status = ?, terminal_at = ?
      WHERE
        run_id = ?
        AND scope_id = ?
        AND execution_id = ?
        AND status = 'running'
        AND terminal_at IS NULL
    `,
    input.status,
    input.terminalAt,
    input.runId,
    input.scopeId,
    input.executionId);
    if (Number(result.changes) !== 1) {
      throw new Error(`Step execution "${input.executionId}" is already terminal`);
    }
  }

  startPhase(context: RunWriteContext, input: {
    readonly runId: string;
    readonly scopeId: string;
    readonly stepExecutionId: string;
    readonly phase: string;
    readonly ordinal: number;
    readonly startedAt: number;
  }): string {
    assertBoundExecution(context, {
      ...input,
      executionId: input.stepExecutionId,
    });
    const phaseExecutionId = sha256([
      input.runId,
      input.scopeId,
      input.stepExecutionId,
      input.phase,
      String(input.ordinal),
    ].join('\0'));
    context.run(`
      INSERT INTO phase_executions (
        run_id,
        scope_id,
        phase_execution_id,
        step_execution_id,
        phase,
        ordinal,
        status,
        started_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
    `,
    input.runId,
    input.scopeId,
    phaseExecutionId,
    input.stepExecutionId,
    input.phase,
    input.ordinal,
    input.startedAt);
    return phaseExecutionId;
  }

  finishPhase(context: RunWriteContext, input: {
    readonly runId: string;
    readonly scopeId: string;
    readonly phaseExecutionId: string;
    readonly status: TerminalStatus;
    readonly terminalAt: number;
  }): void {
    const result = context.run(`
      UPDATE phase_executions
      SET status = ?, terminal_at = ?
      WHERE
        run_id = ?
        AND scope_id = ?
        AND phase_execution_id = ?
        AND status = 'running'
        AND terminal_at IS NULL
    `,
    input.status,
    input.terminalAt,
    input.runId,
    input.scopeId,
    input.phaseExecutionId);
    if (Number(result.changes) !== 1) {
      const foreign = context.get(`
        SELECT 1
        FROM phase_executions
        WHERE run_id = ? AND phase_execution_id = ?
      `, input.runId, input.phaseExecutionId);
      throw new Error(
        foreign === undefined
          ? `Phase execution "${input.phaseExecutionId}" is missing or terminal`
          : `Phase execution "${input.phaseExecutionId}" cross-scope reference rejected`,
      );
    }
  }

  recordJudgeStage(context: RunWriteContext, input: {
    readonly runId: string;
    readonly scopeId: string;
    readonly phaseExecutionId: string;
    readonly stage: string;
    readonly codecName: string;
    readonly result: string;
  }): void {
    const encoded = encode(input.codecName, input.result);
    context.run(`
      INSERT INTO judge_stage_results (
        run_id, scope_id, phase_execution_id, stage,
        codec_name, result, digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    input.runId,
    input.scopeId,
    input.phaseExecutionId,
    input.stage,
    input.codecName,
    encoded.content,
    encoded.digest);
  }

  recordStepOutput(context: RunWriteContext, input: {
    readonly runId: string;
    readonly scopeId: string;
    readonly executionId: string;
    readonly outputName: string;
    readonly codecName: string;
    readonly content: string;
  }): void {
    assertBoundExecution(context, input);
    const encoded = encode(input.codecName, input.content);
    context.run(`
      INSERT INTO step_outputs (
        run_id, scope_id, step_execution_id,
        output_name, codec_name, output, digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    input.runId,
    input.scopeId,
    input.executionId,
    input.outputName,
    input.codecName,
    encoded.content,
    encoded.digest);
  }

  recordStructuredOutput(context: RunWriteContext, input: {
    readonly runId: string;
    readonly scopeId: string;
    readonly executionId: string;
    readonly codecName: string;
    readonly output: string;
  }): void {
    assertBoundExecution(context, input);
    const encoded = encode(input.codecName, input.output);
    context.run(`
      INSERT INTO structured_outputs (
        run_id, scope_id, step_execution_id, codec_name, output, digest
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    input.runId,
    input.scopeId,
    input.executionId,
    input.codecName,
    encoded.content,
    encoded.digest);
  }

  loadRuntime(
    context: RunReadContext,
    runId: string,
    scopeId: string,
  ): ExecutionRuntimeState {
    return readExecutionRuntime(context, runId, scopeId);
  }
}
