import { createHash } from 'node:crypto';
import { sanitizeSensitiveText } from '../../../shared/utils/sensitive-text.js';
import { ROUTING_WORK_SNAPSHOT_LOCAL_IDENTITY, type RoutingModelInput, type RoutingWorkSnapshot } from './contracts.js';
import {
  ROUTING_REMAINING_WORK_FIELD_BUDGET,
  ROUTING_REMAINING_WORK_ITEM_LIMIT,
  ROUTING_REMAINING_WORK_TOTAL_BUDGET,
} from './limits.js';

export const ROUTING_MODEL_INPUT_VERSION = 'routing-model-input/v1';
const FIELD_BUDGET = 2_000;
const STEP_TAG_LIMIT = 32;
const STEP_TAG_BUDGET = 256;

export interface RoutingStepMetadata {
  name: string;
  tags: readonly string[];
  personaKey?: string;
}

export interface RoutingDecisionMetadata {
  stepName: string;
  stepTags: readonly string[];
  personaKey: string;
  workflowName: string;
  provider: string;
  model: string;
  candidateName: string;
}

const FILE_LOCATION_SUFFIX = String.raw`(?::L?\d+|\s+line\s*:?\s*\d+)?`;
const WINDOWS_DRIVE_PATH_PATTERN = new RegExp(
  String.raw`\b[A-Za-z]:[\\/](?:[^\\/\r\n]+[\\/])*[^\s\\/]+${FILE_LOCATION_SUFFIX}`,
  'g',
);
const WINDOWS_UNC_PATH_PATTERN = new RegExp(
  String.raw`\\\\(?:[^\\\r\n]+\\)+[^\s\\]+${FILE_LOCATION_SUFFIX}`,
  'g',
);
const POSIX_PATH_PATTERN = new RegExp(
  String.raw`(^|[\s([{"'=])/(?:[^\s/]+(?:[ \t]+[^\s/]+)*\/)*[^\s/]+${FILE_LOCATION_SUFFIX}`,
  'g',
);
const RELATIVE_FILE_LOCATION_PATTERN = new RegExp(
  String.raw`\b(?:(?:src|lib|test|tests|docs|e2e|builtins|dist|bin|packages|\.takt)(?:/[A-Za-z0-9_. -]+)+|(?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+)${FILE_LOCATION_SUFFIX}\b`,
  'gi',
);
const BASENAME_FILE_LOCATION_PATTERN = new RegExp(
  String.raw`\b[A-Za-z0-9][A-Za-z0-9_.-]*\.[A-Za-z][A-Za-z0-9_-]*(?::L?\d+|\s+line\s*:?\s*\d+)\b`,
  'gi',
);

