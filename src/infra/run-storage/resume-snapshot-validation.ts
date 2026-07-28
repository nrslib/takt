import { sha256 } from './canonical-json.js';
import { assertCodecContent } from './codec-contract.js';
import type { OperationRecord } from './operation-record.js';
import { assertReportRevisionIntegrity } from './reports.js';
import type { SnapshotRow } from './resume-snapshot-types.js';

export function assertEncodedRows(
  rows: readonly SnapshotRow[],
  contentKey: string,
  digestKey = 'digest',
  codecKey = 'codecName',
): void {
  for (const row of rows) {
    const content = row[contentKey];
    const digest = row[digestKey];
    const codec = row[codecKey];
    if (
      typeof content !== 'string'
      || typeof digest !== 'string'
      || typeof codec !== 'string'
      || sha256(content) !== digest
    ) {
      throw new Error(`Resume snapshot ${contentKey} digest mismatch`);
    }
    assertCodecContent(codec, content);
  }
}

export function assertExecutionIdentities(
  runId: string,
  scopeId: string,
  steps: readonly SnapshotRow[],
  phases: readonly SnapshotRow[],
  responses: readonly SnapshotRow[],
): void {
  for (const step of steps) {
    if (
      typeof step.stepId !== 'string'
      || typeof step.iteration !== 'number'
      || typeof step.executionId !== 'string'
      || sha256([
        runId,
        scopeId,
        step.stepId,
        String(step.iteration),
      ].join('\0')) !== step.executionId
    ) {
      throw new Error('Resume snapshot step execution identity mismatch');
    }
  }
  for (const phase of phases) {
    if (
      typeof phase.stepExecutionId !== 'string'
      || typeof phase.phase !== 'string'
      || typeof phase.ordinal !== 'number'
      || typeof phase.phaseExecutionId !== 'string'
      || sha256([
        runId,
        scopeId,
        phase.stepExecutionId,
        phase.phase,
        String(phase.ordinal),
      ].join('\0')) !== phase.phaseExecutionId
    ) {
      throw new Error('Resume snapshot phase execution identity mismatch');
    }
  }
  for (const response of responses) {
    if (
      typeof response.sequence !== 'number'
      || typeof response.digest !== 'string'
      || typeof response.snapshotId !== 'string'
      || sha256([
        runId,
        scopeId,
        String(response.sequence),
        response.digest,
      ].join('\0')) !== response.snapshotId
    ) {
      throw new Error('Resume snapshot response identity mismatch');
    }
  }
}

export function assertEventRows(events: readonly SnapshotRow[]): void {
  for (const event of events) {
    if (event.payload === null) {
      continue;
    }
    if (
      typeof event.payload !== 'string'
      || typeof event.payloadDigest !== 'string'
      || typeof event.codecName !== 'string'
      || sha256(event.payload) !== event.payloadDigest
    ) {
      throw new Error('Resume snapshot event payload digest mismatch');
    }
    assertCodecContent(event.codecName, event.payload);
  }
}

export function assertWorkflowDefinitions(
  definitions: readonly SnapshotRow[],
): void {
  for (const definition of definitions) {
    const content = definition.definition;
    const digest = definition.digest;
    const name = definition.name;
    const codecName = definition.codecName;
    if (
      typeof content !== 'string'
      || typeof digest !== 'string'
      || typeof name !== 'string'
      || typeof codecName !== 'string'
      || sha256(content) !== digest
      || sha256([name, codecName, digest].join('\0'))
        !== definition.definitionId
    ) {
      throw new Error('Resume snapshot workflow definition identity mismatch');
    }
    assertCodecContent(codecName, content);
  }
}

export function assertOperationIdentities(
  operations: readonly OperationRecord[],
): void {
  for (const operation of operations) {
    if (sha256([
      operation.runId,
      operation.scopeId,
      operation.idempotencyKey,
      operation.kind,
    ].join('\0')) !== operation.operationId) {
      throw new Error('Resume snapshot operation identity mismatch');
    }
  }
}

export function assertRunSessionIdentities(
  runId: string,
  sessions: readonly SnapshotRow[],
): void {
  for (const session of sessions) {
    if (
      typeof session.scopeId !== 'string'
      || typeof session.sessionKey !== 'string'
      || typeof session.sessionId !== 'string'
      || sha256([
        runId,
        session.scopeId,
        session.sessionKey,
      ].join('\0')) !== session.sessionId
    ) {
      throw new Error('Resume snapshot run session identity mismatch');
    }
  }
}

export function assertReportIdentities(
  runId: string,
  reports: readonly SnapshotRow[],
): void {
  for (const report of reports) {
    if (typeof report.ownerScopeId !== 'string') {
      throw new Error('Resume snapshot report identity mismatch');
    }
    assertReportRevisionIntegrity(report, {
      runId,
      ownerScopeId: report.ownerScopeId,
    });
  }
}

export function assertFindingEntryRows(rows: readonly SnapshotRow[]): void {
  for (const row of rows) {
    if (
      typeof row.record !== 'string'
      || typeof row.digest !== 'string'
      || sha256(row.record) !== row.digest
    ) {
      throw new Error('Resume snapshot Finding entry digest mismatch');
    }
    const record = JSON.parse(row.record) as Record<string, unknown>;
    const idKey = row.entryKind === 'raw'
      ? 'rawFindingId'
      : row.entryKind === 'evidence'
        ? 'evidenceId'
        : row.entryKind === 'evidence_binding'
          ? 'bindingId'
          : row.entryKind === 'lifecycle_reservation'
            ? 'reservationId'
            : row.entryKind === 'lifecycle_event'
              ? 'eventId'
            : row.entryKind === 'raw_recovery_attempt'
              ? 'attemptId'
            : row.entryKind === 'raw_recovery_result'
              ? 'resultId'
              : row.entryKind === 'interpretation'
                ? 'interpretationKey'
                : 'id';
    if (record[idKey] !== row.authorityId) {
      throw new Error('Resume snapshot Finding entry identity mismatch');
    }
  }
}

export function assertFindingControlRows(
  controls: readonly SnapshotRow[],
): void {
  for (const control of controls) {
    if (
      typeof control.record !== 'string'
      || typeof control.digest !== 'string'
      || sha256(control.record) !== control.digest
    ) {
      throw new Error('Resume snapshot Finding control digest mismatch');
    }
  }
}
