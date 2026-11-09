import { ConversationActivitySchema, MAX_CONVERSATION_TEXT_BYTES, MAX_TOOL_DESCRIPTION_LENGTH, type ConversationActivity } from '../../shared/types/conversation-activity.js';
import type { StreamEvent } from '../../shared/types/provider.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { truncateUtf8 } from '../../shared/utils/utf8.js';
import { toSingleLineText } from '../tui/displayText.js';

export function createTurnActivityReporter(report: (activity: ConversationActivity) => void, reportText: (message: string) => void) {
  let current: ConversationActivity | undefined;
  const tools = new Map<string, Extract<ConversationActivity, { kind: 'tool' }>>();
  let text = '';
  let textBytes = 0;
  let textTruncated = false;
  const discard = (): void => {
    text = '';
    textBytes = 0;
    textTruncated = false;
  };
  const flush = (): void => {
    const message = text;
    discard();
    if (message.trim() !== '') reportText(message);
  };
  const onStream = (event: StreamEvent): void => {
    let next: ConversationActivity;
    switch (event.type) {
      case 'thinking': next = { kind: 'thinking' }; break;
      case 'text': {
        if (!textTruncated) {
          const chunk = truncateUtf8(event.data.text, MAX_CONVERSATION_TEXT_BYTES - textBytes);
          text += chunk.value;
          textBytes += chunk.bytes;
          textTruncated = chunk.bytes < Buffer.byteLength(event.data.text, 'utf8');
        }
        next = { kind: 'responding' };
        break;
      }
      case 'tool_use': {
        flush();
        const rawDescription = event.data.tool === 'Bash' ? event.data.input.description : undefined;
        const description = typeof rawDescription === 'string'
          ? sanitizeSensitiveText(toSingleLineText(rawDescription.replace(/[\r\u2028\u2029]/gu, ' ')).replace(/\s+/gu, ' '))
            .slice(0, MAX_TOOL_DESCRIPTION_LENGTH).replace(/[\uD800-\uDBFF]$/u, '') : '';
        const activity = { kind: 'tool' as const, tool: event.data.tool, ...(description === '' ? {} : { description }) };
        const parsed = ConversationActivitySchema.safeParse(activity);
        if (!parsed.success) return;
        tools.delete(event.data.id);
        tools.set(event.data.id, activity);
        next = activity;
        break;
      }
      case 'tool_result': {
        const completed = event.data.completedToolIds
          ?? (event.data.id === undefined ? [...tools.keys()].slice(-1) : [event.data.id]);
        for (const id of completed) tools.delete(id);
        if (current?.kind !== 'tool') return;
        const tool = [...tools.values()].at(-1);
        next = tool === undefined ? { kind: 'waiting' } : tool;
        break;
      }
      default: return;
    }
    if (current?.kind === next.kind && (current.kind !== 'tool' || next.kind !== 'tool'
      || current.tool === next.tool && current.description === next.description)) return;
    current = next;
    report(next);
  };
  return { onStream, flush, discard };
}
