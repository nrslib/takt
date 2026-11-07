import { ConversationActivitySchema, type ConversationActivity } from '../../shared/types/conversation-activity.js';
import type { StreamEvent } from '../../shared/types/provider.js';

export function createTurnActivityReporter(report: (activity: ConversationActivity) => void) {
  let current: ConversationActivity | undefined;
  const tools = new Map<string, string>();
  return (event: StreamEvent): void => {
    let next: ConversationActivity;
    switch (event.type) {
      case 'thinking': next = { kind: 'thinking' }; break;
      case 'text': next = { kind: 'responding' }; break;
      case 'tool_use': {
        const parsed = ConversationActivitySchema.safeParse({ kind: 'tool', tool: event.data.tool });
        if (!parsed.success) return;
        tools.delete(event.data.id);
        tools.set(event.data.id, event.data.tool);
        next = parsed.data;
        break;
      }
      case 'tool_result': {
        const completed = event.data.completedToolIds
          ?? (event.data.id === undefined ? [...tools.keys()].slice(-1) : [event.data.id]);
        for (const id of completed) tools.delete(id);
        if (current?.kind !== 'tool') return;
        const tool = [...tools.values()].at(-1);
        next = tool === undefined ? { kind: 'waiting' } : { kind: 'tool', tool };
        break;
      }
      default: return;
    }
    if (current?.kind === next.kind && (current.kind !== 'tool' || next.kind !== 'tool' || current.tool === next.tool)) return;
    current = next;
    report(next);
  };
}
