import type { RunReadContext, RunWriteContext } from './context.js';
import { assertCodecContent } from './codec-contract.js';
import { sha256 } from './canonical-json.js';

function currentSequence(
  context: RunReadContext,
  table: 'run_events' | 'response_snapshots',
  runId: string,
  scopeId: string,
): number {
  const row = context.get<{ readonly sequence: number }>(`
    SELECT count(*) AS sequence
    FROM ${table}
    WHERE run_id = ? AND scope_id = ?
  `, runId, scopeId);
  if (row === undefined) {
    throw new Error(`Sequence query failed for "${runId}/${scopeId}"`);
  }
  return row.sequence;
}

export class RuntimeSequenceRepository {
  appendEvent(context: RunWriteContext, input: {
    readonly runId: string;
    readonly scopeId: string;
    readonly expectedSequence: number;
    readonly eventType: string;
    readonly occurredAt: number;
    readonly codecName?: string;
    readonly payload?: string;
  }): number {
    if ((input.codecName === undefined) !== (input.payload === undefined)) {
      throw new Error('Event codec and payload must be provided together');
    }
    if (input.codecName !== undefined && input.payload !== undefined) {
      assertCodecContent(input.codecName, input.payload);
    }
    if (
      currentSequence(context, 'run_events', input.runId, input.scopeId)
      !== input.expectedSequence
    ) {
      throw new Error(`Event sequence CAS mismatch for "${input.runId}/${input.scopeId}"`);
    }
    const sequence = input.expectedSequence + 1;
    context.run(`
      INSERT INTO run_events (
        run_id, scope_id, event_seq, event_type, codec_name,
        payload, payload_digest, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    input.runId,
    input.scopeId,
    sequence,
    input.eventType,
    input.codecName ?? null,
    input.payload ?? null,
    input.payload === undefined ? null : sha256(input.payload),
    input.occurredAt);
    return sequence;
  }

  listEvents(
    context: RunReadContext,
    runId: string,
    scopeId: string,
  ): Array<{
    readonly sequence: number;
    readonly eventType: string;
    readonly codecName: string | null;
    readonly payload: string | null;
    readonly payloadDigest: string | null;
    readonly occurredAt: number;
  }> {
    const events = context.all<{
      readonly sequence: number;
      readonly eventType: string;
      readonly codecName: string | null;
      readonly payload: string | null;
      readonly payloadDigest: string | null;
      readonly occurredAt: number;
    }>(`
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
    for (const event of events) {
      if (event.payload === null) {
        continue;
      }
      if (
        event.codecName === null
        || event.payloadDigest === null
        || sha256(event.payload) !== event.payloadDigest
      ) {
        throw new Error(
          `Run event digest mismatch at "${runId}/${scopeId}/${event.sequence}"`,
        );
      }
      assertCodecContent(event.codecName, event.payload);
    }
    return events;
  }

  recordResponseSnapshot(context: RunWriteContext, input: {
    readonly runId: string;
    readonly scopeId: string;
    readonly expectedSequence: number;
    readonly codecName: string;
    readonly response: string;
    readonly createdAt: number;
  }): number {
    if (
      currentSequence(context, 'response_snapshots', input.runId, input.scopeId)
      !== input.expectedSequence
    ) {
      throw new Error(
        `Response sequence CAS mismatch for "${input.runId}/${input.scopeId}"`,
      );
    }
    assertCodecContent(input.codecName, input.response);
    const sequence = input.expectedSequence + 1;
    const digest = sha256(input.response);
    const snapshotId = sha256([
      input.runId,
      input.scopeId,
      String(sequence),
      digest,
    ].join('\0'));
    context.run(`
      INSERT INTO response_snapshots (
        run_id, scope_id, snapshot_id, sequence, codec_name,
        response, digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    input.runId,
    input.scopeId,
    snapshotId,
    sequence,
    input.codecName,
    input.response,
    digest,
    input.createdAt);
    return sequence;
  }
}
