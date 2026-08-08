import type {
  OpenCodePart,
  OpenCodeStreamEvent,
  OpenCodeToolPart,
} from '../OpenCodeStreamHandler.js';

export interface OpenCodeToolRejection {
  tool: string;
  error: string;
}

export function readOpenCodeToolPart(event: OpenCodeStreamEvent): OpenCodeToolPart | undefined {
  if (event.type !== 'message.part.updated') return undefined;
  const part = event.properties.part as OpenCodePart;
  return part.type === 'tool' ? (part as OpenCodeToolPart) : undefined;
}

export function openCodeToolCallKey(toolPart: OpenCodeToolPart): string {
  return `${toolPart.sessionID}\0${toolPart.callID || toolPart.id}`;
}

export function isOpenCodeToolTerminal(toolPart: OpenCodeToolPart): boolean {
  return toolPart.state.status === 'completed' || toolPart.state.status === 'error';
}

export function extractOpenCodeToolRejection(
  toolPart: OpenCodeToolPart,
): OpenCodeToolRejection | undefined {
  if (toolPart.state.status === 'error') {
    return { tool: toolPart.tool, error: toolPart.state.error };
  }
  if (toolPart.tool !== 'invalid' || toolPart.state.status !== 'completed') {
    return undefined;
  }
  const input = toolPart.state.input as { tool?: unknown; error?: unknown };
  const attemptedTool = typeof input.tool === 'string' ? input.tool : 'invalid';
  const error = typeof input.error === 'string'
    ? input.error
    : toolPart.state.output;
  return { tool: attemptedTool, error };
}

export function isCompletedToolFailure(toolPart: OpenCodeToolPart): boolean {
  if (toolPart.state.status !== 'completed') return false;
  if (toolPart.tool === 'invalid') return true;
  const metadata = toolPart.state.metadata;
  if (metadata === undefined || !Object.prototype.hasOwnProperty.call(metadata, 'exit')) {
    return false;
  }
  const exit = metadata.exit;
  return (typeof exit === 'number' && exit !== 0) || exit === null;
}

export function toolTerminalResult(toolPart: OpenCodeToolPart): unknown {
  return toolPart.state.status === 'error'
    ? toolPart.state.error
    : toolPart.state.status === 'completed'
      ? toolPart.state.output
      : undefined;
}
