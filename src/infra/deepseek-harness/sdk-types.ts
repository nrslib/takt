import type { Branded } from '#deepseek-brand';

export type ReasoningEffortId = Branded<'ReasoningEffortId'>;

export interface HarnessNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface DeepSeekHarnessRunResult {
  sessionId: string;
  finalResponse: string;
}

export interface DeepSeekHarnessRunOptions {
  sessionId?: string;
  onNotification?: (notification: HarnessNotification) => void;
}

export interface DeepSeekHarness {
  start(): Promise<void>;
  run(input: string, options?: DeepSeekHarnessRunOptions): Promise<DeepSeekHarnessRunResult>;
  close(): Promise<void>;
}

export interface DeepSeekHarnessOptions {
  dshBin?: string;
  profile?: string;
  patches?: string[];
  dshHome?: string;
  processCwd?: string;
  env?: NodeJS.ProcessEnv;
  initializeTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  disposeEofGraceMs?: number;
  disposeGraceMs?: number;
  cwd?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: ReasoningEffortId;
  maxTokens?: number;
}

export interface JsonRpcResponseError extends Error {
  readonly code: number | undefined;
  readonly data?: unknown;
}

export interface ManagedDeepSeekSdk {
  DeepSeekHarness: new (options?: DeepSeekHarnessOptions) => DeepSeekHarness;
  RequestTimeoutError: new (message: string) => Error;
  JsonRpcResponseError: new (code: number | undefined, message: string, data?: unknown) => JsonRpcResponseError;
  SdkProtocolError: new (message: string) => Error;
  TransportClosedError: new (message: string) => Error;
}

export interface ManagedDeepSeekLlm {
  ReasoningEffortId(id: string): ReasoningEffortId;
}
