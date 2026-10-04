import type { WorkflowResumePointEntry } from '../../models/types.js';
import { getResumePointWorkflowReference } from '../workflow-reference.js';

interface ResumeReportConsumerIdentity {
  readonly workflow: string;
  readonly step: string;
  readonly calls: readonly {
    readonly workflow: string;
    readonly step: string;
    readonly kind: 'workflow_call';
  }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isResumeReportConsumerIdentity(value: unknown): value is ResumeReportConsumerIdentity {
  if (!isRecord(value) || Object.keys(value).length !== 3) {
    return false;
  }
  return typeof value.workflow === 'string'
    && value.workflow.length > 0
    && typeof value.step === 'string'
    && value.step.length > 0
    && Array.isArray(value.calls)
    && value.calls.every((call) => (
      isRecord(call)
      && Object.keys(call).length === 3
      && typeof call.workflow === 'string'
      && call.workflow.length > 0
      && typeof call.step === 'string'
      && call.step.length > 0
      && call.kind === 'workflow_call'
    ));
}

export function isResumeReportConsumerKey(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return isResumeReportConsumerIdentity(parsed) && JSON.stringify(parsed) === value;
  } catch {
    return false;
  }
}

export function buildResumeReportConsumerKey(
  workflowReference: string,
  stepName: string,
  workflowCallPath: readonly WorkflowResumePointEntry[],
): string {
  return JSON.stringify({
    workflow: workflowReference,
    step: stepName,
    calls: workflowCallPath
      .filter((entry) => entry.kind === 'workflow_call')
      .map((entry) => ({
        workflow: getResumePointWorkflowReference(entry),
        step: entry.step,
        kind: entry.kind,
      })),
  });
}

export function buildResumeReportConsumerKeyFromStack(
  stack: readonly WorkflowResumePointEntry[],
): string | undefined {
  const activeEntry = stack.at(-1);
  if (activeEntry === undefined) {
    return undefined;
  }
  return buildResumeReportConsumerKey(
    getResumePointWorkflowReference(activeEntry),
    activeEntry.step,
    stack.slice(0, -1),
  );
}
