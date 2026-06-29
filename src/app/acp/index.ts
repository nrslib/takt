#!/usr/bin/env node

import { Readable, Writable } from 'node:stream';
import type { ReadableStream, WritableStream } from 'node:stream/web';
import { pathToFileURL } from 'node:url';
import {
  agent,
  methods,
  ndJsonStream,
  type AgentContext,
  type AgentApp,
  type Stream,
} from '@agentclientprotocol/sdk';
import {
  createTaktAcpAgent,
  mapTaktAcpUpdateToSessionUpdate,
  type TaktAcpAgentDependencies,
} from './agent.js';

export function createTaktAcpAgentApp(deps: TaktAcpAgentDependencies = {}): AgentApp {
  let clientContext: AgentContext | undefined;

  const taktAgent = createTaktAcpAgent({
    ...deps,
    sendSessionUpdate: async (sessionId, update) => {
      await deps.sendSessionUpdate?.(sessionId, update);
      if (!clientContext) {
        return;
      }
      await clientContext.notify(methods.client.session.update, {
        sessionId,
        update: mapTaktAcpUpdateToSessionUpdate(update),
      });
    },
    createElicitation: async (request) => {
      if (!clientContext) {
        throw new Error('ACP client is not connected');
      }
      return clientContext.request(methods.client.elicitation.create, request);
    },
  });

  return agent({ name: 'TAKT' })
    .onConnect((connection) => {
      clientContext = connection.client;
    })
    .onRequest(methods.agent.initialize, ({ params }) =>
      taktAgent.handleInitialize(params))
    .onRequest(methods.agent.session.new, ({ params }) =>
      taktAgent.handleSessionNew(params))
    .onRequest(methods.agent.session.prompt, ({ params }) =>
      taktAgent.handleSessionPrompt(params))
    .onNotification(methods.agent.session.cancel, ({ params }) =>
      taktAgent.handleSessionCancel(params));
}

export function connectTaktAcpAgent(stream: Stream): void {
  createTaktAcpAgentApp().connect(stream);
}

export function connectTaktAcpAgentToStdio(): void {
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  connectTaktAcpAgent(ndJsonStream(
    output as unknown as globalThis.WritableStream<Uint8Array>,
    input as unknown as globalThis.ReadableStream<Uint8Array>,
  ));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  connectTaktAcpAgentToStdio();
}
