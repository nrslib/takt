import type { StreamCallContext, StreamEvent } from '../types/provider.js';
import type { ToolActivityEntry } from './types.js';

function sameContext(left: StreamCallContext | undefined, right: StreamCallContext | undefined): boolean {
  return left?.callId === right?.callId
    && left?.operationId === right?.operationId
    && left?.generation === right?.generation;
}

export class ToolActivityHistory {
  private readonly items: ToolActivityEntry[] = [];
  private sequence = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  entries(): ToolActivityEntry[] {
    return structuredClone(this.items);
  }

  get(key: string): ToolActivityEntry | undefined {
    const entry = this.items.find((item) => item.key === key);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  apply(event: StreamEvent): ToolActivityEntry[] {
    const sequence = ++this.sequence;
    const receivedAt = this.now();
    if (event.type === 'tool_use') {
      const existing = this.find(event.data.id, event.toolActivity);
      if (existing?.startedAt !== undefined) return [];
      const entry = this.add(event.data.tool, event.data.id, event.toolActivity);
      entry.input = structuredClone(event.data.input);
      entry.startedAt = receivedAt;
      entry.startSequence = sequence;
      entry.association = 'matched';
      return [structuredClone(entry)];
    }
    if (event.type !== 'tool_result' && event.type !== 'tool_output') return [];

    const ids = event.type === 'tool_result'
      ? [...new Set([...(event.data.id === undefined ? [] : [event.data.id]), ...(event.data.completedToolIds ?? [])])]
      : event.data.id === undefined ? [] : [event.data.id];
    let targets: ToolActivityEntry[];
    if (ids.length > 0) {
      targets = ids.map((id) => this.find(id, event.toolActivity)
        ?? this.add(event.type === 'tool_output' ? event.data.tool : 'Tool', id, event.toolActivity));
    } else {
      const candidates = this.items.filter((entry) => entry.status === 'running'
        && sameContext(entry.context, event.toolActivity));
      // IDのない結果は候補が1件のときだけ対応付ける。
      targets = candidates.length === 1 ? candidates
        : [this.add(event.type === 'tool_output' ? event.data.tool : 'Tool', undefined, event.toolActivity)];
    }
    const changed: ToolActivityEntry[] = [];
    for (const entry of targets) {
      if (event.type === 'tool_output') {
        if (entry.status !== 'running') continue;
        entry.output += event.data.output;
      } else {
        if (entry.status === 'failure' || (entry.status === 'success' && !event.data.isError)) continue;
        entry.result = event.data.content;
        entry.status = event.data.isError ? 'failure' : 'success';
        entry.completedAt = receivedAt;
        entry.completionSequence = sequence;
      }
      changed.push(structuredClone(entry));
    }
    return changed;
  }

  private find(id: string, context: StreamCallContext | undefined): ToolActivityEntry | undefined {
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const entry = this.items[index]!;
      if (entry.toolId === id && sameContext(entry.context, context)) return entry;
    }
    return undefined;
  }

  private add(tool: string, toolId: string | undefined, context: StreamCallContext | undefined): ToolActivityEntry {
    const entry: ToolActivityEntry = {
      key: String(this.items.length + 1), tool, toolId,
      context: context === undefined ? undefined : { ...context },
      input: {}, output: '', status: 'running', association: 'unmatched',
    };
    this.items.push(entry);
    return entry;
  }
}
