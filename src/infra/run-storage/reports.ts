import type { SQLInputValue } from 'node:sqlite';
import type { RunReadContext, RunWriteContext } from './context.js';
import { assertCodecContent } from './codec-contract.js';
import { sha256 } from './canonical-json.js';
import {
  assertPublicReportStreamIdentity,
  derivePublicReportStreamId,
  type PublicReportStreamIdentity,
  validateStoredReportStreamIdentity,
} from './report-stream-identity.js';

export interface ReportRevision {
  readonly streamId: string;
  readonly streamName: string;
  readonly portableIdentity: string;
  readonly revision: number;
  readonly publicationId: string;
  readonly publicationKey: string;
  readonly codecName: string;
  readonly content: string;
  readonly digest: string;
  readonly ownerScopeId: string;
  readonly producerScopeId: string;
  readonly producerExecutionId: string;
  readonly producerStepId: string;
  readonly producerRunSessionId: string | null;
  readonly producerPersonaSessionId: string | null;
  readonly producerPersonaName: string | null;
  readonly createdAt: number;
}

interface ReportStreamRow {
  readonly streamId: string;
  readonly streamName: string;
  readonly portableIdentity: string;
}

interface StoredReportStreamRow extends ReportStreamRow {
  readonly runId: string;
  readonly ownerScopeId: string;
}

interface ReportStreamReader {
  all<Row>(sql: string, ...parameters: SQLInputValue[]): Row[];
}

interface StoredReportRevisionRow extends ReportRevision {
  readonly expectedProducerStepId: string | null;
  readonly expectedProducerRunSessionId: string | null;
  readonly expectedProducerPersonaSessionId: string | null;
  readonly expectedProducerPersonaName: string | null;
}

const REPORT_REVISION_COLUMNS = `
  streams.stream_id AS streamId,
  streams.stream_name AS streamName,
  streams.portable_identity AS portableIdentity,
  revisions.revision,
  revisions.publication_id AS publicationId,
  revisions.publication_key AS publicationKey,
  revisions.codec_name AS codecName,
  revisions.content,
  revisions.digest,
  revisions.owner_scope_id AS ownerScopeId,
  revisions.producer_scope_id AS producerScopeId,
  revisions.producer_execution_id AS producerExecutionId,
  revisions.producer_step_id AS producerStepId,
  revisions.producer_run_session_id AS producerRunSessionId,
  revisions.producer_persona_session_id AS producerPersonaSessionId,
  revisions.producer_persona_name AS producerPersonaName,
  revisions.created_at AS createdAt
`;

const REPORT_REVISION_FROM = `
  FROM report_revisions AS revisions
  JOIN report_streams AS streams
    ON streams.run_id = revisions.run_id
    AND streams.owner_scope_id = revisions.owner_scope_id
    AND streams.stream_id = revisions.stream_id
`;

const REPORT_REVISION_SELECTION = `
  SELECT ${REPORT_REVISION_COLUMNS}
  ${REPORT_REVISION_FROM}
`;

const REPORT_PROVENANCE_SELECTION = `
  SELECT
    ${REPORT_REVISION_COLUMNS},
    (
      SELECT executions.step_id
      FROM step_executions AS executions
      WHERE
        executions.run_id = revisions.run_id
        AND executions.scope_id = revisions.producer_scope_id
        AND executions.execution_id = revisions.producer_execution_id
    ) AS expectedProducerStepId,
    (
      SELECT executions.run_session_id
      FROM step_executions AS executions
      WHERE
        executions.run_id = revisions.run_id
        AND executions.scope_id = revisions.producer_scope_id
        AND executions.execution_id = revisions.producer_execution_id
    ) AS expectedProducerRunSessionId,
    (
      SELECT executions.persona_session_id
      FROM step_executions AS executions
      WHERE
        executions.run_id = revisions.run_id
        AND executions.scope_id = revisions.producer_scope_id
        AND executions.execution_id = revisions.producer_execution_id
    ) AS expectedProducerPersonaSessionId,
    (
      SELECT personas.persona_name
      FROM step_executions AS executions
      JOIN persona_sessions AS personas
        ON personas.run_id = executions.run_id
        AND personas.scope_id = executions.scope_id
        AND personas.persona_session_id = executions.persona_session_id
      WHERE
        executions.run_id = revisions.run_id
        AND executions.scope_id = revisions.producer_scope_id
        AND executions.execution_id = revisions.producer_execution_id
    ) AS expectedProducerPersonaName
  ${REPORT_REVISION_FROM}
`;

