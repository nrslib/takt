import {
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type Context,
  type ContextManager,
  type Span,
  type TextMapPropagator,
} from '@opentelemetry/api';
import { vi, expect } from 'vitest';

/**
 * OpenCodeClient 系テストの共有ヘルパ。
 * vi.mock / vi.hoisted はファイル単位でしか効かないため、各テストファイル側に残し、
 * モックストリームやイベントビルダーなど純粋なヘルパだけをここへ集約する。
 */

/**
 * 自セッションの進捗が止まったまま、サーバ全体のバスに無関係イベントが
 * 流れ続ける状況を再現するストリーム。旧実装はこれで永遠に延命していた。
 */
export class ChatterOnlyEventStream implements AsyncIterable<unknown> {
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  readonly returnSpy = vi.fn(async (): Promise<IteratorResult<unknown, void>> => {
    if (this.pendingTimer !== undefined) {
      clearTimeout(this.pendingTimer);
    }
    return { done: true, value: undefined };
  });

  constructor(private readonly chatterIntervalMs: number) {}

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async (): Promise<IteratorResult<unknown, void>> => {
        await new Promise((resolvePromise) => {
          this.pendingTimer = setTimeout(resolvePromise, this.chatterIntervalMs);
        });
        return {
          done: false,
          value: {
            type: 'message.part.updated',
            properties: { part: { id: 'p-x', type: 'text', text: 'sibling', sessionID: 'other-session' } },
          },
        };
      },
      return: this.returnSpy,
    };
  }
}

export class MockEventStream implements AsyncGenerator<unknown, void, unknown> {
  private index = 0;
  private readonly events: unknown[];
  readonly returnSpy = vi.fn(async () => ({ done: true as const, value: undefined }));

  constructor(events: unknown[], sessionID?: string) {
    this.events = sessionID === undefined ? events : events.map((event) => withEventSessionId(event, sessionID));
  }

  [Symbol.asyncIterator](): AsyncGenerator<unknown, void, unknown> {
    return this;
  }

  async next(): Promise<IteratorResult<unknown, void>> {
    if (this.index >= this.events.length) {
      return { done: true, value: undefined };
    }
    const value = this.events[this.index];
    this.index += 1;
    return { done: false, value };
  }

  async return(): Promise<IteratorResult<unknown, void>> {
    return this.returnSpy();
  }

  async throw(e?: unknown): Promise<IteratorResult<unknown, void>> {
    throw e;
  }
}

export function withEventSessionId(event: unknown, sessionID: string): unknown {
  if (typeof event !== 'object' || event === null) {
    return event;
  }
  const streamEvent = event as { type?: unknown; properties?: unknown };
  if (typeof streamEvent.properties !== 'object' || streamEvent.properties === null) {
    return event;
  }
  const properties = streamEvent.properties as Record<string, unknown>;
  if (typeof properties.sessionID === 'string') {
    return event;
  }
  if (streamEvent.type === 'message.part.updated') {
    const part = properties.part;
    if (typeof part === 'object' && part !== null) {
      if (typeof (part as { sessionID?: unknown }).sessionID === 'string') {
        return event;
      }
      return { ...streamEvent, properties: { ...properties, part: { ...part, sessionID } } };
    }
  }
  if (streamEvent.type === 'message.updated' || streamEvent.type === 'message.completed' || streamEvent.type === 'message.failed') {
    const info = properties.info;
    if (typeof info === 'object' && info !== null) {
      if (typeof (info as { sessionID?: unknown }).sessionID === 'string') {
        return event;
      }
      return { ...streamEvent, properties: { ...properties, info: { ...info, sessionID } } };
    }
  }
  return { ...streamEvent, properties: { ...properties, sessionID } };
}

export class StallingEventStream implements AsyncGenerator<unknown, void, unknown> {
  private emitted = false;
  private readonly firstEvent: unknown;
  private readonly signal?: AbortSignal;
  readonly returnSpy = vi.fn(async () => ({ done: true as const, value: undefined }));

