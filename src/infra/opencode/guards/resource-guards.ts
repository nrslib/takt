import {
  type BoundedSensitiveValues,
  type SensitiveBudgetExhaustReason,
} from '../../../shared/utils/sensitiveText.js';
import type {
  OpenCodePart,
  OpenCodeStreamEvent,
  OpenCodeToolPart,
} from '../OpenCodeStreamHandler.js';
import { computeToolInputHash } from '../tool-call-tuple.js';
import type { ResolvedOpenCodeGuardPolicy } from './policy.js';
import type {
  OpenCodeGuard,
  OpenCodeGuardLifecycleScope,
  OpenCodeGuardVerdict,
} from './types.js';

function trackingFailure(reason: string): OpenCodeGuardVerdict {
  return {
    action: 'fail',
    reason: `OpenCode stream tracking limit exceeded: ${reason}`,
  };
}

function guardPartKey(sessionId: unknown, partId: unknown): string | undefined {
  return typeof partId === 'string'
    ? `${typeof sessionId === 'string' ? sessionId : ''}\0${partId}`
    : undefined;
}

function guardDelta(
  event: OpenCodeStreamEvent,
  partType: string,
  offsets: Map<string, number>,
): string | undefined {
  if (event.type === 'message.part.updated') {
    const part = event.properties.part as OpenCodePart;
    if (part.type !== partType) return undefined;
    const key = guardPartKey(part.sessionID, part.id);
    if (key === undefined) return undefined;
    const delta = event.properties.delta;
    if (typeof delta === 'string') {
      offsets.set(key, (offsets.get(key) ?? 0) + delta.length);
      return delta;
    }
    const text = (part as { text?: unknown }).text;
    if (typeof text !== 'string') return undefined;
    const previous = offsets.get(key) ?? 0;
    offsets.set(key, text.length);
    return text.length > previous ? text.slice(previous) : undefined;
  }
  if (event.type !== 'message.part.delta') return undefined;
  const properties = event.properties as Record<string, unknown>;
  const delta = properties.field === 'text'
    && properties.guardPartType === partType
    && typeof properties.delta === 'string'
    ? properties.delta
    : undefined;
  const key = guardPartKey(properties.sessionID, properties.partID);
  if (delta !== undefined && key !== undefined) {
    offsets.set(key, (offsets.get(key) ?? 0) + delta.length);
  }
  return delta;
}

abstract class ByteVolumeGuard implements OpenCodeGuard {
  abstract readonly id: string;
  readonly layer = 'resource' as const;
  private bytes = 0;
  private readonly offsets = new Map<string, number>();

  constructor(
    private readonly partType: 'text' | 'reasoning',
    private readonly byteLimit: number,
    private readonly reason: 'text_bytes' | 'reasoning_bytes',
  ) {}

  onEvent(event: OpenCodeStreamEvent): OpenCodeGuardVerdict | undefined {
    const delta = guardDelta(event, this.partType, this.offsets);
    if (delta === undefined) return undefined;
    this.bytes += Buffer.byteLength(delta, 'utf8');
    return this.bytes > this.byteLimit ? trackingFailure(this.reason) : undefined;
  }
}

export class TextVolumeGuard extends ByteVolumeGuard {
  readonly id = 'text-volume';

  constructor(policy: ResolvedOpenCodeGuardPolicy) {
    super('text', policy.streamLimits.textByteLimit, 'text_bytes');
  }
}

export class ReasoningVolumeGuard extends ByteVolumeGuard {
  readonly id = 'reasoning-volume';

  constructor(policy: ResolvedOpenCodeGuardPolicy) {
    super('reasoning', policy.streamLimits.reasoningByteLimit, 'reasoning_bytes');
  }
}

export class EventCountGuard implements OpenCodeGuard {
  readonly id = 'event-count';
  readonly layer = 'resource' as const;
  private count = 0;

  constructor(private readonly limit: number) {}

  onEvent(event: OpenCodeStreamEvent): OpenCodeGuardVerdict | undefined {
    if (event.type === 'message.part.delta' || event.type === 'message.part.updated') {
      return undefined;
    }
    this.count += 1;
    return this.count > this.limit ? trackingFailure('event_count') : undefined;
  }
}

export class TrackedIdsGuard implements OpenCodeGuard {
  readonly id = 'tracked-ids';
  readonly layer = 'resource' as const;
  private readonly ids = new Set<string>();

  constructor(private readonly limit: number) {}

  onEvent(event: OpenCodeStreamEvent): OpenCodeGuardVerdict | undefined {
    const id = this.extractId(event);
    if (id === undefined || this.ids.has(id)) return undefined;
    if (this.ids.size >= this.limit) return trackingFailure('tracked_id_count');
    this.ids.add(id);
    return undefined;
  }

  private extractId(event: OpenCodeStreamEvent): string | undefined {
    if (event.type === 'message.part.updated') {
      const part = event.properties.part as OpenCodePart;
      return part.type === 'tool'
        ? ((part as OpenCodeToolPart).callID || part.id)
        : part.id;
    }
    if (event.type !== 'message.part.delta') return undefined;
    const partId = event.properties.partID;
    return typeof partId === 'string' ? partId : undefined;
  }
}

function sensitiveFailure(reason: SensitiveBudgetExhaustReason | undefined): OpenCodeGuardVerdict {
  const suffix = reason ?? 'unknown';
  return {
    action: 'fail',
    reason: `OpenCode sensitive value budget exceeded: ${suffix}`,
  };
}

export class SensitiveBudgetGuard implements OpenCodeGuard {
  readonly id = 'sensitive-budget';
  readonly layer = 'integrity' as const;
  private readonly latestInputHashes = new Map<string, string>();

  constructor(readonly sensitiveValues: BoundedSensitiveValues) {}

  start(scope: OpenCodeGuardLifecycleScope): void {
    if (scope === 'attempt') this.latestInputHashes.clear();
  }

  onInitialSource(source: unknown): OpenCodeGuardVerdict | undefined {
    return this.collect(source);
  }

  private collect(source: unknown): OpenCodeGuardVerdict | undefined {
    this.sensitiveValues.collect(source);
    return this.sensitiveValues.exhausted
      ? sensitiveFailure(this.sensitiveValues.exhaustReason)
      : undefined;
  }

  onEvent(event: OpenCodeStreamEvent): OpenCodeGuardVerdict | undefined {
    if (event.type !== 'message.part.updated') return undefined;
    const part = event.properties.part as OpenCodePart;
    if (part.type !== 'tool') return undefined;
    const toolPart = part as OpenCodeToolPart;
    const inputHash = computeToolInputHash(toolPart.state.input);
    const key = `${toolPart.sessionID}\0${toolPart.callID || toolPart.id}`;
    if (inputHash !== undefined && this.latestInputHashes.get(key) === inputHash) {
      if (toolPart.state.status === 'completed' || toolPart.state.status === 'error') {
        this.latestInputHashes.delete(key);
      }
      return undefined;
    }
    if (inputHash !== undefined) this.latestInputHashes.set(key, inputHash);
    const verdict = this.collect(toolPart.state.input);
    if (toolPart.state.status === 'completed' || toolPart.state.status === 'error') {
      this.latestInputHashes.delete(key);
    }
    return verdict;
  }
}
