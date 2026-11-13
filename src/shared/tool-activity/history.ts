import type { StreamCallContext, StreamEvent } from '../types/provider.js';
import type { ToolActivityEntry, ToolActivityHistoryState, ToolActivityTurnState, ToolActivityTurnUpdate } from './types.js';
import { ToolActivityHistoryStateSchema } from './schema.js';

function sameContext(left: StreamCallContext | undefined, right: StreamCallContext | undefined): boolean {
  return left?.callId === right?.callId
    && left?.operationId === right?.operationId
    && left?.generation === right?.generation;
}

// 文字列は変更できないので複製しない。途中出力のたびに累積した出力全体を複製しないためでもある。
function copyEntry(entry: ToolActivityEntry): ToolActivityEntry {
  return { ...entry, input: structuredClone(entry.input), ...(entry.context === undefined ? {} : { context: { ...entry.context } }) };
}

function applyHistoryUpdate(history: ToolActivityHistoryState, update: ToolActivityTurnUpdate): ToolActivityHistoryState | undefined {
  if (history.sequence !== update.previousSequence) return undefined;
  const entries = new Map(history.entries.map((entry) => [entry.key, entry]));
  for (const entry of update.entries) entries.set(entry.key, entry);
  if (update.output !== undefined) {
    const entry = entries.get(update.output.key);
    if (entry?.status !== 'running') return undefined;
    entries.set(entry.key, { ...entry, output: entry.output + update.output.text });
  }
  return { entries: [...entries.values()], sequence: update.sequence };
}

/**
 * previousSequence の状態に差分を適用する。差分の起点が手元の状態と一致しなければ undefined を返す。
 * 新しいターンの最初の差分（previousSequence が 0）は、手元に状態がなくても適用できる。
 */
export function applyToolActivityTurnUpdate(state: ToolActivityTurnState | undefined, update: ToolActivityTurnUpdate): ToolActivityTurnState | undefined {
  const sameTurn = state?.operationId === update.operationId && state.generation === update.generation;
  const base: ToolActivityTurnState | undefined = sameTurn ? state
    : update.previousSequence === 0 ? { operationId: update.operationId, generation: update.generation, finished: false,
      history: { entries: [], sequence: 0 } } : undefined;
  if (base === undefined || base.finished) return undefined;
  const history = applyHistoryUpdate(base.history, update);
  return history === undefined ? undefined : { ...base, history };
}

export class ToolActivityHistory {
  private items: ToolActivityEntry[] = [];
  private sequence = 0;
  private nextKey = 1;

  constructor(private readonly now: () => number = () => Date.now()) {}

  get currentSequence(): number {
    return this.sequence;
  }

  entries(): ToolActivityEntry[] {
    return this.items.map(copyEntry);
  }

  snapshot(): ToolActivityHistoryState {
    return { entries: this.entries(), sequence: this.sequence };
  }

  restore(state: ToolActivityHistoryState): void {
    const restored = ToolActivityHistoryStateSchema.parse(state);
    this.items = structuredClone(restored.entries);
    this.sequence = restored.sequence;
    this.nextKey = this.items.reduce((maximum, entry) => Math.max(maximum, Number(entry.key)), 0) + 1;
  }

  get(key: string): ToolActivityEntry | undefined {
    const entry = this.items.find((item) => item.key === key);
    return entry === undefined ? undefined : copyEntry(entry);
  }

  /** 受け取った差分を適用し、変わった entry を返す。起点が一致しなければ何もせず undefined を返す。 */
  applyUpdate(update: ToolActivityTurnUpdate): ToolActivityEntry[] | undefined {
    const next = applyHistoryUpdate({ entries: this.items, sequence: this.sequence }, update);
    if (next === undefined) return undefined;
    const changed = new Set([...update.entries.map((entry) => entry.key), ...(update.output === undefined ? [] : [update.output.key])]);
    this.items = next.entries.map((entry) => changed.has(entry.key) ? copyEntry(entry) : entry);
    this.sequence = next.sequence;
    for (const key of changed) this.nextKey = Math.max(this.nextKey, Number(key) + 1);
    return this.items.filter((entry) => changed.has(entry.key)).map(copyEntry);
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
      return [copyEntry(entry)];
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
      changed.push(copyEntry(entry));
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
      key: String(this.nextKey++), tool, toolId,
      context: context === undefined ? undefined : { ...context },
      input: {}, output: '', status: 'running', association: 'unmatched',
    };
    this.items.push(entry);
    return entry;
  }
}
