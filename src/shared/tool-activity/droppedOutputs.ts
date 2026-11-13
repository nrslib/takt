import type { ConversationProgress } from '../types/conversation-activity.js';

/**
 * 途中出力を一度落としたツール呼び出しを、tool_result まで覚える。
 * 落とした分を抜いたテキストを redactor に渡すと、チャンクの境目をまたぐ秘密値の後半をマスクできない。
 * そのため、落とした後の同じツール呼び出しの途中出力もすべて落とす。表示は完了時の entry で戻る。
 */
export class DroppedToolOutputs {
  /** 呼び出し（callId）ごとに、途中出力を落としたツールの ID。ID のない途中出力は null で覚える。 */
  private readonly calls = new Map<string | null, Set<string | null>>();

  /** 落とした途中表示を記録する。ツールの途中出力以外は、後続の表示に影響しないので覚えない。 */
  record(message: ConversationProgress): void {
    if (typeof message === 'string' || message.kind !== 'tool_event' || message.event.type !== 'tool_output') return;
    const callId = message.event.toolActivity?.callId ?? null;
    const ids = this.calls.get(callId) ?? new Set<string | null>();
    ids.add(message.event.data.id ?? null);
    this.calls.set(callId, ids);
  }

  /** 前に途中出力を落としたツール呼び出しの途中出力なら true を返す。tool_result を受けると、そのツール呼び出しを忘れる。 */
  follows(message: ConversationProgress): boolean {
    if (typeof message === 'string' || message.kind !== 'tool_event') return false;
    const { event } = message;
    const callId = event.toolActivity?.callId ?? null;
    const ids = this.calls.get(callId);
    if (ids === undefined) return false;
    if (event.type === 'tool_output') {
      // ID のない途中出力は、同じ呼び出しで実行中のツールへ対応付けられるので、どのツールの続きか区別できない。
      // ID の有無が混ざる呼び出しでは、落とした出力の続きとみなして落とす。
      const id = event.data.id ?? null;
      return ids.has(id) || id === null || ids.has(null);
    }
    if (event.type === 'tool_result') {
      for (const id of [event.data.id, ...(event.data.completedToolIds ?? [])]) ids.delete(id ?? null);
      if (ids.size === 0) this.calls.delete(callId);
    }
    return false;
  }
}
