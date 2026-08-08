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
  // part は provider から来る値なので、型に合わない payload でも落ちない。
  const part: unknown = event.properties.part;
  if (typeof part !== 'object' || part === null) return undefined;
  return (part as OpenCodePart).type === 'tool' ? (part as OpenCodeToolPart) : undefined;
}

/**
 * ツール呼び出しの同一性キー。用途で影響度が違うので、片方の都合で緩めない。
 * ToolOutcomeLedger では terminal の重複排除（誤れば outcome の二重計上）、
 * IdleTimeoutGuard では安全装置を止める判断（誤れば健全な実行の切断、または
 * アイドル検知の停止）に使う。
 */
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