function reportPublicationId(
  runId: string,
  ownerScopeId: string,
  publicationKey: string,
): string {
  return sha256([runId, ownerScopeId, publicationKey].join('\0'));
}

export function assertReportRevisionIntegrity(
  revision: unknown,
  input: {
    readonly runId: string;
    readonly ownerScopeId: string;
  },
): void {
  if (
    revision === null
    || typeof revision !== 'object'
    || typeof Reflect.get(revision, 'streamId') !== 'string'
    || typeof Reflect.get(revision, 'streamName') !== 'string'
    || typeof Reflect.get(revision, 'portableIdentity') !== 'string'
    || typeof Reflect.get(revision, 'publicationId') !== 'string'
    || typeof Reflect.get(revision, 'publicationKey') !== 'string'
    || typeof Reflect.get(revision, 'codecName') !== 'string'
    || typeof Reflect.get(revision, 'content') !== 'string'
    || typeof Reflect.get(revision, 'digest') !== 'string'
    || typeof Reflect.get(revision, 'ownerScopeId') !== 'string'
    || typeof Reflect.get(revision, 'producerScopeId') !== 'string'
    || typeof Reflect.get(revision, 'producerExecutionId') !== 'string'
    || typeof Reflect.get(revision, 'producerStepId') !== 'string'
    || !Number.isInteger(Reflect.get(revision, 'revision'))
    || (Reflect.get(revision, 'revision') as number) <= 0
    || !Number.isInteger(Reflect.get(revision, 'createdAt'))
    || (Reflect.get(revision, 'createdAt') as number) < 0
    || !isNullableString(Reflect.get(revision, 'producerRunSessionId'))
    || !isNullableString(Reflect.get(revision, 'producerPersonaSessionId'))
    || !isNullableString(Reflect.get(revision, 'producerPersonaName'))
  ) {
    throw new Error('Report revision shape mismatch');
  }
  const streamId = Reflect.get(revision, 'streamId') as string;
  const streamName = Reflect.get(revision, 'streamName') as string;
  const portableIdentity = Reflect.get(revision, 'portableIdentity') as string;
  const publicationId = Reflect.get(revision, 'publicationId') as string;
  const publicationKey = Reflect.get(revision, 'publicationKey') as string;
  const codecName = Reflect.get(revision, 'codecName') as string;
  const content = Reflect.get(revision, 'content') as string;
  const digest = Reflect.get(revision, 'digest') as string;
  const ownerScopeId = Reflect.get(revision, 'ownerScopeId') as string;
  const revisionNumber = Reflect.get(revision, 'revision');
  validateStoredReportStreamIdentity({
    runId: input.runId,
    ownerScopeId: input.ownerScopeId,
    streamId,
    streamName,
    portableIdentity,
  });
  assertCodecContent(codecName, content);
  if (sha256(content) !== digest) {
    throw new Error(
      `Report digest mismatch for "${streamId}/${String(revisionNumber)}"`,
    );
  }
  if (
    ownerScopeId !== input.ownerScopeId
    || publicationId !== reportPublicationId(
      input.runId,
      input.ownerScopeId,
      publicationKey,
    )
  ) {
    throw new Error(
      `Report publication identity mismatch for "${streamId}/${String(revisionNumber)}"`,
    );
  }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function readStoredReportStreams(
  context: ReportStreamReader,
  runId: string,
): StoredReportStreamRow[] {
  return context.all<StoredReportStreamRow>(`
    SELECT
      run_id AS runId,
      owner_scope_id AS ownerScopeId,
      stream_id AS streamId,
      stream_name AS streamName,
      portable_identity AS portableIdentity
    FROM report_streams
    WHERE run_id = ?
    ORDER BY owner_scope_id, stream_id
  `, runId);
}

export function validateStoredReportHistory(
  context: ReportStreamReader,
  runId: string,
): void {
  const streams = readStoredReportStreams(context, runId);
  const revisions = context.all<StoredReportRevisionRow>(`
    ${REPORT_PROVENANCE_SELECTION}
    WHERE revisions.run_id = ?
    ORDER BY revisions.owner_scope_id, revisions.stream_id, revisions.revision
  `, runId);
  validateStoredReportHistoryRows(runId, streams, revisions);
}

function validateStoredReportHistoryRows(
  runId: string,
  streams: readonly StoredReportStreamRow[],
  revisions: readonly StoredReportRevisionRow[],
): void {
  const nextRevision = new Map<string, number>();
  for (const stream of streams) {
    validateStoredReportStreamIdentity(stream);
    nextRevision.set(reportStreamKey(stream.ownerScopeId, stream.streamId), 1);
  }
  for (const revision of revisions) {
    assertReportRevisionIntegrity(revision, {
      runId,
      ownerScopeId: revision.ownerScopeId,
    });
    const key = reportStreamKey(revision.ownerScopeId, revision.streamId);
    const expectedRevision = nextRevision.get(key);
    if (expectedRevision === undefined || revision.revision !== expectedRevision) {
      throw new Error(
        `Report revision sequence mismatch for "${revision.streamId}"`,
      );
    }
    assertReportProducerProvenance(revision);
    nextRevision.set(key, expectedRevision + 1);
  }
  if ([...nextRevision.values()].some((revision) => revision === 1)) {
    throw new Error('Report stream current revision mismatch');
  }
}

function readValidatedStoredReportStreamHistory(
  context: ReportStreamReader,
  input: {
    readonly runId: string;
    readonly ownerScopeId: string;
    readonly stream: ReportStreamRow;
  },
): ReportRevision[] {
  const storedStream: StoredReportStreamRow = {
    runId: input.runId,
    ownerScopeId: input.ownerScopeId,
    ...input.stream,
  };
  const revisions = context.all<StoredReportRevisionRow>(`
    ${REPORT_PROVENANCE_SELECTION}
    WHERE
      revisions.run_id = ?
      AND revisions.owner_scope_id = ?
      AND revisions.stream_id = ?
    ORDER BY revisions.revision
  `, input.runId, input.ownerScopeId, input.stream.streamId);
  validateStoredReportHistoryRows(input.runId, [storedStream], revisions);
  return revisions.map(toPublicReportRevision);
}

function reportStreamKey(ownerScopeId: string, streamId: string): string {
  return `${ownerScopeId}\0${streamId}`;
}

function toPublicReportRevision(
  stored: StoredReportRevisionRow,
): ReportRevision {
  return {
    streamId: stored.streamId,
    streamName: stored.streamName,
    portableIdentity: stored.portableIdentity,
    revision: stored.revision,
    publicationId: stored.publicationId,
    publicationKey: stored.publicationKey,
    codecName: stored.codecName,
    content: stored.content,
    digest: stored.digest,
    ownerScopeId: stored.ownerScopeId,
    producerScopeId: stored.producerScopeId,
    producerExecutionId: stored.producerExecutionId,
    producerStepId: stored.producerStepId,
    producerRunSessionId: stored.producerRunSessionId,
    producerPersonaSessionId: stored.producerPersonaSessionId,
    producerPersonaName: stored.producerPersonaName,
    createdAt: stored.createdAt,
  };
}

function assertReportProducerProvenance(
  revision: StoredReportRevisionRow,
): void {
  if (
    revision.expectedProducerStepId === null
    || revision.producerStepId !== revision.expectedProducerStepId
    || revision.producerRunSessionId !== revision.expectedProducerRunSessionId
    || revision.producerPersonaSessionId
      !== revision.expectedProducerPersonaSessionId
    || revision.producerPersonaName !== revision.expectedProducerPersonaName
  ) {
    throw new Error(
      `Report producer provenance mismatch for "${revision.streamId}/${revision.revision}"`,
    );
  }
}

function resolveStoredReportStream(
  context: RunReadContext,
  input: {
    readonly runId: string;
    readonly ownerScopeId: string;
    readonly stream: PublicReportStreamIdentity;
  },
): ReportStreamRow | undefined {
  const streamId = derivePublicReportStreamId(
    input.runId,
    input.ownerScopeId,
    input.stream,
  );
  const streams = context.all<ReportStreamRow>(`
    SELECT
      stream_id AS streamId,
      stream_name AS streamName,
      portable_identity AS portableIdentity
    FROM report_streams
    WHERE
      run_id = ?
      AND owner_scope_id = ?
      AND (
        stream_id = ?
        OR portable_identity = ?
        OR stream_name = ?
      )
  `,
  input.runId,
  input.ownerScopeId,
  streamId,
  input.stream.portableIdentity,
  input.stream.name);
  for (const stored of streams) {
    validateStoredReportStreamIdentity({
      runId: input.runId,
      ownerScopeId: input.ownerScopeId,
      ...stored,
    });
    if (
      stored.streamName !== input.stream.name
      || stored.portableIdentity !== input.stream.portableIdentity
    ) {
      throw new Error(
        `Report stream portable identity collision for "${input.stream.name}"`,
      );
    }
  }
  if (streams.length > 1) {
    throw new Error(
      `Report stream portable identity collision for "${input.stream.name}"`,
    );
  }
  return streams[0];
}

export class ReportRepository {
  append(context: RunWriteContext, input: {
    readonly runId: string;
    readonly ownerScopeId: string;
    readonly publicationKey: string;
    readonly stream: PublicReportStreamIdentity;
    readonly expectedRevision: number;
    readonly codecName: string;
    readonly content: string;
    readonly producerScopeId: string;
    readonly producerExecutionId: string;
    readonly createdAt: number;
  }): ReportRevision {
    assertPublicReportStreamIdentity(input.stream, 'ReportRepository.append');
    assertCodecContent(input.codecName, input.content);
    const activeScopes = context.get<{ readonly count: number }>(`
      SELECT count(*) AS count
      FROM scope_runtime
      JOIN runs USING (run_id)
      WHERE
        scope_runtime.run_id = ?
        AND scope_runtime.scope_id IN (?, ?)
        AND scope_runtime.status IN ('ready', 'running')
        AND runs.status = 'running'
    `,
    input.runId,
    input.ownerScopeId,
    input.producerScopeId);
    const expectedActiveScopes = input.ownerScopeId === input.producerScopeId ? 1 : 2;
    if (activeScopes?.count !== expectedActiveScopes) {
      throw new Error('Report owner or producer scope authority is terminal');
    }
    const digest = sha256(input.content);
    const publicationId = reportPublicationId(
      input.runId,
      input.ownerScopeId,
      input.publicationKey,
    );
    const existingPublication = context.get<ReportRevision>(`
      ${REPORT_REVISION_SELECTION}
      WHERE
        revisions.run_id = ?
        AND revisions.owner_scope_id = ?
        AND revisions.publication_id = ?
    `, input.runId, input.ownerScopeId, publicationId);
    if (existingPublication !== undefined) {
      const validatedPublication = readValidatedStoredReportStreamHistory(
        context,
        {
          runId: input.runId,
          ownerScopeId: input.ownerScopeId,
          stream: existingPublication,
        },
      ).find((revision) => revision.publicationId === publicationId);
      if (validatedPublication === undefined) {
        throw new Error(
          `Report publication identity mismatch for "${publicationId}"`,
        );
      }
      if (
        validatedPublication.streamName !== input.stream.name
        || validatedPublication.portableIdentity !== input.stream.portableIdentity
        || validatedPublication.publicationKey !== input.publicationKey
        || validatedPublication.codecName !== input.codecName
        || validatedPublication.digest !== digest
        || validatedPublication.producerScopeId !== input.producerScopeId
        || validatedPublication.producerExecutionId !== input.producerExecutionId
      ) {
        throw new Error(
          `Report publication collision for "${publicationId}"`,
        );
      }
      return validatedPublication;
    }
    const producerExecution = context.get<{
      readonly stepId: string;
      readonly runSessionId: string | null;
      readonly personaSessionId: string | null;
      readonly personaName: string | null;
    }>(`
      SELECT
        executions.step_id AS stepId,
        executions.run_session_id AS runSessionId,
        executions.persona_session_id AS personaSessionId,
        personas.persona_name AS personaName
      FROM step_executions AS executions
      LEFT JOIN persona_sessions AS personas
        ON personas.run_id = executions.run_id
        AND personas.scope_id = executions.scope_id
        AND personas.persona_session_id = executions.persona_session_id
      WHERE
        executions.run_id = ?
        AND executions.scope_id = ?
        AND executions.execution_id = ?
    `, input.runId, input.producerScopeId, input.producerExecutionId);
    if (producerExecution === undefined) {
      throw new Error(
        `Report producer execution "${input.producerExecutionId}" is missing or cross-scope`,
      );
    }
    const streamId = derivePublicReportStreamId(
      input.runId,
      input.ownerScopeId,
      input.stream,
    );
    let stream = resolveStoredReportStream(context, input);
    if (stream === undefined) {
      if (input.expectedRevision !== 0) {
        throw new Error(`Report revision CAS mismatch for "${input.stream.name}"`);
      }
      context.run(`
        INSERT INTO report_streams (
          run_id,
          owner_scope_id,
          stream_id,
          stream_name,
          portable_identity,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      input.runId,
      input.ownerScopeId,
      streamId,
      input.stream.name,
      input.stream.portableIdentity,
      input.createdAt);
      stream = {
        streamId,
        streamName: input.stream.name,
        portableIdentity: input.stream.portableIdentity,
      };
    }
    const current = context.get<{ readonly revision: number }>(`
      SELECT count(*) AS revision
      FROM report_revisions
      WHERE run_id = ? AND owner_scope_id = ? AND stream_id = ?
    `, input.runId, input.ownerScopeId, stream.streamId);
    if (current === undefined || current.revision !== input.expectedRevision) {
      throw new Error(`Report revision CAS mismatch for "${input.stream.name}"`);
    }
    const revision = current.revision + 1;
    context.run(`
      INSERT INTO report_revisions (
        run_id,
        owner_scope_id,
        stream_id,
        revision,
        publication_id,
        publication_key,
        producer_scope_id,
        producer_execution_id,
        producer_step_id,
        producer_run_session_id,
        producer_persona_session_id,
        producer_persona_name,
        codec_name,
        content,
        digest,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    input.runId,
    input.ownerScopeId,
    stream.streamId,
    revision,
    publicationId,
    input.publicationKey,
    input.producerScopeId,
    input.producerExecutionId,
    producerExecution.stepId,
    producerExecution.runSessionId,
    producerExecution.personaSessionId,
    producerExecution.personaName,
    input.codecName,
    input.content,
    digest,
    input.createdAt);
    const storedRevision: ReportRevision = {
      streamId: stream.streamId,
      streamName: stream.streamName,
      portableIdentity: stream.portableIdentity,
      revision,
      publicationId,
      publicationKey: input.publicationKey,
      codecName: input.codecName,
      content: input.content,
      digest,
      ownerScopeId: input.ownerScopeId,
      producerScopeId: input.producerScopeId,
      producerExecutionId: input.producerExecutionId,
      producerStepId: producerExecution.stepId,
      producerRunSessionId: producerExecution.runSessionId,
      producerPersonaSessionId: producerExecution.personaSessionId,
      producerPersonaName: producerExecution.personaName,
      createdAt: input.createdAt,
    };
    assertReportRevisionIntegrity(storedRevision, input);
    return storedRevision;
  }

  history(context: RunReadContext, input: {
    readonly runId: string;
    readonly ownerScopeId: string;
    readonly stream: PublicReportStreamIdentity;
  }): ReportRevision[] {
    assertPublicReportStreamIdentity(input.stream, 'ReportRepository.history');
    const stream = resolveStoredReportStream(context, input);
    if (stream === undefined) {
      return [];
    }
    return readValidatedStoredReportStreamHistory(context, {
      runId: input.runId,
      ownerScopeId: input.ownerScopeId,
      stream,
    });
  }

  revision(context: RunReadContext, input: {
    readonly runId: string;
    readonly ownerScopeId: string;
    readonly stream: PublicReportStreamIdentity;
    readonly revision: number;
  }): ReportRevision | undefined {
    assertPublicReportStreamIdentity(input.stream, 'ReportRepository.revision');
    const stream = resolveStoredReportStream(context, input);
    if (stream === undefined) {
      return undefined;
    }
    return readValidatedStoredReportStreamHistory(context, {
      runId: input.runId,
      ownerScopeId: input.ownerScopeId,
      stream,
    }).find((revision) => revision.revision === input.revision);
  }

  latest(context: RunReadContext, input: {
    readonly runId: string;
    readonly ownerScopeId: string;
    readonly stream: PublicReportStreamIdentity;
  }): ReportRevision | undefined {
    return this.history(context, input).at(-1);
  }
}
