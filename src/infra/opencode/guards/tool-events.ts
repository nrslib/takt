import type { OpenCodeStreamEvent, OpenCodeToolPart } from '../OpenCodeStreamHandler.js';

export interface OpenCodeToolRejection {
  tool: string;
  error: string;
}

/**
 * 下流（ledger / guard）が無条件に触るフィールドを検証する。
 *
 * sessionID は「あれば string」までしか要求しない。イベント側（
 * `properties.sessionID`）にしか載らない payload を落とすと、ツール呼び出しが
 * in-flight として観測されなくなり、アイドル誤爆や outcome の取りこぼしという
 * より重い壊れ方になる。欠けている場合のキーは call 内で callID により一意。
 */
function isOpenCodeToolPart(part: object): part is OpenCodeToolPart {
  const candidate = part as Partial<OpenCodeToolPart>;
  if (candidate.type !== 'tool' || typeof candidate.tool !== 'string') return false;
  if (candidate.sessionID !== undefined && typeof candidate.sessionID !== 'string') return false;
  if (typeof candidate.callID !== 'string' && typeof candidate.id !== 'string') return false;
  const state: unknown = candidate.state;
  if (typeof state !== 'object' || state === null) return false;
  return typeof (state as { status?: unknown }).status === 'string';
}

export function readOpenCodeToolPart(event: OpenCodeStreamEvent): OpenCodeToolPart | undefined {
  if (event.type !== 'message.part.updated') return undefined;
  // properties / part は provider から来る値なので、型に合わない payload でも落ちない。
  const properties: unknown = event.properties;
  if (typeof properties !== 'object' || properties === null) return undefined;
  const part: unknown = (properties as { part?: unknown }).part;
  if (typeof part !== 'object' || part === null) return undefined;
  return isOpenCodeToolPart(part) ? part : undefined;
}

/**
 * ツール呼び出しの同一性キー。用途で影響度が違うので、片方の都合で緩めない。
 * ToolOutcomeLedger では terminal の重複排除（誤れば outcome の二重計上）、
 * 認証済み transport が追加する IdleTimeoutGuard では安全装置を止める判断
 * （誤れば健全な実行の切断、またはアイドル検知の停止）に使う。
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
