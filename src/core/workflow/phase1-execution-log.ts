import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StreamEvent } from '../../shared/types/provider.js';
import { normalizeProviderEventValue } from '../../shared/utils/logMetadata.js';
import { collectEmbeddedSensitiveValues, REDACTED_VALUE } from '../../shared/utils/sensitive-text.js';
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

interface SensitiveMatchNode {
  readonly next: Map<string, number>;
  failure: number;
  longest: number;
  shortLengths: number;
}

function maskTextFragments(chunks: readonly string[]): string[] {
  const fullText = chunks.join('');
  const sensitiveValues = new Set<string>();
  collectEmbeddedSensitiveValues(fullText, sensitiveValues);
  if (sensitiveValues.size === 0) return [...chunks];
  const nodes: SensitiveMatchNode[] = [{ next: new Map(), failure: 0, longest: 0, shortLengths: 0 }];
  for (const value of sensitiveValues) {
    let state = 0;
    for (let index = 0; index < value.length; index++) {
      const character = value[index]!;
      let next = nodes[state]!.next.get(character);
      if (next === undefined) {
        next = nodes.length;
        nodes[state]!.next.set(character, next);
        nodes.push({ next: new Map(), failure: 0, longest: 0, shortLengths: 0 });
      }
      state = next;
    }
    if (value.length >= 4) nodes[state]!.longest = Math.max(nodes[state]!.longest, value.length);
    else nodes[state]!.shortLengths |= 1 << value.length;
  }
  const queue = [...nodes[0]!.next.values()];
  for (let position = 0; position < queue.length; position++) {
    const state = queue[position]!;
    for (const [character, next] of nodes[state]!.next) {
      let failure = nodes[state]!.failure;
      while (failure !== 0 && !nodes[failure]!.next.has(character)) failure = nodes[failure]!.failure;
      nodes[next]!.failure = nodes[failure]!.next.get(character) ?? 0;
      nodes[next]!.longest = Math.max(nodes[next]!.longest, nodes[nodes[next]!.failure]!.longest);
      nodes[next]!.shortLengths |= nodes[nodes[next]!.failure]!.shortLengths;
      queue.push(next);
    }
  }
  const maskChanges = new Int32Array(fullText.length + 1);
  const markMask = (start: number, end: number): void => {
    maskChanges[start] = maskChanges[start]! + 1;
    maskChanges[end] = maskChanges[end]! - 1;
  };
  let state = 0;
  for (let index = 0; index < fullText.length; index++) {
    const character = fullText[index]!;
    while (state !== 0 && !nodes[state]!.next.has(character)) state = nodes[state]!.failure;
    state = nodes[state]!.next.get(character) ?? 0;
    const match = nodes[state]!;
    if (match.longest > 0) markMask(index + 1 - match.longest, index + 1);
    for (let length = 1; length <= 3; length++) {
      if ((match.shortLengths & (1 << length)) === 0) continue;
      const before = fullText[index - length];
      const after = fullText[index + 1];
      if ((before === undefined || !/[\p{L}\p{N}_]/u.test(before))
        && (after === undefined || !/[\p{L}\p{N}_]/u.test(after))) {
        markMask(index + 1 - length, index + 1);
      }
    }
  }
  const masked = new Uint8Array(fullText.length);
  let activeMasks = 0;
  for (let index = 0; index < fullText.length; index++) {
    activeMasks += maskChanges[index]!;
    if (activeMasks > 0) masked[index] = 1;
  }
  let offset = 0;
  return chunks.map((chunk) => {
    let output = '';
    let inMaskedSpan = false;
    for (let index = 0; index < chunk.length; index++) {
      if (masked[offset + index]) {
        if (!inMaskedSpan) output += REDACTED_VALUE;
        inMaskedSpan = true;
      } else {
        output += chunk[index];
        inMaskedSpan = false;
      }
    }
    offset += chunk.length;
    return output;
  });
}

export interface Phase1ExecutionLogReference {
  readonly path: string;
  readonly byteSize: number;
  readonly stepName: string;
  readonly stepIteration: number;
}

export async function savePhase1ExecutionLog(
  log: Phase1ExecutionLog,
  logsDirectory: string,
  stepName: string,
  stepIteration: number,
): Promise<Phase1ExecutionLogReference> {
  const content = log.toReportInput();
  const directory = join(logsDirectory, 'phase1-execution');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const safeStepName = stepName.replace(/[^A-Za-z0-9._-]/g, '_');
  const path = join(directory, `${safeStepName}-${stepIteration}-${randomUUID()}.json`);
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { path, byteSize: Buffer.byteLength(content), stepName, stepIteration };
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
    const finishText = (group: StreamGroup): void => {
      const fragments = maskTextFragments(group.chunks);
      for (const [position, index] of group.indexes.entries()) {
        const entry = this.entries[index];
        if (entry?.kind !== 'provider_event' || entry.event.type !== 'text') throw new Error('Text group must contain text events');
        replacements.set(index, { ...entry, event: { type: 'text', data: { text: fragments[position]! } } });
      }
    };
    const finishSource = (source: string | undefined): void => {
      const byId = pendingOutputs.get(source);
      if (byId !== undefined) for (const group of byId.values()) finish(group);
      pendingOutputs.delete(source);
      const idless = pendingIdlessOutputs.get(source);
      if (idless !== undefined) finish(idless);
      pendingIdlessOutputs.delete(source);
      const text = pendingTexts.get(source);
      if (text !== undefined) finishText(text);
      pendingTexts.delete(source);
    };
    for (const [index, entry] of this.entries.entries()) {
      if (entry.kind === 'instruction' || entry.kind === 'attempt_result') {
        finishSource(entry.source);
        continue;
      }
      const event = entry.event;
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
