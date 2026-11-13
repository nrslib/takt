import { useCallback, useEffect, useRef } from 'react';
import { excludeToolActivityTranscript, mergeToolActivityTranscript, type ToolActivityTranscriptRange } from './toolActivityViewState.js';

function transcriptText(ranges: readonly ToolActivityTranscriptRange[]): string {
  return ranges.map((range) => range.text.replace(/\n$/u, '') + (range.omitted ? '…' : '')).join('\n');
}

/**
 * 表示したツール履歴の完了行を集め、次の送信時（返り値の関数）とターンが変わったときに transcript へ移す。
 * `turn` はターンを識別する値で、変わると集めた行と移し済みの範囲を新しいターン用に作り直す。
 */
export function useToolActivityTranscript(
  turn: unknown,
  transcript: readonly ToolActivityTranscriptRange[] | undefined,
  append: (content: string) => void,
): () => void {
  const displayed = useRef<{ turn: unknown; rows: ToolActivityTranscriptRange[]; committed: ToolActivityTranscriptRange[] }>(
    { turn: undefined, rows: [], committed: [] });
  useEffect(() => {
    if (displayed.current.turn !== turn) {
      const content = transcriptText(displayed.current.rows);
      if (content !== '') append(content);
      displayed.current = { turn, rows: [], committed: [] };
    }
    displayed.current.rows = mergeToolActivityTranscript(displayed.current.rows,
      excludeToolActivityTranscript(transcript ?? [], displayed.current.committed));
  }, [turn, transcript]);
  return useCallback(() => {
    const content = transcriptText(displayed.current.rows);
    if (content !== '') append(content);
    displayed.current.committed = mergeToolActivityTranscript(displayed.current.committed, displayed.current.rows);
    displayed.current.rows = [];
  }, [append]);
}
