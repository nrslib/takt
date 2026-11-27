import { addAbortListener } from 'node:events';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CancelledNotificationSchema, ErrorCode, isJSONRPCRequest, isJSONRPCResultResponse, isJSONRPCErrorResponse,
  type JSONRPCRequest, type RequestId, type MessageExtraInfo,
} from '@modelcontextprotocol/sdk/types.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';

export type RetainResource = (key: string, acquire: () => Promise<() => Promise<void>>) => Promise<void>;
export type PrepareMcpRequests = (requests: readonly JSONRPCRequest[], signal: AbortSignal, retain: RetainResource) => Promise<void>;
export interface McpResponseScope {
  controller: AbortController;
  pending: number;
  terminal: boolean;
  close(): void;
  settle(): void;
}
export interface McpRequestScope {
  run<T>(id: RequestId, action: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
export interface McpResponseOwner {
  current(): McpResponseScope;
  run<T>(signal: AbortSignal, action: (signal: AbortSignal, retain: RetainResource) => Promise<T>): Promise<T>;
}
interface RequestEntry {
  id: RequestId;
  method: string;
  scope: McpResponseScope;
  controller: AbortController;
  started: boolean;
  settled: boolean;
  listener?: ReturnType<typeof addAbortListener>;
}

export class McpSessionRequests implements McpRequestScope {
  private readonly requests = new Map<RequestId, RequestEntry>();
  private readonly batches = new WeakMap<McpResponseScope, Array<{ request: JSONRPCRequest; extra?: MessageExtraInfo }>>();

  constructor(server: McpServer, private readonly owner: McpResponseOwner, private readonly lifetime: AbortSignal,
    private readonly prepare: PrepareMcpRequests) {
    server.server.setNotificationHandler(CancelledNotificationSchema, ({ params }) => {
      const entry = params.requestId === undefined ? undefined : this.requests.get(params.requestId);
      // SDK 標準の取消は応答を省略するため、JSON batch の他の結果まで完了待ちになる。
      if (entry !== undefined && !entry.settled && entry.method !== 'initialize') {
        entry.controller.abort(new Error('MCP request cancelled'));
      }
    });
  }

  attach(transport: Transport): void {
    const forward = transport.onmessage!;
    transport.onmessage = (message, extra) => {
      if (!isJSONRPCRequest(message)) {
        forward(message, extra);
        return;
      }
      const scope = this.owner.current();
      const entry: RequestEntry = {
        id: message.id, method: message.method, scope, controller: new AbortController(), started: false, settled: false,
      };
      scope.pending++;
      this.requests.set(message.id, entry);
      entry.listener = addAbortListener(scope.controller.signal, () => {
        if (!entry.started) {
          this.finish(entry);
          if (this.requests.get(entry.id) === entry) this.requests.delete(entry.id);
        }
      });
      let batch = this.batches.get(scope);
      if (batch === undefined) {
        batch = [];
        this.batches.set(scope, batch);
        const messages = batch;
        // SDK が同期 dispatch する同じ HTTP batch を、handler の開始前に揃える。
        queueMicrotask(() => { void this.dispatch(scope, messages, forward, transport); });
      }
      batch.push({ request: message, extra });
    };
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      const entry = (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && message.id !== undefined
        ? this.requests.get(message.id) : undefined;
      try {
        if (entry?.scope.controller.signal.aborted) return;
        await send(message, options);
      } finally {
        if (entry !== undefined) {
          this.finish(entry);
          if (this.requests.get(entry.id) === entry) this.requests.delete(entry.id);
        }
      }
    };
    const close = transport.onclose;
    transport.onclose = () => {
      for (const entry of [...this.requests.values()]) {
        entry.scope.close();
        if (!entry.started) this.finish(entry);
      }
      this.requests.clear();
      close?.();
    };
  }

  private async dispatch(scope: McpResponseScope, batch: Array<{ request: JSONRPCRequest; extra?: MessageExtraInfo }>,
    forward: NonNullable<Transport['onmessage']>, transport: Transport): Promise<void> {
    try {
      await this.owner.run(this.lifetime, (signal, retain) => this.prepare(batch.map(({ request }) => request), signal, retain));
      if (scope.controller.signal.aborted) return;
      for (const { request, extra } of batch) forward(request, extra);
    } catch (error) {
      if (scope.controller.signal.aborted || this.lifetime.aborted) {
        scope.close();
        return;
      }
      for (const { request } of batch) {
        try {
          await transport.send({ jsonrpc: '2.0', id: request.id, error: {
            code: ErrorCode.InternalError, message: sanitizeSensitiveText(getErrorMessage(error)),
          } });
        } catch { scope.close(); }
      }
    }
  }

  async run<T>(id: RequestId, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const entry = this.requests.get(id);
    if (entry === undefined || entry.settled) throw new Error('An active MCP request is required');
    entry.started = true;
    try {
      return await this.owner.run(this.lifetime, async (scopeSignal) => {
        const signal = AbortSignal.any([scopeSignal, entry.controller.signal]);
        signal.throwIfAborted();
        const value = await action(signal);
        entry.controller.signal.throwIfAborted();
        return value;
      });
    } finally { this.finish(entry); }
  }

  private finish(entry: RequestEntry): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.listener?.[Symbol.dispose]();
    entry.scope.pending--;
    entry.scope.settle();
  }
}