const replacements: Array<[RegExp, string]> = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]'],
  [/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>'"\])}]+/g, '[URL]'],
  [/\b(?:github\.com|gitlab\.com)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/gi, '[REPOSITORY]'],
  [WINDOWS_UNC_PATH_PATTERN, '[PATH]'],
  [WINDOWS_DRIVE_PATH_PATTERN, '[PATH]'],
  [POSIX_PATH_PATTERN, '$1[PATH]'],
  [RELATIVE_FILE_LOCATION_PATTERN, '[PATH]'],
  [BASENAME_FILE_LOCATION_PATTERN, '[PATH]'],
  [/\bline\s*:?\s*\d+\b/gi, '[LINE]'],
  [/\bF-[A-Za-z0-9]+\b/gi, '[FINDING_ID]'],
  [/\bC-[A-Za-z0-9]+\b/gi, '[CONFLICT_ID]'],
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g, '[SECRET]'],
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactKnownSensitiveValues(text: string, sensitiveValues: readonly string[]): string {
  return [...new Set(sensitiveValues)]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((result, value) => {
      const pattern = new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegExp(value)}(?=$|[^A-Za-z0-9_.-])`, 'g');
      return result.replace(pattern, '$1[REPOSITORY]');
    }, text);
}

function redact(text: string, sensitiveValues: readonly string[] = []): string {
  const generallyRedacted = replacements.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    sanitizeSensitiveText(text),
  );
  return redactKnownSensitiveValues(generallyRedacted, sensitiveValues);
}

function truncate(text: string, budget: number): string {
  return text.length <= budget ? text : text.slice(0, budget);
}

export function normalizeRoutingText(
  text: string,
  budget: number,
  sensitiveValues: readonly string[] = [],
): string {
  return truncate(redact(text, sensitiveValues), budget);
}

export function normalizeRoutingStepMetadata(metadata: RoutingStepMetadata & { personaKey: string }): RoutingStepMetadata & { personaKey: string };
export function normalizeRoutingStepMetadata(metadata: RoutingStepMetadata): RoutingStepMetadata;
export function normalizeRoutingStepMetadata(metadata: RoutingStepMetadata): RoutingStepMetadata {
  return {
    name: normalizeRoutingText(metadata.name, FIELD_BUDGET),
    tags: metadata.tags.slice(0, STEP_TAG_LIMIT).map((tag) => normalizeRoutingText(tag, STEP_TAG_BUDGET)),
    ...(metadata.personaKey !== undefined ? { personaKey: normalizeRoutingText(metadata.personaKey, FIELD_BUDGET) } : {}),
  };
}

export function normalizeRoutingDecisionMetadata(metadata: RoutingDecisionMetadata): RoutingDecisionMetadata {
  const stepMetadata = normalizeRoutingStepMetadata({
    name: metadata.stepName,
    tags: metadata.stepTags,
    personaKey: metadata.personaKey,
  });
  return {
    stepName: stepMetadata.name,
    stepTags: stepMetadata.tags,
    personaKey: stepMetadata.personaKey,
    workflowName: normalizeRoutingText(metadata.workflowName, FIELD_BUDGET),
    provider: normalizeRoutingText(metadata.provider, FIELD_BUDGET),
    model: normalizeRoutingText(metadata.model, FIELD_BUDGET),
    candidateName: normalizeRoutingText(metadata.candidateName, FIELD_BUDGET),
  };
}

function normalizeRemainingWork(
  work: RoutingWorkSnapshot['remainingWork'][number],
  sensitiveValues: readonly string[],
): RoutingWorkSnapshot['remainingWork'][number] {
  return {
    ...work,
    description: normalizeRoutingText(work.description, ROUTING_REMAINING_WORK_FIELD_BUDGET, sensitiveValues),
    ...(work.title !== undefined
      ? { title: normalizeRoutingText(work.title, ROUTING_REMAINING_WORK_FIELD_BUDGET, sensitiveValues) }
      : {}),
    ...(work.suggestion !== undefined
      ? { suggestion: normalizeRoutingText(work.suggestion, ROUTING_REMAINING_WORK_FIELD_BUDGET, sensitiveValues) }
      : {}),
  };
}

function normalizeRemainingWorkCollection(snapshot: RoutingWorkSnapshot): Pick<RoutingModelInput, 'remainingWork' | 'remainingWorkOmittedCount'> {
  const remainingWork: Array<RoutingWorkSnapshot['remainingWork'][number]> = [];
  let serializedLength = 0;
  const sensitiveValues = snapshot[ROUTING_WORK_SNAPSHOT_LOCAL_IDENTITY]?.sensitiveValues ?? [];
  for (const work of snapshot.remainingWork) {
    if (remainingWork.length === ROUTING_REMAINING_WORK_ITEM_LIMIT) break;
    const normalizedWork = normalizeRemainingWork(work, sensitiveValues);
    const normalizedLength = JSON.stringify(normalizedWork).length;
    if (serializedLength + normalizedLength > ROUTING_REMAINING_WORK_TOTAL_BUDGET) break;
    remainingWork.push(normalizedWork);
    serializedLength += normalizedLength;
  }
  const snapshotOmittedCount = snapshot[ROUTING_WORK_SNAPSHOT_LOCAL_IDENTITY]?.omittedWorkCount ?? 0;
  const remainingWorkOmittedCount = snapshotOmittedCount + snapshot.remainingWork.length - remainingWork.length;
  return {
    remainingWork,
    ...(remainingWorkOmittedCount > 0 ? { remainingWorkOmittedCount } : {}),
  };
}

function createWorkContentDigest(remainingWork: RoutingWorkSnapshot['remainingWork']): string {
  const hash = createHash('sha256');
  for (const work of remainingWork) {
    hash.update(JSON.stringify(work));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function normalizeRoutingWorkSnapshot(snapshot: RoutingWorkSnapshot): RoutingModelInput {
  const remainingWork = normalizeRemainingWorkCollection(snapshot);
  const sensitiveValues = snapshot[ROUTING_WORK_SNAPSHOT_LOCAL_IDENTITY]?.sensitiveValues ?? [];
  const stepMetadata = {
    name: normalizeRoutingText(snapshot.step.name, FIELD_BUDGET, sensitiveValues),
    tags: snapshot.step.tags
      .slice(0, STEP_TAG_LIMIT)
      .map((tag) => normalizeRoutingText(tag, STEP_TAG_BUDGET, sensitiveValues)),
    ...(snapshot.step.personaKey !== undefined
      ? { personaKey: normalizeRoutingText(snapshot.step.personaKey, FIELD_BUDGET, sensitiveValues) }
      : {}),
  };
  return {
    version: ROUTING_MODEL_INPUT_VERSION,
    goal: normalizeRoutingText(snapshot.goal, FIELD_BUDGET, sensitiveValues),
    step: {
      ...stepMetadata,
      ...(snapshot.step.instruction !== undefined
        ? { instruction: normalizeRoutingText(snapshot.step.instruction, FIELD_BUDGET, sensitiveValues) }
        : {}),
      stepType: snapshot.step.stepType,
      ...(snapshot.step.edit !== undefined ? { edit: snapshot.step.edit } : {}),
    },
    ...remainingWork,
    progress: { ...snapshot.progress },
  };
}

export function createRoutingWorkFingerprint(snapshot: RoutingWorkSnapshot): string {
  const localIdentity = snapshot[ROUTING_WORK_SNAPSHOT_LOCAL_IDENTITY];
  const work = {
    version: ROUTING_MODEL_INPUT_VERSION,
    goal: snapshot.goal,
    step: snapshot.step,
    workContentDigest: localIdentity?.workDigest ?? createWorkContentDigest(snapshot.remainingWork),
  };
  return createHash('sha256').update(JSON.stringify(work)).digest('hex');
}

export function createRoutingModelInputDigest(input: RoutingModelInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function getRoutingInputTokenBucket(input: RoutingModelInput): 'small' | 'medium' | 'large' {
  const approximateTokenCount = Math.ceil(JSON.stringify(input).length / 4);
  if (approximateTokenCount <= 512) return 'small';
  if (approximateTokenCount <= 2_048) return 'medium';
  return 'large';
}
