import type { StreamEvent } from '../../shared/types/provider.js';
import { normalizeProviderEventValue } from '../../shared/utils/logMetadata.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import type { PhasePromptParts } from './types.js';

type ExecutionLogEntry =
  | { readonly kind: 'instruction'; readonly reason: string; readonly source?: string; readonly prompt: PhasePromptParts; dispatched: boolean }
  | { readonly kind: 'provider_event'; readonly source?: string; readonly event: StreamEvent }
  | { readonly kind: 'attempt_result'; readonly source?: string; readonly status: string; readonly content: string; readonly error?: string; readonly structuredOutput?: Record<string, unknown> };

interface StreamGroup {
  readonly indexes: number[];
  readonly chunks: string[];
  readonly tool?: string;
}

/** Evidence captured by the engine for one step execution, independent of provider log settings. */
export class Phase1ExecutionLog {
  private readonly entries: ExecutionLogEntry[] = [];

  recordInstruction(reason: string, prompt: PhasePromptParts, source?: string): void {
    this.entries.push({ kind: 'instruction', reason, ...(source === undefined ? {} : { source }), prompt: this.sanitize(prompt), dispatched: false });
  }

  markDispatched(source?: string): void {
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index];
      if (entry?.kind === 'instruction' && entry.source === source) {
        entry.dispatched = true;
        return;
      }
    }
  }

  recordEvent(event: StreamEvent, source?: string): void {
    if (event.type === 'thinking') return;
    // Stream chunks must be sanitized together so a secret split at a chunk boundary is masked.
    this.entries.push({ kind: 'provider_event', ...(source === undefined ? {} : { source }), event: JSON.parse(JSON.stringify(event)) as StreamEvent });
  }

  recordResult(response: { status: string; content: string; error?: string; structuredOutput?: Record<string, unknown> }, source?: string): void {
    this.entries.push({
      kind: 'attempt_result',
      ...(source === undefined ? {} : { source }),
      status: response.status,
      content: this.sanitize(response.content),
      ...(response.error === undefined ? {} : { error: this.sanitize(response.error) }),
      ...(response.structuredOutput === undefined ? {} : { structuredOutput: this.sanitize(response.structuredOutput) }),
    });
  }

  recordFailure(error: unknown, source?: string): void {
    this.recordResult({ status: 'error', content: '', error: getErrorMessage(error) }, source);
  }

  toReportInput(): string {
    const omitted = new Set<number>();
    const replacements = new Map<number, ExecutionLogEntry>();
    const pendingOutputs = new Map<string | undefined, Map<string, StreamGroup>>();
    const pendingIdlessOutputs = new Map<string | undefined, StreamGroup>();
    const pendingTexts = new Map<string | undefined, StreamGroup>();
    const finish = (group: StreamGroup, redundant = false): void => {
      const firstIndex = group.indexes[0]!;
      if (redundant) {
        for (const index of group.indexes) omitted.add(index);
        return;
      }
      const first = this.entries[firstIndex];
      if (first?.kind !== 'provider_event') throw new Error('Stream group must start with a provider event');
      const event = first.event;
      if (event.type !== 'tool_output' && event.type !== 'text') throw new Error('Stream group must contain text or tool output');
      if (event.type === 'tool_output') {
        replacements.set(firstIndex, { ...first, event: { type: 'tool_output', data: { ...event.data, output: group.chunks.join('') } } });
      } else {
        replacements.set(firstIndex, { ...first, event: { type: 'text', data: { text: group.chunks.join('') } } });
      }
      for (const index of group.indexes.slice(1)) omitted.add(index);
    };
    const finishSource = (source: string | undefined): void => {
      const byId = pendingOutputs.get(source);
      if (byId !== undefined) for (const group of byId.values()) finish(group);
      pendingOutputs.delete(source);
      const idless = pendingIdlessOutputs.get(source);
      if (idless !== undefined) finish(idless);
      pendingIdlessOutputs.delete(source);
      const text = pendingTexts.get(source);
      if (text !== undefined) finish(text);
      pendingTexts.delete(source);
    };
    for (const [index, entry] of this.entries.entries()) {
      if (entry.kind === 'instruction' || entry.kind === 'attempt_result') {
        finishSource(entry.source);
        continue;
      }
      const event = entry.event;
      if (event.type !== 'text') {
        const text = pendingTexts.get(entry.source);
        if (text !== undefined) finish(text);
        pendingTexts.delete(entry.source);
      }
      if (event.type === 'text') {
        const group = pendingTexts.get(entry.source) ?? { indexes: [], chunks: [] };
        group.indexes.push(index);
        group.chunks.push(event.data.text);
        pendingTexts.set(entry.source, group);
      }
      if (event.type !== 'tool_output' || event.data.id || pendingIdlessOutputs.get(entry.source)?.tool !== event.data.tool) {
        const idless = pendingIdlessOutputs.get(entry.source);
        if (idless !== undefined) finish(idless);
        pendingIdlessOutputs.delete(entry.source);
      }
      if (event.type === 'tool_output' && !event.data.id) {
        const group = pendingIdlessOutputs.get(entry.source) ?? { indexes: [], chunks: [], tool: event.data.tool };
        group.indexes.push(index);
        group.chunks.push(event.data.output);
        pendingIdlessOutputs.set(entry.source, group);
      }
      if (event.type === 'tool_use' && event.data.id) {
        const byId = pendingOutputs.get(entry.source);
        const previous = byId?.get(event.data.id);
        if (previous !== undefined) finish(previous);
        byId?.delete(event.data.id);
      }
      if (event.type === 'tool_output' && event.data.id) {
        let byId = pendingOutputs.get(entry.source);
        if (byId === undefined) {
          byId = new Map();
          pendingOutputs.set(entry.source, byId);
        }
        let group = byId.get(event.data.id);
        if (group !== undefined && group.tool !== event.data.tool) finish(group);
        if (group === undefined || group.tool !== event.data.tool) group = { indexes: [], chunks: [], tool: event.data.tool };
        group.chunks.push(event.data.output);
        group.indexes.push(index);
        byId.set(event.data.id, group);
      }
      if (event.type === 'tool_result' && event.data.id) {
        const byId = pendingOutputs.get(entry.source);
        const group = byId?.get(event.data.id);
        if (group !== undefined) finish(group, group.chunks.join('') === event.data.content);
        byId?.delete(event.data.id);
      }
    }
    for (const source of new Set([...pendingOutputs.keys(), ...pendingIdlessOutputs.keys(), ...pendingTexts.keys()])) finishSource(source);
    return JSON.stringify(this.entries.flatMap((entry, index) => {
      if (omitted.has(index) || (entry.kind === 'instruction' && !entry.dispatched)) return [];
      const retained = replacements.get(index) ?? entry;
      return [retained.kind === 'provider_event' ? this.sanitize(retained) : retained];
    }));
  }

  private sanitize<T>(value: T): T {
    return JSON.parse(JSON.stringify(value, normalizeProviderEventValue)) as T;
  }
}
