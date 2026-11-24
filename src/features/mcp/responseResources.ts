import { AsyncLocalStorage } from 'node:async_hooks';
import { addAbortListener } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpSessionRequests, type McpRequestScope, type McpResponseScope, type PrepareMcpRequests, type RetainResource } from './requestResources.js';

export interface McpResponseResources {
  bind(server: McpServer, lifetime: AbortSignal, prepare: PrepareMcpRequests): McpRequestScope;
}

interface ResponseScope extends McpResponseScope {
  releases: Array<() => Promise<void>>;
  acquisitions: Map<string, Promise<void>>;
  listeners: Array<ReturnType<typeof addAbortListener>>;
  done: Promise<void>;
}

export class HttpResponseResources implements McpResponseResources {
  private readonly storage = new AsyncLocalStorage<ResponseScope>();
  private readonly scopes = new Set<ResponseScope>();
  private readonly failures: unknown[] = [];
  private readonly sessions = new WeakMap<McpServer, McpSessionRequests>();

  bind(server: McpServer, lifetime: AbortSignal, prepare: PrepareMcpRequests): McpRequestScope {
    const requests = new McpSessionRequests(server, {
      current: () => {
        const scope = this.storage.getStore();
        if (scope === undefined || scope.terminal) throw new Error('An active HTTP response is required');
        return scope;
      },
      run: (signal, action) => this.run(signal, action),
    }, lifetime, prepare);
    this.sessions.set(server, requests);
    return requests;
  }

  attach(server: McpServer, transport: Transport): void { this.sessions.get(server)?.attach(transport); }

  async handle<T>(response: ServerResponse, action: () => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let complete!: () => void;
    let releasing = false;
    const scope: ResponseScope = {
      controller, pending: 0, terminal: false, releases: [], acquisitions: new Map(), listeners: [],
      done: new Promise<void>((resolve) => { complete = resolve; }),
      close: () => { controller.abort(); response.destroy(); },
      settle: () => {
        if (!scope.terminal || scope.pending !== 0 || releasing) return;
        releasing = true;
        for (const listener of scope.listeners) listener[Symbol.dispose]();
        void (async () => {
          for (const release of scope.releases.reverse()) {
            try { await release(); } catch (error) { this.failures.push(error); }
          }
          response.off('finish', finish); response.off('close', close); response.off('error', close);
          this.scopes.delete(scope); complete();
        })();
      },
    };
    const finish = () => { scope.terminal = true; scope.settle(); };
    const close = () => { if (!response.writableFinished) controller.abort(); scope.terminal = true; scope.settle(); };
    response.once('finish', finish); response.once('close', close); response.once('error', close);
    this.scopes.add(scope);
    try { return await this.storage.run(scope, action); }
    finally { scope.settle(); }
  }

  async run<T>(signal: AbortSignal, action: (signal: AbortSignal, retain: RetainResource) => Promise<T>): Promise<T> {
    const scope = this.storage.getStore();
    if (scope === undefined || scope.terminal) throw new Error('An active HTTP response is required');
    const combined = AbortSignal.any([signal, scope.controller.signal]);
    scope.pending++;
    scope.listeners.push(addAbortListener(combined, scope.close));
    try {
      combined.throwIfAborted();
      return await action(combined, async (key, acquire) => {
        let acquisition = scope.acquisitions.get(key);
        if (acquisition === undefined) {
          acquisition = Promise.resolve().then(acquire).then((release) => { scope.releases.push(release); }, (error: unknown) => {
            scope.acquisitions.delete(key);
            throw error;
          });
          scope.acquisitions.set(key, acquisition);
        }
        await acquisition;
      });
    } finally { scope.pending--; scope.settle(); }
  }

  async close(): Promise<void> {
    const pending = [...this.scopes];
    for (const scope of pending) scope.close();
    await Promise.all(pending.map((scope) => scope.done));
    if (this.failures.length > 0) throw new AggregateError([...this.failures], 'HTTP response resource cleanup failed');
  }
}
