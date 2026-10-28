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
    return JSON.stringify(this.entries.filter((entry) => entry.kind !== 'instruction' || entry.dispatched));
  }

  private sanitize<T>(value: T): T {
    return JSON.parse(JSON.stringify(value, normalizeProviderEventValue)) as T;
  }
}
