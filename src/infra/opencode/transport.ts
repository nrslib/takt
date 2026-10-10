import type { OpencodeClient as V1Client } from '@opencode-ai/sdk/v2';

type RequestOptions = { signal?: AbortSignal };
type SessionRequest = { sessionID: string; directory: string };
type Result<T> = { data?: T; error?: unknown };

export interface OpenCodeSdkState {
  readonly directory: string;
  readonly stale: boolean;
}

export interface ManagedOpenCodeTransport extends OpenCodeTransport {
  readonly sdkState: OpenCodeSdkState;
}

export interface OpenCodeResolvedModel {
  providerID: string;
  modelID: string;
  variant?: string;
}

export interface OpenCodeMessage {
  info: { id: string; role: string; error?: unknown; summary?: unknown; time: { created: number; completed?: number } };
  parts: Array<{ type: string; [key: string]: unknown }>;
}

/** The operations used by TAKT's attempt and compaction runners. */
export interface OpenCodeTransport {
  nativeStructuredOutput?: boolean;
  requiresExplicitMcpTools?: boolean;
  resolveModel?(input: { directory: string; sessionID?: string; agent?: string }, options?: RequestOptions): Promise<OpenCodeResolvedModel>;
  session: {
    create(input: NonNullable<Parameters<V1Client['session']['create']>[0]>, options?: RequestOptions): Promise<Result<{ id: string }>>;
    get(input: SessionRequest, options?: RequestOptions): Promise<Result<{ id: string }>>;
    messages(input: SessionRequest, options?: RequestOptions): Promise<Result<OpenCodeMessage[]>>;
    promptAsync(input: Parameters<V1Client['session']['promptAsync']>[0] & { allowConfiguredMcpTools?: boolean }, options?: RequestOptions): Promise<unknown>;
    abort(input: SessionRequest, options: RequestOptions): Promise<Result<boolean>>;
    summarize(input: Parameters<V1Client['session']['summarize']>[0], options?: RequestOptions): Promise<unknown>;
  };
  event: {
    subscribe(input: { directory: string; sessionID: string }, options: RequestOptions): Promise<{ stream: AsyncIterable<unknown> }>;
  };
  permission: {
    reply(input: { sessionID: string; requestID: string; directory: string; reply: 'once' | 'always' | 'reject' }, options: RequestOptions): Promise<unknown>;
  };
  question: {
    reply(input: { requestID: string; directory: string; answers: string[][] }, options: RequestOptions): Promise<unknown>;
    reject(input: { requestID: string; directory: string }, options: RequestOptions): Promise<unknown>;
  };
}
