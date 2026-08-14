export interface OpenCodeProbeClient {
  session: {
    delete(
      input: { sessionID: string; directory: string },
      options: { throwOnError: true },
    ): Promise<unknown>;
  };
  global: {
    dispose(options: { throwOnError: true }): Promise<unknown>;
  };
}

export interface OpenCodeRunnableProbeClient extends OpenCodeProbeClient {
  session: OpenCodeProbeClient['session'] & {
    create(
      input: { directory: string },
      options: { throwOnError: true },
    ): Promise<{ data: { id: string } }>;
  };
}

export interface OpenCodeSessionEventClient {
  event: {
    subscribe(
      input: { directory: string },
      options: { signal: AbortSignal; throwOnError: true },
    ): Promise<{ stream: AsyncIterable<unknown> }>;
  };
}

export interface OpenCodeProbeServer {
  close?(): void | Promise<void>;
}

export function cleanupOpenCodeClient(input: {
  client: OpenCodeProbeClient | undefined;
  sessionId: string | undefined;
  directory: string;
}): Promise<void>;

export function cleanupOpenCodeProbe(input: {
  client: OpenCodeProbeClient | undefined;
  server: OpenCodeProbeServer | undefined;
  sessionId: string | undefined;
  directory: string;
}): Promise<void>;

export function runOpenCodeProbe<TClient extends OpenCodeRunnableProbeClient, TResult>(input: {
  createProbe(): Promise<{ client: TClient; server?: OpenCodeProbeServer }>;
  directory: string;
  execute(context: { client: TClient; sessionId: string; markReady(): void }): Promise<TResult>;
  onPhase(phase: ProbePhase): void;
}): Promise<TResult>;

export function runOpenCodeSessionWithEvents<TResult>(input: {
  client: OpenCodeSessionEventClient;
  directory: string;
  sessionId: string;
  start(): Promise<TResult> | TResult;
  onReady(): void;
  onEvent(event: unknown): void | Promise<void>;
}): Promise<TResult>;

export function promptOpenCodeSession<TInput, TResult>(
  client: { session: { prompt(input: TInput, options: { throwOnError: true }): Promise<TResult> } },
  input: TInput,
): Promise<TResult>;

export function promptOpenCodeSessionAsync<TInput, TResult>(
  client: { session: { promptAsync(input: TInput, options: { throwOnError: true }): Promise<TResult> } },
  input: TInput,
): Promise<TResult>;

export function summarizeOpenCodeSession<TInput, TResult>(
  client: { session: { summarize(input: TInput, options: { throwOnError: true }): Promise<TResult> } },
  input: TInput,
): Promise<TResult>;

export function listOpenCodeSessionMessages<TInput, TResult>(
  client: { session: { messages(input: TInput, options: { throwOnError: true }): Promise<TResult> } },
  input: TInput,
): Promise<TResult>;
import type { ProbePhase } from './probe-process.mjs';

export const OPENCODE_PROBE_STARTUP_TIMEOUT_MS: 30000;
