import type { V2Event } from '@opencode/client';
import type { OpenCodeStreamEvent, OpenCodeToolPart } from './OpenCodeStreamHandler.js';
import { fromV2ToolName } from './v2-contract.js';

export function v2EventTranslator(): (event: V2Event) => OpenCodeStreamEvent | undefined {
  const tools = new Map<string, OpenCodeToolPart>();
  return (event) => {
    switch (event.type) {
      case 'session.text.started':
      case 'session.reasoning.started': {
        const data = event.data;
        const type = event.type === 'session.text.started' ? 'text' : 'reasoning';
        return { type: 'message.part.updated', properties: { part: {
          id: `${data.assistantMessageID}:${type}:${data.ordinal}`, sessionID: data.sessionID, type, text: '',
        } } };
      }
      case 'session.text.delta':
      case 'session.reasoning.delta': {
        const data = event.data;
        const type = event.type === 'session.text.delta' ? 'text' : 'reasoning';
        return { type: 'message.part.delta', properties: {
          partID: `${data.assistantMessageID}:${type}:${data.ordinal}`, sessionID: data.sessionID, field: 'text', delta: data.delta,
        } };
      }
      case 'session.text.ended':
      case 'session.reasoning.ended': {
        const data = event.data;
        const type = event.type === 'session.text.ended' ? 'text' : 'reasoning';
        return { type: 'message.part.updated', properties: { part: {
          id: `${data.assistantMessageID}:${type}:${data.ordinal}`, sessionID: data.sessionID, type, text: data.text,
        } } };
      }
      case 'session.tool.input.started': {
        const data = event.data;
        const id = `${data.assistantMessageID}:${data.id}`;
        const part: OpenCodeToolPart = {
          id, sessionID: data.sessionID, type: 'tool', callID: data.id,
          tool: fromV2ToolName(data.name), state: { status: 'pending', input: {} },
        };
        tools.set(id, part);
        return { type: 'message.part.updated', properties: { part } };
      }
      case 'session.tool.called':
      case 'session.tool.progress':
      case 'session.tool.success':
      case 'session.tool.failed': {
        const data = event.data;
        const id = `${data.assistantMessageID}:${data.id}`;
        const previous = tools.get(id);
        if (previous === undefined) throw new Error('OpenCode v2 tool event has no preceding tool input event');
        const part: OpenCodeToolPart = event.type === 'session.tool.called'
          ? { ...previous, state: { status: 'running', input: {
            ...event.data.input,
            ...(typeof event.data.input.path === 'string' ? { filePath: event.data.input.path } : {}),
          } } }
          : event.type === 'session.tool.progress'
            ? { ...previous, state: { status: 'running', input: previous.state.input,
              ...(typeof event.data.metadata.title === 'string' ? { title: event.data.metadata.title } : {}),
            } }
          : event.type === 'session.tool.success'
            ? { ...previous, state: {
              status: 'completed', input: previous.state.input,
              output: event.data.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n'),
              title: previous.tool, metadata: event.data.metadata,
            } }
            : { ...previous, state: { status: 'error', input: previous.state.input, error: event.data.error.message } };
        if (event.type === 'session.tool.called' || event.type === 'session.tool.progress') tools.set(id, part);
        else tools.delete(id);
        return { type: 'message.part.updated', properties: { part } };
      }
      case 'session.step.ended':
        return { type: 'message.part.updated', properties: { part: {
          id: `${event.data.assistantMessageID}:finish`, type: 'step-finish', sessionID: event.data.sessionID,
          cost: event.data.cost, tokens: event.data.tokens,
        } } };
      case 'session.step.failed':
      case 'session.execution.failed':
        return { type: 'session.error', properties: { sessionID: event.data.sessionID, error: event.data.error } };
      case 'session.retry.scheduled':
        return { type: 'session.status', properties: { sessionID: event.data.sessionID, status: {
          type: 'retry', attempt: event.data.attempt, next: event.data.at, message: event.data.error.message,
        } } };
      case 'session.execution.interrupted':
        return { type: 'session.error', properties: { sessionID: event.data.sessionID, error: { message: 'OpenCode execution interrupted' } } };
      case 'session.idle':
      case 'session.execution.succeeded':
        return { type: 'session.idle', properties: { sessionID: event.data.sessionID } };
      case 'permission.asked':
        return { type: 'permission.asked', properties: {
          id: event.data.id, sessionID: event.data.sessionID, permission: fromV2ToolName(event.data.action),
          patterns: event.data.resources, always: event.data.save ?? [],
        } };
      default:
        return undefined;
    }
  };
}
