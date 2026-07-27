import type { RunWriteContext } from './context.js';
import { assertCodecContent } from './codec-contract.js';
import { sha256 } from './canonical-json.js';

function encode(codecName: string, content: string): {
  readonly content: string;
  readonly digest: string;
} {
  assertCodecContent(codecName, content);
  return { content, digest: sha256(content) };
}

interface BoundValue {
  readonly runId: string;
  readonly scopeId: string;
}

export class RuntimeValueRepository {
  recordSystemContext(context: RunWriteContext, input: BoundValue & {
    readonly contextId: string;
    readonly codecName: string;
    readonly content: string;
    readonly createdAt: number;
  }): void {
    const encoded = encode(input.codecName, input.content);
    context.run(`
      INSERT INTO system_contexts (
        run_id, scope_id, context_id, codec_name, content, digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    input.runId,
    input.scopeId,
    input.contextId,
    input.codecName,
    encoded.content,
    encoded.digest,
    input.createdAt);
  }

  recordEffectResult(context: RunWriteContext, input: BoundValue & {
    readonly effectId: string;
    readonly effectType: string;
    readonly codecName: string;
    readonly result: string;
    readonly recordedAt: number;
  }): void {
    const encoded = encode(input.codecName, input.result);
    context.run(`
      INSERT INTO effect_results (
        run_id, scope_id, effect_id, effect_type,
        codec_name, result, digest, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    input.runId,
    input.scopeId,
    input.effectId,
    input.effectType,
    input.codecName,
    encoded.content,
    encoded.digest,
    input.recordedAt);
  }

  recordUserInput(context: RunWriteContext, input: BoundValue & {
    readonly inputId: string;
    readonly codecName: string;
    readonly content: string;
    readonly receivedAt: number;
  }): void {
    const encoded = encode(input.codecName, input.content);
    context.run(`
      INSERT INTO user_inputs (
        run_id, scope_id, input_id, codec_name, input, digest, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    input.runId,
    input.scopeId,
    input.inputId,
    input.codecName,
    encoded.content,
    encoded.digest,
    input.receivedAt);
  }

  startPersonaSession(context: RunWriteContext, input: BoundValue & {
    readonly personaSessionId: string;
    readonly personaName: string;
    readonly startedAt: number;
  }): void {
    context.run(`
      INSERT INTO persona_sessions (
        run_id, scope_id, persona_session_id, persona_name, started_at
      ) VALUES (?, ?, ?, ?, ?)
    `,
    input.runId,
    input.scopeId,
    input.personaSessionId,
    input.personaName,
    input.startedAt);
  }

  appendPersonaSessionRevision(context: RunWriteContext, input: BoundValue & {
    readonly personaSessionId: string;
    readonly expectedRevision: number;
    readonly codecName: string;
    readonly content: string;
    readonly recordedAt: number;
  }): number {
    const current = context.get<{ readonly revision: number | null }>(`
      SELECT max(revision) AS revision
      FROM persona_session_history
      WHERE run_id = ? AND scope_id = ? AND persona_session_id = ?
    `, input.runId, input.scopeId, input.personaSessionId);
    const revision = current?.revision ?? 0;
    if (revision !== input.expectedRevision) {
      throw new Error(
        `Persona session revision CAS mismatch for "${input.personaSessionId}"`,
      );
    }
    const encoded = encode(input.codecName, input.content);
    context.run(`
      INSERT INTO persona_session_history (
        run_id, scope_id, persona_session_id,
        revision, codec_name, content, digest, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    input.runId,
    input.scopeId,
    input.personaSessionId,
    revision + 1,
    input.codecName,
    encoded.content,
    encoded.digest,
    input.recordedAt);
    return revision + 1;
  }

  endPersonaSession(context: RunWriteContext, input: BoundValue & {
    readonly personaSessionId: string;
    readonly endedAt: number;
  }): void {
    const result = context.run(`
      UPDATE persona_sessions
      SET ended_at = ?
      WHERE
        run_id = ?
        AND scope_id = ?
        AND persona_session_id = ?
        AND ended_at IS NULL
    `, input.endedAt, input.runId, input.scopeId, input.personaSessionId);
    if (Number(result.changes) !== 1) {
      throw new Error(`Persona session "${input.personaSessionId}" is missing or ended`);
    }
  }

  recordFallbackAttempt(context: RunWriteContext, input: BoundValue & {
    readonly attemptId: string;
    readonly source: string;
    readonly target: string;
    readonly reason: string;
    readonly attemptedAt: number;
  }): void {
    context.run(`
      INSERT INTO fallback_attempts (
        run_id, scope_id, attempt_id, source, target, reason, attempted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    input.runId,
    input.scopeId,
    input.attemptId,
    input.source,
    input.target,
    input.reason,
    input.attemptedAt);
  }

  createRecoveryItem(context: RunWriteContext, input: BoundValue & {
    readonly recoveryItemId: string;
    readonly recoveryKey: string;
    readonly itemType: string;
    readonly codecName: string;
    readonly content: string;
    readonly createdAt: number;
  }): void {
    const encoded = encode(input.codecName, input.content);
    context.run(`
      INSERT INTO recovery_items (
        run_id,
        scope_id,
        recovery_item_id,
        recovery_key,
        item_type,
        codec_name,
        content,
        digest,
        status,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `,
    input.runId,
    input.scopeId,
    input.recoveryItemId,
    input.recoveryKey,
    input.itemType,
    input.codecName,
    encoded.content,
    encoded.digest,
    input.createdAt);
  }

  resolveRecoveryItem(context: RunWriteContext, input: BoundValue & {
    readonly recoveryItemId: string;
    readonly status: 'applied' | 'rejected';
    readonly terminalAt: number;
  }): void {
    const result = context.run(`
      UPDATE recovery_items
      SET status = ?, terminal_at = ?
      WHERE
        run_id = ?
        AND scope_id = ?
        AND recovery_item_id = ?
        AND status = 'pending'
    `,
    input.status,
    input.terminalAt,
    input.runId,
    input.scopeId,
    input.recoveryItemId);
    if (Number(result.changes) !== 1) {
      throw new Error(`Recovery item "${input.recoveryItemId}" is missing or terminal`);
    }
  }
}
