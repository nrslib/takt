import { createHash } from 'node:crypto';
import type {
  WorkflowConfig,
  WorkflowResumePointEntry,
} from '../models/types.js';
import { getWorkflowReference } from './workflow-reference.js';
import { buildWorkflowCallNamespaceSegment } from './workflow-call-namespace.js';

const MAX_READABLE_RUN_PATH_PREFIX_LENGTH = 160;

export interface WorkflowCallSiteIdentity {
  readonly runPathSegment: string;
}

function frameIdentity(entry: WorkflowResumePointEntry) {
  return {
    workflow: entry.workflow,
    ...(entry.workflow_ref === undefined
      ? {}
      : { workflowRef: entry.workflow_ref }),
    step: entry.step,
    kind: entry.kind,
    occurrence: entry.occurrence,
  };
}

export function buildWorkflowCallSiteIdentity(input: {
  readonly stack: readonly WorkflowResumePointEntry[];
  readonly childWorkflow: WorkflowConfig;
}): WorkflowCallSiteIdentity {
  const currentFrame = input.stack.at(-1);
  if (currentFrame === undefined || currentFrame.kind !== 'workflow_call') {
    throw new Error('Canonical workflow call-site identity requires an active workflow_call frame');
  }
  return {
    runPathSegment: buildWorkflowCallSiteRunPathSegment({
      stack: input.stack,
      childWorkflowName: input.childWorkflow.name,
      childWorkflowRef: getWorkflowReference(input.childWorkflow),
    }),
  };
}

/**
 * Build the persisted report namespace from already-serialized workflow data.
 * Web UI readers use this same implementation because they only have the
 * stack and child workflow identity from session logs, not a live config.
 */
export function buildWorkflowCallSiteRunPathSegment(input: {
  readonly stack: readonly WorkflowResumePointEntry[];
  readonly childWorkflowName: string;
  readonly childWorkflowRef: string;
}): string {
  const currentFrame = input.stack.at(-1);
  if (currentFrame === undefined || currentFrame.kind !== 'workflow_call') {
    throw new Error('Canonical workflow call-site identity requires an active workflow_call frame');
  }
  const canonicalJson = JSON.stringify({
    stack: input.stack.map(frameIdentity),
    childWorkflow: input.childWorkflowRef,
  });
  const digest = createHash('sha256').update(canonicalJson).digest('hex');
  const readableRunPathPrefix = buildWorkflowCallNamespaceSegment(
    currentFrame.step,
    input.childWorkflowName,
    currentFrame.occurrence,
  ).slice(0, MAX_READABLE_RUN_PATH_PREFIX_LENGTH);
  return [readableRunPathPrefix, digest].join('--site-');
}
