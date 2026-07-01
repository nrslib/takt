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
  type NewSessionRequest,
  type Stream,
} from '@agentclientprotocol/sdk';
import { z } from 'zod/v4';
import {
  createTaktAcpAgent,
  mapTaktAcpUpdateToSessionUpdate,
  type AcpDefaultAction,
  type AcpTaskContext,
  type TaktAcpAgentDependencies,
} from './agent.js';
import { isValidAcpBranchName } from './taskContext.js';
import { createLogger } from '../../shared/utils/debug.js';

const log = createLogger('acp');

type StreamSessionNewRequest = Omit<NewSessionRequest, 'mcpServers'> & {
  mcpServers?: NewSessionRequest['mcpServers'];
  defaultAction?: AcpDefaultAction;
  taskContext?: AcpTaskContext;
};

const acpMetadataSchema = z.record(z.string(), z.unknown()).nullish();

const acpHttpHeaderSchema = z.object({
  name: z.string(),
  value: z.string(),
  _meta: acpMetadataSchema,
});

const acpMcpServerSchema = z.union([
  z.object({
    type: z.literal('http'),
    name: z.string(),
    url: z.string(),
    headers: z.array(acpHttpHeaderSchema),
    _meta: acpMetadataSchema,
  }),
  z.object({
    type: z.literal('sse'),
    name: z.string(),
    url: z.string(),
    headers: z.array(acpHttpHeaderSchema),
    _meta: acpMetadataSchema,
  }),
  z.object({
    type: z.literal('acp'),
    name: z.string(),
    id: z.string(),
    _meta: acpMetadataSchema,
  }),
  z.object({
    name: z.string(),
    command: z.string(),
    args: z.array(z.string()),
    env: z.array(z.object({
      name: z.string(),
      value: z.string(),
      _meta: acpMetadataSchema,
    })),
    _meta: acpMetadataSchema,
  }),
]);

const acpBranchSchema = z.string().min(1).refine(isValidAcpBranchName, {
  message: 'branch must be a valid ACP branch name',
});

const acpTaskContextSchema = z.object({
  branch: acpBranchSchema.optional(),
  baseBranch: acpBranchSchema.optional(),
  prNumber: z.number().int().positive().optional(),
}).strict().optional();

const streamSessionNewRequestParser = {
  parse(params: unknown): StreamSessionNewRequest {
    const request = z.object({
      cwd: z.string(),
      additionalDirectories: z.array(z.string()).optional(),
      defaultAction: z.enum(['enqueue', 'direct']).optional(),
      taskContext: acpTaskContextSchema,
      mcpServers: z.array(acpMcpServerSchema).optional(),
      _meta: acpMetadataSchema,
    }).parse(params);
    return {
      ...request,
      mcpServers: request.mcpServers ?? [],
    };
  },
};

export function createTaktAcpAgentApp(deps: TaktAcpAgentDependencies = {}): AgentApp {
  let clientContext: AgentContext | undefined;

  const taktAgent = createTaktAcpAgent({
    ...deps,
    sendSessionUpdate: async (sessionId, update) => {
      try {
        await deps.sendSessionUpdate?.(sessionId, update);
      } catch (error) {
        log.warn('ACP session update hook failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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
    .onRequest(methods.agent.session.new, streamSessionNewRequestParser, ({ params }) =>
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
