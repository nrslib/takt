import type { ConversationProgress } from '../types/conversation-activity.js';

function toolCallKey(callId: string | undefined, toolId: string | undefined): string {
  return JSON.stringify([callId ?? null, toolId ?? null]);
}

/**
 * 途中出力を一度落としたツール呼び出しを、tool_result まで覚える。
 * 落とした分を抜いたテキストを redactor に渡すと、チャンクの境目をまたぐ秘密値の後半をマスクできない。
 * そのため、落とした後の同じツール呼び出しの途中出力もすべて落とす。表示は完了時の entry で戻る。
 */
export class DroppedToolOutputs {
  private readonly calls = new Set<string>();

  /** 落とした途中表示を記録する。ツールの途中出力以外は、後続の表示に影響しないので覚えない。 */
  record(message: ConversationProgress): void {
    if (typeof message === 'string' || message.kind !== 'tool_event' || message.event.type !== 'tool_output') return;
    this.calls.add(toolCallKey(message.event.toolActivity?.callId, message.event.data.id));
  }

  /** 前に途中出力を落としたツール呼び出しの途中出力なら true を返す。tool_result を受けると、そのツール呼び出しを忘れる。 */
  follows(message: ConversationProgress): boolean {
    if (typeof message === 'string' || message.kind !== 'tool_event') return false;
    const { event } = message;
    const callId = event.toolActivity?.callId;
    if (event.type === 'tool_output') return this.calls.has(toolCallKey(callId, event.data.id));
    if (event.type === 'tool_result') {
      for (const id of [event.data.id, ...(event.data.completedToolIds ?? [])]) this.calls.delete(toolCallKey(callId, id));
    }
    return false;
  }
}
