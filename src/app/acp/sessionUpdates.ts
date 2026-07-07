import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { WorkflowExecutionEvent, WorkflowExecutionResult } from '../../features/tasks/execute/types.js';
import type { AcpEnqueueResult } from './enqueue.js';
import type { TaktAcpSessionUpdate } from './types.js';

function textContent(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

export function formatWorkflowResult(result: WorkflowExecutionResult): string {
  if (result.success) {
    return result.reportDirectory
      ? `Workflow completed. Report: ${result.reportDirectory}`
      : 'Workflow completed.';
  }
  return result.reason
    ? `Workflow failed: ${result.reason}`
    : 'Workflow failed.';
}

export function formatEnqueueResult(result: AcpEnqueueResult): string {
  return [
    'Task added to the TAKT queue.',
    'status: pending',
    ...(result.issueNumber !== undefined ? [`issue: #${result.issueNumber}`] : []),
    'worktree: true',
    `workflow: ${result.workflow}`,
    `task: ${result.taskName}`,
    `file: ${result.tasksFile}`,
    'Run it later with `takt run`.',
  ].join('\n');
}

function workflowEventToText(event: WorkflowExecutionEvent): string {
  switch (event.type) {
    case 'run_started':
      return `Workflow started. Report: ${event.reportDirectory}`;
    case 'step_started':
      return `Starting step "${event.step}" (${event.iteration}/${event.maxSteps})`;
    case 'step_completed':
      return `Completed step "${event.step}" with status ${event.status}`;
    case 'rate_limited':
      return event.message;
    case 'blocked':
      return event.message;
    case 'progress':
      return event.message;
    case 'output':
      return event.message;
    case 'tool_started':
      return `Tool started: ${event.tool}`;
    case 'tool_completed':
      return event.message;
    case 'confirmation_requested':
      return event.message;
    case 'error':
      return event.message;
    case 'completed':
      return event.success
        ? formatWorkflowResult({ success: true, reportDirectory: event.reportDirectory })
        : `Workflow failed: ${event.reason}`;
  }
}

export function mapTaktAcpUpdateToSessionUpdate(update: TaktAcpSessionUpdate): SessionUpdate {
  if (update.kind === 'agent_message') {
    return {
      sessionUpdate: 'agent_message_chunk',
      content: textContent(update.text),
    };
  }

  const event = update.event;
  switch (event.type) {
    case 'output':
      return {
        sessionUpdate: event.outputType === 'thinking' ? 'agent_thought_chunk' : 'agent_message_chunk',
        content: textContent(event.message),
      };
    case 'tool_started':
      return {
        sessionUpdate: 'tool_call',
        toolCallId: event.toolCallId,
        title: event.tool,
        kind: 'other',
        status: 'in_progress',
        rawInput: event.input,
      };
    case 'tool_completed':
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: event.toolCallId,
        status: event.isError ? 'failed' : 'completed',
        content: [{
          type: 'content',
          content: textContent(event.message),
        }],
      };
    case 'confirmation_requested':
      return {
        sessionUpdate: 'tool_call',
        toolCallId: event.confirmationId,
        title: 'Confirmation requested',
        kind: 'other',
        status: 'pending',
        content: [{
          type: 'content',
          content: textContent(event.message),
        }],
      };
    default:
      return {
        sessionUpdate: 'agent_message_chunk',
        content: textContent(workflowEventToText(event)),
      };
  }
}
