/**
 * Stdin simulation helpers for testing the readline conversation loop.
 *
 * Feeds pre-defined lines through `process.stdin`'s data events, one at a time,
 * the way a pipe delivers them. `\x04` stands for the end of the input: the
 * stream's `end` is what makes readline report that there is nothing more, and
 * the loop reads that as a cancellation.
 */

import { vi } from 'vitest';
import type { Provider } from '../../infra/providers/index.js';

/** The provider double, plus the call spy the tests assert against. */
export type MockProvider = Provider & { _call: ReturnType<typeof vi.fn> };

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

interface RawStdinOptions {
  continuous?: boolean;
}

interface RawStdinController {
  send(input: string): void;
}

let saved: SavedStdinState | null = null;

/**
 * Set up raw stdin simulation with pre-defined inputs.
 *
 * Each string in rawInputs is delivered as a Buffer via 'data' event
 * when the conversation loop registers a listener.
 */
export function setupRawStdin(rawInputs: string[], options: RawStdinOptions = {}): RawStdinController {
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
  let endHandler: (() => void) | null = null;
  let inputIndex = 0;

  /** `\x04` is the end of the pipe, not a byte the reader should see. */
  const deliver = (data: string): void => {
    if (data === '\x04') {
      endHandler?.();
      return;
    }
    currentHandler?.(Buffer.from(data, 'utf-8'));
  };

  // The overload set of `stdin.on` is far wider than what a simulator needs, so
  // the stub is installed through the property's own type.
  const installListener = (
    stub: (event: string, handler: (...args: unknown[]) => void) => NodeJS.ReadStream,
  ): typeof process.stdin.on => stub as unknown as typeof process.stdin.on;

  process.stdin.on = installListener(((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'end') {
      endHandler = handler as () => void;
    }
    if (event === 'data') {
      currentHandler = handler as (data: Buffer) => void;
      if (!options.continuous) {
        if (inputIndex < rawInputs.length) {
          const data = rawInputs[inputIndex]!;
          inputIndex++;
          queueMicrotask(() => {
            deliver(data);
          });
        }
        return process.stdin;
      }
      const deliverNextInput = (): void => {
        if (!currentHandler || inputIndex >= rawInputs.length) return;
        const data = rawInputs[inputIndex]!;
        inputIndex++;
        deliver(data);
        queueMicrotask(deliverNextInput);
      };
      queueMicrotask(deliverNextInput);
    }
    return process.stdin;
  }));

  process.stdin.removeListener = installListener(((event: string) => {
    if (event === 'data') {
      currentHandler = null;
    }
    if (event === 'end') {
      endHandler = null;
    }
    return process.stdin;
  })) as typeof process.stdin.removeListener;

  return {
    send(input: string): void {
      if (!currentHandler) {
        throw new Error('Stdin data listener is not registered.');
      }
      deliver(input);
    },
  };
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
  providerOptions: unknown[];
  allowedTools: Array<string[] | undefined>;
  permissionModes: Array<string | undefined>;
  imageAttachments: Array<Array<{ placeholder: string; path: string }> | undefined>;
}

/**
 * Create a mock provider that captures system prompts and returns
 * pre-defined responses. Returns a capture object for assertions.
 */
export function createMockProvider(responses: string[]): { provider: MockProvider; capture: MockProviderCapture } {
  return createScenarioProvider(responses.map((content) => ({ content })));
}

/** A single AI call scenario with configurable status and error behavior. */
export interface CallScenario {
  content: string;
  status?: 'done' | 'blocked' | 'error';
  sessionId?: string;
  throws?: Error;
}

interface ScenarioProviderOptions {
  supportsNativeImageInput?: boolean;
  runtimeInstructions?: string | null;
}

/**
 * Create a mock provider with per-call scenario control.
 *
 * Each scenario controls what the AI returns for that call index.
 * Captures system prompts, call arguments, and session IDs for assertions.
 */
export function createScenarioProvider(
  scenarios: CallScenario[],
  options: ScenarioProviderOptions = {},
): { provider: MockProvider; capture: MockProviderCapture } {
  const capture: MockProviderCapture = {
    systemPrompts: [],
    callCount: 0,
    prompts: [],
    sessionIds: [],
    providerOptions: [],
    allowedTools: [],
    permissionModes: [],
    imageAttachments: [],
  };

  const mockCall = vi.fn(async (prompt: string, options?: {
    sessionId?: string;
    providerOptions?: unknown;
    allowedTools?: string[];
    permissionMode?: string;
    imageAttachments?: Array<{ placeholder: string; path: string }>;
  }) => {
    const idx = capture.callCount;
    capture.callCount++;
    capture.prompts.push(prompt);
    capture.sessionIds.push(options?.sessionId);
    capture.providerOptions.push(options?.providerOptions);
    capture.allowedTools.push(options?.allowedTools);
    capture.permissionModes.push(options?.permissionMode);
    capture.imageAttachments.push(options?.imageAttachments);

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
    supportsStructuredOutput: true,
    supportsNativeImageInput: options.supportsNativeImageInput === true,
    getRuntimeInstructions: vi.fn(() => options.runtimeInstructions ?? null),
    setup: vi.fn(({ systemPrompt }: { systemPrompt: string }) => {
      capture.systemPrompts.push(systemPrompt);
      return { call: mockCall };
    }),
    _call: mockCall,
  };

  // The double answers only what these tests exercise; the rest of the provider
  // surface is never reached.
  return { provider: provider as unknown as MockProvider, capture };
}
