import type { StreamEvent } from '../../shared/types/provider.js';
import { normalizeProviderEventValue } from '../../shared/utils/logMetadata.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import type { PhasePromptParts } from './types.js';

type ExecutionLogEntry =
  | { readonly kind: 'instruction'; readonly reason: string; readonly source?: string; readonly prompt: PhasePromptParts; dispatched: boolean }
  | { readonly kind: 'provider_event'; readonly source?: string; readonly event: StreamEvent }
  | { readonly kind: 'attempt_result'; readonly source?: string; readonly status: string; readonly content: string; readonly error?: string; readonly structuredOutput?: Record<string, unknown> };

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
    this.entries.push({ kind: 'provider_event', ...(source === undefined ? {} : { source }), event: this.sanitize(event) });
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
    const redundantOutputs = new Set<number>();
    const pendingOutputs = new Map<string | undefined, Map<string, { chunks: string[]; indexes: number[] }>>();
    for (const [index, entry] of this.entries.entries()) {
      if (entry.kind === 'instruction' || entry.kind === 'attempt_result') {
        pendingOutputs.delete(entry.source);
        continue;
      }
      if (entry.event.type === 'tool_use' && entry.event.data.id) {
        pendingOutputs.get(entry.source)?.delete(entry.event.data.id);
      }
      if (entry.event.type === 'tool_output' && entry.event.data.id) {
        let byId = pendingOutputs.get(entry.source);
        if (byId === undefined) {
          byId = new Map();
          pendingOutputs.set(entry.source, byId);
        }
        const pending = byId.get(entry.event.data.id) ?? { chunks: [], indexes: [] };
        pending.chunks.push(entry.event.data.output);
        pending.indexes.push(index);
        byId.set(entry.event.data.id, pending);
      }
      if (entry.event.type === 'tool_result' && entry.event.data.id) {
        const byId = pendingOutputs.get(entry.source);
        const pending = byId?.get(entry.event.data.id);
        if (pending !== undefined && pending.chunks.join('') === entry.event.data.content) {
          for (const outputIndex of pending.indexes) redundantOutputs.add(outputIndex);
        }
        byId?.delete(entry.event.data.id);
      }
    }
    return JSON.stringify(this.entries.filter((entry, index) =>
      !redundantOutputs.has(index) && (entry.kind !== 'instruction' || entry.dispatched)));
  }

  private sanitize<T>(value: T): T {
    return JSON.parse(JSON.stringify(value, normalizeProviderEventValue)) as T;
  }
}
