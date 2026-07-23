import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { PartResult } from '../../models/types.js';
import type { RunPaths } from '../run/run-paths.js';
import { ensurePrivateDirectory, writeNewPrivateFileWithMode } from '../../../shared/utils/private-file.js';
import type { TeamLeaderArtifactReference } from './team-leader-aggregation.js';

const ARTIFACT_SEGMENT_MAX_LENGTH = 80;

function safeSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  if (normalized.length === 0) {
    throw new Error(`Team Leader artifact path segment is empty after normalization: ${value}`);
  }
  if (normalized.length <= ARTIFACT_SEGMENT_MAX_LENGTH) return normalized;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12);
  const prefixLength = ARTIFACT_SEGMENT_MAX_LENGTH - digest.length - 1;
  return `${normalized.slice(0, prefixLength)}-${digest}`;
}

export function createTeamLeaderArtifactAttemptId(stepIteration: number): string {
  return `${String(stepIteration).padStart(4, '0')}-${randomUUID()}`;
}

export function writeTeamLeaderPartArtifact(input: {
  runPaths: RunPaths;
  stepName: string;
  attemptId: string;
  batchNumber: number;
  partIndex: number;
  result: PartResult;
}): TeamLeaderArtifactReference {
  const stepSegment = safeSegment(input.stepName);
  const attemptSegment = `attempt-${safeSegment(input.attemptId)}`;
  const batchSegment = `batch-${String(input.batchNumber).padStart(4, '0')}`;
  const relativeDirectory = join('team_leader', stepSegment, attemptSegment, batchSegment);
  const absoluteDirectory = join(input.runPaths.contextAbs, relativeDirectory);
  ensurePrivateDirectory(absoluteDirectory);

  const idHash = createHash('sha256').update(input.result.part.id).digest('hex').slice(0, 8);
  const fileName = `${String(input.partIndex + 1).padStart(3, '0')}-${safeSegment(input.result.part.id)}-${idHash}.json`;
  const relativePath = join(input.runPaths.contextRel, relativeDirectory, fileName);
  const absolutePath = join(input.runPaths.contextAbs, relativeDirectory, fileName);
  const content = JSON.stringify({
    part: input.result.part,
    response: {
      status: input.result.response.status,
      content: input.result.response.content,
      error: input.result.response.error,
      structuredOutput: input.result.response.structuredOutput,
      timestamp: input.result.response.timestamp.toISOString(),
    },
    providerInfo: input.result.providerInfo,
    durationMs: input.result.durationMs,
  }, null, 2);
  writeNewPrivateFileWithMode(absolutePath, content, 0o600);
  return {
    path: relativePath,
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
  };
}