  constructor(firstEvent: unknown, signal?: AbortSignal) {
    this.firstEvent = firstEvent;
    this.signal = signal;
  }

  [Symbol.asyncIterator](): AsyncGenerator<unknown, void, unknown> {
    return this;
  }

  async next(): Promise<IteratorResult<unknown, void>> {
    if (!this.emitted) {
      this.emitted = true;
      return { done: false, value: this.firstEvent };
    }
    if (this.signal?.aborted) {
      return { done: true, value: undefined };
    }
    if (this.signal) {
      return new Promise<IteratorResult<unknown, void>>((resolve) => {
        const onAbort = (): void => {
          this.signal?.removeEventListener('abort', onAbort);
          resolve({ done: true, value: undefined });
        };
        this.signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    return new Promise<IteratorResult<unknown, void>>(() => {});
  }

  async return(): Promise<IteratorResult<unknown, void>> {
    return this.returnSpy();
  }

  async throw(e?: unknown): Promise<IteratorResult<unknown, void>> {
    throw e;
  }
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { finally?: unknown }).finally === 'function';
}

export function createTestContextManager(): ContextManager {
  let activeContext: Context = ROOT_CONTEXT;
  return {
    active: () => activeContext,
    with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
      nextContext: Context,
      fn: F,
      thisArg?: ThisParameterType<F>,
      ...args: A
    ): ReturnType<F> {
      const previousContext = activeContext;
      activeContext = nextContext;
      const restore = (): void => {
        activeContext = previousContext;
      };
      try {
        const result = fn.apply(thisArg, args);
        if (isPromiseLike(result)) {
          return result.finally(restore) as ReturnType<F>;
        }
        restore();
        return result;
      } catch (error) {
        restore();
        throw error;
      }
    },
    bind: <T>(_nextContext: Context, target: T): T => target,
    enable() {
      return this;
    },
    disable() {
      activeContext = ROOT_CONTEXT;
      return this;
    },
  };
}

export function createTestTraceContextPropagator(): TextMapPropagator<Record<string, string>> {
  return {
    inject: (nextContext, carrier, setter) => {
      const span = trace.getSpan(nextContext);
      if (!span) {
        return;
      }
      const spanContext = span.spanContext();
      const sampledFlag = (spanContext.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED ? '01' : '00';
      setter.set(carrier, 'traceparent', `00-${spanContext.traceId}-${spanContext.spanId}-${sampledFlag}`);
    },
    extract: (nextContext) => nextContext,
    fields: () => ['traceparent'],
  };
}

export function createTestSpan(traceId: string, spanId: string): Span {
  return {
    spanContext: () => ({
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    }),
  } as unknown as Span;
}

// セッションの deny は後から昇格できないため、edit/write はセッションスコープで
// 常に許可される（フェーズごとの制限は per-prompt tools マップが担う）
export const EMPTY_TOOLS_SESSION_PERMISSION_RULESET = [
  { permission: '*', pattern: '*', action: 'deny' },
  { permission: 'edit', pattern: '*', action: 'allow' },
  { permission: 'write', pattern: '*', action: 'allow' },
  { permission: 'external_directory', pattern: '*', action: 'deny' },
];

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function textPartUpdated(sessionID: string, id: string, text: string): unknown {
  return {
    type: 'message.part.updated',
    properties: {
      part: { id, sessionID, type: 'text', text },
      delta: text,
    },
  };
}

export function reasoningPartUpdated(sessionID: string, id: string, thinking: string): unknown {
  return {
    type: 'message.part.updated',
    properties: {
      part: { id, sessionID, type: 'reasoning', text: thinking },
      delta: thinking,
    },
  };
}

export function sensitiveToolPartUpdated(sessionID: string, id: string, secret: string): unknown {
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id,
        sessionID,
        type: 'tool',
        callID: `call-${id}`,
        tool: 'remote',
        state: { status: 'running', input: { token: secret } },
      },
    },
  };
}

