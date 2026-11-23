import type { WorkflowResumePointEntry } from '../../models/types.js';
import { getResumePointWorkflowReference } from '../workflow-reference.js';

interface ResumeReportConsumerIdentity {
  readonly workflow: string;
  readonly step: string;
  readonly calls: readonly {
    readonly workflow: string;
    readonly step: string;
    readonly kind: 'workflow_call';
    readonly call_instance: number;
  }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasResumeReportConsumerFields(
  value: unknown,
): value is Omit<ResumeReportConsumerIdentity, 'calls'> & { calls: Record<string, unknown>[] } {
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
      && typeof call.workflow === 'string'
      && call.workflow.length > 0
      && typeof call.step === 'string'
      && call.step.length > 0
      && call.kind === 'workflow_call'
    ));
}

export function classifyResumeReportConsumerKey(value: string): 'valid' | 'legacy' | 'invalid' {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!hasResumeReportConsumerFields(parsed) || JSON.stringify(parsed) !== value) {
      return 'invalid';
    }
    if (parsed.calls.every((call) => Object.keys(call).length === 4
      && typeof call.call_instance === 'number'
      && Number.isSafeInteger(call.call_instance)
      && call.call_instance > 0)) {
      return 'valid';
    }
    return parsed.calls.every((call) => Object.keys(call).length === 3 && !('call_instance' in call))
      ? 'legacy'
      : 'invalid';
  } catch {
    return 'invalid';
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
        call_instance: entry.call_instance,
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
