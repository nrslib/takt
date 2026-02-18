/**
 * Stdin simulation helpers for testing interactive conversation loops.
 *
 * Simulates raw-mode TTY input by intercepting process.stdin events,
 * feeding pre-defined input strings one-at-a-time as data events.
 */

import { vi } from 'vitest';

interface SavedStdinState {
  isTTY: boolean | undefined;
  isRaw: boolean | undefined;
  setRawMode: typeof process.stdin.setRawMode | undefined;
  stdoutWrite: typeof process.stdout.write;
  stdinOn: typeof process.stdin.on;
  stdinRemoveListener: typeof process.stdin.removeListener;
  stdinResume: typeof process.stdin.resume;
  stdinPause: typeof process.stdin.pause;
}

let saved: SavedStdinState | null = null;

/**
 * Set up raw stdin simulation with pre-defined inputs.
 *
 * Each string in rawInputs is delivered as a Buffer via 'data' event
 * when the conversation loop registers a listener.
 */
export function setupRawStdin(rawInputs: string[]): void {
  saved = {
    isTTY: process.stdin.isTTY,
    isRaw: process.stdin.isRaw,
    setRawMode: process.stdin.setRawMode,
    stdoutWrite: process.stdout.write,
    stdinOn: process.stdin.on,
    stdinRemoveListener: process.stdin.removeListener,
    stdinResume: process.stdin.resume,
    stdinPause: process.stdin.pause,
  };

  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdin, 'isRaw', { value: false, configurable: true, writable: true });
  process.stdin.setRawMode = vi.fn((mode: boolean) => {
    (process.stdin as unknown as { isRaw: boolean }).isRaw = mode;
    return process.stdin;
  }) as unknown as typeof process.stdin.setRawMode;
  process.stdout.write = vi.fn(() => true) as unknown as typeof process.stdout.write;
  process.stdin.resume = vi.fn(() => process.stdin) as unknown as typeof process.stdin.resume;
  process.stdin.pause = vi.fn(() => process.stdin) as unknown as typeof process.stdin.pause;

  let currentHandler: ((data: Buffer) => void) | null = null;
  let inputIndex = 0;

  process.stdin.on = vi.fn(((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'data') {
      currentHandler = handler as (data: Buffer) => void;
      if (inputIndex < rawInputs.length) {
        const data = rawInputs[inputIndex]!;
        inputIndex++;
        queueMicrotask(() => {
          if (currentHandler) {
            currentHandler(Buffer.from(data, 'utf-8'));
          }
        });
      }
    }
    return process.stdin;
  }) as typeof process.stdin.on);

  process.stdin.removeListener = vi.fn(((event: string) => {
    if (event === 'data') {
      currentHandler = null;
    }
    return process.stdin;
  }) as typeof process.stdin.removeListener);
}

/**
 * Restore original stdin state after test.
 */
export function restoreStdin(): void {
  if (!saved) return;

  if (saved.isTTY !== undefined) {
    Object.defineProperty(process.stdin, 'isTTY', { value: saved.isTTY, configurable: true });
  }
  if (saved.isRaw !== undefined) {
    Object.defineProperty(process.stdin, 'isRaw', { value: saved.isRaw, configurable: true, writable: true });
  }
  if (saved.setRawMode) process.stdin.setRawMode = saved.setRawMode;
  if (saved.stdoutWrite) process.stdout.write = saved.stdoutWrite;
  if (saved.stdinOn) process.stdin.on = saved.stdinOn;
  if (saved.stdinRemoveListener) process.stdin.removeListener = saved.stdinRemoveListener;
  if (saved.stdinResume) process.stdin.resume = saved.stdinResume;
  if (saved.stdinPause) process.stdin.pause = saved.stdinPause;

  saved = null;
}

/**
 * Convert human-readable inputs to raw stdin data.
 *
 * Strings get a carriage return appended; null becomes EOF (Ctrl+D).
 */
export function toRawInputs(inputs: (string | null)[]): string[] {
  return inputs.map((input) => {
    if (input === null) return '\x04';
    return input + '\r';
  });
}

export interface MockProviderCapture {
  systemPrompts: string[];
  callCount: number;
  prompts: string[];
  sessionIds: Array<string | undefined>;
}

/**
 * Create a mock provider that captures system prompts and returns
 * pre-defined responses. Returns a capture object for assertions.
 */
export function createMockProvider(responses: string[]): { provider: unknown; capture: MockProviderCapture } {
  return createScenarioProvider(responses.map((content) => ({ content })));
}

/** A single AI call scenario with configurable status and error behavior. */
export interface CallScenario {
  content: string;
  status?: 'done' | 'blocked' | 'error';
  sessionId?: string;
  throws?: Error;
}

/**
 * Create a mock provider with per-call scenario control.
 *
 * Each scenario controls what the AI returns for that call index.
 * Captures system prompts, call arguments, and session IDs for assertions.
 */
export function createScenarioProvider(scenarios: CallScenario[]): { provider: unknown; capture: MockProviderCapture } {
  const capture: MockProviderCapture = { systemPrompts: [], callCount: 0, prompts: [], sessionIds: [] };

  const mockCall = vi.fn(async (prompt: string, options?: { sessionId?: string }) => {
    const idx = capture.callCount;
    capture.callCount++;
    capture.prompts.push(prompt);
    capture.sessionIds.push(options?.sessionId);

    const scenario = idx < scenarios.length
      ? scenarios[idx]!
      : { content: 'AI response' };

    if (scenario.throws) {
      throw scenario.throws;
    }

    return {
      persona: 'test',
      status: scenario.status ?? ('done' as const),
      content: scenario.content,
      sessionId: scenario.sessionId,
      timestamp: new Date(),
    };
  });

  const provider = {
    setup: vi.fn(({ systemPrompt }: { systemPrompt: string }) => {
      capture.systemPrompts.push(systemPrompt);
      return { call: mockCall };
    }),
    _call: mockCall,
  };

  return { provider, capture };
}
