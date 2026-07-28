import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildRunPaths } from '../../../core/workflow/run/run-paths.js';
import { readRunMeta } from '../../../core/workflow/run/run-meta.js';
import type {
  RunStorageRoot,
  TerminalPublication,
  TerminalPublicationStage,
} from '../../../infra/run-storage/index.js';
import { openRunStorage } from '../../../infra/run-storage/index.js';
import { projectTerminalRunMeta } from './runMeta.js';
import {
  RunCleanupError,
  RunProjectionError,
  type RunFinalization,
} from './workflowRunExecution.js';
import type {
  WorkflowTerminalPublicationPayload,
} from './workflowTerminalPayload.js';
import {
  deserializeWorkflowTerminalPublication,
} from './workflowTerminalPayload.js';
import {
  projectWorkflowTerminalStage,
  type WorkflowTerminalMetaProjection,
} from './workflowTerminalProjection.js';

const TERMINAL_STAGE_CLAIM_DURATION_MS = 30_000;

export async function reconcileWorkflowTerminalPublication(input: {
  readonly databasePath: string;
  readonly expectedRunId: string;
}): Promise<RunFinalization> {
  const issues: Array<RunProjectionError | RunCleanupError> = [];
  let root: RunStorageRoot | undefined;
  try {
    root = openRunStorage({ databasePath: input.databasePath });
    const snapshot = root.readResumeSnapshot();
    if (snapshot.run.runId !== input.expectedRunId) {
      throw new Error(
        `Run database slug "${String(snapshot.run.runId)}" does not match `
        + `directory slug "${input.expectedRunId}"`,
      );
    }
    let publication = root.readTerminalPublication();
    if (publication !== undefined && publication.publishedAt === undefined) {
      const payload = parseWorkflowTerminalPublication(
        publication,
        input.expectedRunId,
      );
      assertBootstrapSeedMatchesPayload(
        root.readBootstrapSeed(),
        payload,
      );
      while (publication.stages.length !== 0) {
        const claim = root.claimTerminalPublicationStage({
          claimDurationMs: TERMINAL_STAGE_CLAIM_DURATION_MS,
        });
        if (claim === undefined) {
          break;
        }
        const stage = claim.stage;
        try {
          publishStage(stage, publication, payload, input);
          root.acknowledgeTerminalPublicationStage(claim);
          publication = requireTerminalPublication(
            root.readTerminalPublication(),
          );
        } catch (error) {
          issues.push(new RunProjectionError(stage, error));
          try {
            root.expireTerminalPublicationStageClaim(claim);
          } catch (claimError) {
            issues.push(new RunProjectionError('publication', claimError));
          }
          break;
        }
      }
      if (
        issues.length === 0
        && publication.stages.length === 0
        && publication.publishedAt === undefined
      ) {
        throw new Error(
          `Terminal publication "${publication.eventId}" did not reach `
          + 'its published state',
        );
      }
    }
  } catch (error) {
    issues.push(new RunProjectionError('publication', error));
  } finally {
    if (root !== undefined) {
      try {
        root.close();
      } catch (error) {
        issues.push(new RunCleanupError(error));
      }
    }
  }
  return Object.freeze({ issues: Object.freeze(issues) });
}

function assertBootstrapSeedMatchesPayload(
  seed: ReturnType<RunStorageRoot['readBootstrapSeed']>,
  payload: WorkflowTerminalPublicationPayload,
): void {
  if (
    payload.task !== seed.task
    || payload.workflowName !== seed.workflowName
    || payload.projectCwd !== seed.projectCwd
    || payload.metaSeed.backend !== seed.backend
    || payload.metaSeed.startedAt !== seed.startedAt
    || JSON.stringify(payload.metaSeed.resumeSource)
      !== JSON.stringify(seed.resumeSource)
    || payload.ndjsonLogFile !== `${seed.sessionId}.jsonl`
  ) {
    throw new Error(
      `Terminal publication bootstrap seed mismatch for "${payload.runSlug}"`,
    );
  }
}

function publishStage(
  stage: TerminalPublicationStage,
  publication: TerminalPublication,
  payload: WorkflowTerminalPublicationPayload,
  input: {
    readonly databasePath: string;
    readonly expectedRunId: string;
  },
): void {
  const cwd = resolve(dirname(input.databasePath), '..', '..', '..');
  projectWorkflowTerminalStage(stage, payload, {
    runPaths: buildRunPaths(cwd, input.expectedRunId),
    metaProjection: sqliteTerminalMetaProjection,
    publicationId: publication.eventId,
  });
}

const sqliteTerminalMetaProjection: WorkflowTerminalMetaProjection = {
  project(payload, runPaths, publicationId): void {
    const current = readRunMeta(runPaths.metaAbs);
    if (current === null && existsSync(runPaths.metaAbs)) {
      throw new Error(
        `Run metadata is malformed for terminal publication "${runPaths.slug}"`,
      );
    }
    if (
      current !== null
      && (
        current.runSlug !== runPaths.slug
        || current.storageBackend !== 'sqlite'
      )
    ) {
      throw new Error(
        `Run metadata identity does not match terminal publication `
        + `"${runPaths.slug}"`,
      );
    }
    projectTerminalRunMeta({
      runPaths,
      publicationId,
      seed: {
        task: payload.task,
        workflowName: payload.workflowName,
        projectCwd: payload.projectCwd,
        ...payload.metaSeed,
      },
      status: payload.status,
      iterations: payload.iterations,
      ...(payload.reason === undefined ? {} : { reason: payload.reason }),
      endTime: payload.endTime,
    });
  },
};

function parseWorkflowTerminalPublication(
  publication: TerminalPublication,
  expectedRunId: string,
): WorkflowTerminalPublicationPayload {
  const parsed = deserializeWorkflowTerminalPublication(publication.payload);
  const expectedStatus = publication.status;
  const invalidFields = [
    parsed.runSlug === expectedRunId ? undefined : 'runSlug',
    parsed.status === expectedStatus ? undefined : 'status',
    parsed.iterations === publication.iteration ? undefined : 'iterations',
    parsed.reason === publication.reason ? undefined : 'reason',
  ].filter((field): field is string => field !== undefined);
  if (invalidFields.length !== 0) {
    throw new Error(
      `Terminal publication "${publication.eventId}" payload fields are `
      + `invalid: ${invalidFields.join(', ')}`,
    );
  }
  return parsed;
}

function requireTerminalPublication(
  publication: TerminalPublication | undefined,
): TerminalPublication {
  if (publication === undefined) {
    throw new Error('Terminal publication disappeared during reconciliation');
  }
  return publication;
}