export function expectStreamTextOnce(onStream: ReturnType<typeof vi.fn>, text: string): void {
  const textEvents = onStream.mock.calls
    .map(([event]) => event as { type?: string; data?: { text?: string } })
    .filter((event) => event.type === 'text' && event.data?.text === text);
  expect(textEvents).toHaveLength(1);
}

export function expectStreamThinkingOnce(onStream: ReturnType<typeof vi.fn>, thinking: string): void {
  const thinkingEvents = onStream.mock.calls
    .map(([event]) => event as { type?: string; data?: { thinking?: string } })
    .filter((event) => event.type === 'thinking' && event.data?.thinking === thinking);
  expect(thinkingEvents).toHaveLength(1);
}

export function sessionIdle(sessionID: string): unknown {
  return { type: 'session.idle', properties: { sessionID } };
}

export function successfulSessionAbort(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({ data: true });
}

export function makeOpenCodeClientMock(sessionId: string, responses: string[]): {
  sessionCreate: ReturnType<typeof vi.fn>;
  promptAsync: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
} {
  let turnIndex = 0;
  const sessionCreate = vi.fn().mockResolvedValue({ data: { id: sessionId } });
  const promptAsync = vi.fn().mockResolvedValue(undefined);
  const abort = successfulSessionAbort();
  const subscribe = vi.fn().mockImplementation(() => {
    const text = responses[turnIndex] ?? '';
    const events: unknown[] = [];
    if (text) {
      events.push(textPartUpdated(sessionId, `p-${turnIndex}`, text));
    }
    events.push(sessionIdle(sessionId));
    turnIndex += 1;
    return Promise.resolve({ stream: new MockEventStream(events, sessionId) });
  });
  return { sessionCreate, promptAsync, abort, subscribe };
}

/**
 * UnavailableToolLoopDetector が拾う「unavailable tool」形式のツールエラーイベントを作る。
 * Available tools はサーバ申告の実測形（opencode 1.17.18 の既定有効集合 +
 * 内部擬似ツール 'invalid'）を既定とする。recovery 前置文の有効ツール一覧は
 * この申告を正とするため、テストごとに上書きできる。
 */
export function unavailableToolErrorEvent(
  partId: string,
  callID: string,
  tool: string,
  availableTools = 'bash, edit, glob, grep, invalid, read, skill, todowrite, webfetch, write',
  errorOverride?: string,
): unknown {
  const error = errorOverride
    ?? `Model tried to call unavailable tool '${tool}'. Available tools: ${availableTools}.`;
  return {
    type: 'message.part.updated',
    properties: {
      part: { id: partId, type: 'tool', callID, tool, state: { status: 'error', input: {}, error } },
    },
  };
}

/** promptAsync の n 回目の呼び出しで送られたプロンプト本文を取り出す。 */
export function promptTextOfCall(promptAsync: ReturnType<typeof vi.fn>, index: number): string {
  const payload = promptAsync.mock.calls[index]?.[0] as { parts?: Array<{ text?: string }> } | undefined;
  return payload?.parts?.[0]?.text ?? '';
}

/**
 * fake timers 下でタイマー駆動の待ち（retry backoff・idle watchdog 等）を実時間ゼロで
 * 消化するポンプ。beforeEach で起動し afterEach で stop する。
 * テスト本体が await している間、fake 時間を少しずつ進め続ける。
 */
export function startTimerPump(stepMs = 100): { stop: () => Promise<void> } {
  vi.useFakeTimers();
  let active = true;
  let pumpError: unknown;
  const pump = (async () => {
    while (active) {
      await vi.advanceTimersByTimeAsync(stepMs);
    }
  })().catch((error) => {
    pumpError = error;
  });
  return {
    stop: async (): Promise<void> => {
      active = false;
      await pump;
      vi.useRealTimers();
      if (pumpError !== undefined) {
        throw pumpError;
      }
    },
  };
}
