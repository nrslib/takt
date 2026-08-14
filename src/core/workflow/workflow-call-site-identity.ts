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
  const canonicalJson = JSON.stringify({
    stack: input.stack.map(frameIdentity),
    childWorkflow: getWorkflowReference(input.childWorkflow),
  });
  const digest = createHash('sha256').update(canonicalJson).digest('hex');
  const readableRunPathPrefix = buildWorkflowCallNamespaceSegment(
    currentFrame.step,
    input.childWorkflow.name,
    currentFrame.occurrence,
  ).slice(0, MAX_READABLE_RUN_PATH_PREFIX_LENGTH);
  return {
    runPathSegment: [
      readableRunPathPrefix,
      digest,
    ].join('--site-'),
  };
}
