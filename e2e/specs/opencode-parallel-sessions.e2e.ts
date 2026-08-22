import { accessSync, constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve as resolvePath } from 'node:path';
import { createOpencode, type Event as OpenCodeEvent } from '@opencode-ai/sdk/v2';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse } from '../../src/core/models/response.js';

const { createOpencodeMock } = vi.hoisted(() => ({
  createOpencodeMock: vi.fn(),
}));

vi.mock('@opencode-ai/sdk/v2', async () => {
  const actual = await vi.importActual<{ createOpencode: typeof createOpencode }>('@opencode-ai/sdk/v2');
  const realCreateOpencode = actual.createOpencode;
  createOpencodeMock.mockImplementation((...args: unknown[]) => {
    return (realCreateOpencode as (...a: unknown[]) => unknown)(...args);
  });
  return {
    ...actual,
    createOpencode: createOpencodeMock,
  };
});

const INTEGRATION_ENV = 'TAKT_OPENCODE_PARALLEL_INTEGRATION';
const SERVER_START_TIMEOUT = 60_000;
const SESSION_TIMEOUT = 240_000;

const DUMMY_API_KEY = 'takt-test-dummy-api-key';
const MODEL = { providerID: 'opencode', modelID: 'deepseek-v4-flash-free' } as const;
const RESPONSE_MODEL = 'opencode/deepseek-v4-flash-free';

type RequestRecord = {
  body: string;
  time: number;
  marker: string;
  authHeader: string | undefined;
  model: string;
  url: string;
  stream: boolean;
};

type Gate = {
  resolve: () => void;
  promise: Promise<void>;
};

const isEnabled = process.env[INTEGRATION_ENV] === '1';
const opencodePath = resolveExecutableOnPath('opencode');

if (!isEnabled) {
  console.log(`[opencode-parallel] skip: set ${INTEGRATION_ENV}=1 to enable`);
} else if (opencodePath === null) {
  console.log('[opencode-parallel] skip: opencode CLI not found on PATH');
}

function resolveExecutableOnPath(command: string): string | null {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return null;
  }

  for (const entry of pathValue.split(':')) {
    if (!entry) {
      continue;
    }

    const candidate = resolvePath(entry, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep searching PATH
    }
  }

  return null;
}

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timeout running ${command} ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Command failed with code ${code}: ${stderr.trim() || stdout.trim() || command}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractSessionID(event: OpenCodeEvent): string | undefined {
  if (!isRecord(event.properties)) {
    return undefined;
  }

  return typeof event.properties.sessionID === 'string' ? event.properties.sessionID : undefined;
}

function getEventTextFragments(event: OpenCodeEvent): string[] {
  if (!isRecord(event.properties)) {
    return [];
  }

  if (event.type === 'message.part.updated') {
    const part = event.properties.part;
    if (isRecord(part) && typeof part.text === 'string') {
      return [part.text];
    }
    return [];
  }

  if (event.type === 'message.part.delta' && typeof event.properties.delta === 'string') {
    return [event.properties.delta];
  }

  if (event.type === 'session.status') {
    const status = event.properties.status;
    if (isRecord(status) && typeof status.message === 'string') {
      return [status.message];
    }
  }

  return [];
}

function hasSessionIdle(events: OpenCodeEvent[], sessionID: string): boolean {
  return events.some((event) => event.type === 'session.idle' && extractSessionID(event) === sessionID);
}

function describeRecentEvents(events: OpenCodeEvent[]): string {
  return events
    .map((event) => {
      if (event.type === 'message.part.updated') {
        const part = isRecord(event.properties.part) ? event.properties.part : {};
        return `message.part.updated:${extractSessionID(event)}:part=${JSON.stringify(part)}`;
      }
      if (event.type === 'message.part.delta') {
        return `message.part.delta:${extractSessionID(event)}:delta=${JSON.stringify(event.properties.delta)}`;
      }
      if (event.type === 'session.status') {
        const status = isRecord(event.properties.status) ? event.properties.status : {};
        return `session.status:${extractSessionID(event)}:status=${JSON.stringify(status)}`;
      }
      if (event.type === 'session.idle') {
        return `session.idle:${extractSessionID(event)}`;
      }
      return event.type;
    })
    .join(', ');
}

function describeRawEvents(events: unknown[]): string {
  return events
    .map((event) => {
      if (!isRecord(event)) {
        return 'non-record';
      }
      return typeof event.type === 'string' ? event.type : 'unknown';
    })
    .join(', ');
}

function describeRequests(requests: RequestRecord[]): string {
  return requests
    .map((request) => `${request.marker}:${request.model}:${request.url}:stream=${request.stream}`)
    .join(', ');
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
  failureMessage: string,
  describeState?: () => string,
): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(describeState === undefined ? failureMessage : `${failureMessage}; ${describeState()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForPromiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  failureMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(failureMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function assertSessionEventIsolation(events: OpenCodeEvent[], ownMarker: string, foreignMarker: string): void {
  const fragments = events.flatMap((event) => getEventTextFragments(event));

  expect(fragments.length).toBeGreaterThan(0);
  expect(fragments.some((fragment) => fragment.includes(ownMarker))).toBe(true);
  expect(fragments.some((fragment) => fragment.includes(foreignMarker))).toBe(false);
}

function assertNoForeignMarker(events: OpenCodeEvent[], foreignMarker: string): void {
  const fragments = events.flatMap((event) => getEventTextFragments(event));

  expect(fragments.some((fragment) => fragment.includes(foreignMarker))).toBe(false);
}

function extractMarker(body: string): string {
  const match = body.match(/\b(SESSION-[A-Z0-9-]+|TAKT-[A-Z0-9-]+)\b/);
  return match ? match[1] : 'unknown';
}

function extractModel(body: string): string {
  try {
    const parsed = JSON.parse(body) as { model?: unknown };
    if (typeof parsed.model === 'string') {
      return parsed.model;
    }
    if (isRecord(parsed.model)) {
      const providerID = typeof parsed.model.providerID === 'string' ? parsed.model.providerID : undefined;
      const modelID = typeof parsed.model.modelID === 'string'
        ? parsed.model.modelID
        : (typeof parsed.model.id === 'string' ? parsed.model.id : undefined);
      if (providerID && modelID) {
        return `${providerID}/${modelID}`;
      }
      if (modelID) {
        return modelID;
      }
    }
    return '';
  } catch {
    return '';
  }
}

function isStreamRequest(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { stream?: unknown };
    return parsed.stream === true;
  } catch {
    return false;
  }
}

class DummyUpstream {
  readonly server: ReturnType<typeof createServer>;
  readonly requests: RequestRecord[] = [];
  private readonly gates = new Map<string, Gate>();
  private readonly bodyGates = new Map<string, Gate>();
  private nextRequestIndex = 0;
  private pending_ = 0;
  private destroyed_ = 0;
  private responsesStarted_ = 0;
  private port_ = 0;

  constructor() {
    this.server = createServer({ keepAliveTimeout: 5000 }, (req, res) => this.handleRequest(req, res));
  }

  get port(): number {
    return this.port_;
  }

  activateGate(marker: string): void {
    if (this.gates.has(marker)) {
      throw new Error(`Gate already exists: ${marker}`);
    }

    let resolveFn: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    this.gates.set(marker, { resolve: resolveFn, promise });
  }

  releaseGate(marker: string): void {
    const gate = this.gates.get(marker);
    if (!gate) {
      throw new Error(`Gate not found: ${marker}`);
    }

    gate.resolve();
    this.gates.delete(marker);
  }

  releaseAllGates(): void {
    for (const marker of [...this.gates.keys()]) {
      this.releaseGate(marker);
    }
    for (const text of [...this.bodyGates.keys()]) {
      this.releaseBodyGate(text);
    }
  }

  activateBodyGate(text: string): void {
    if (this.bodyGates.has(text)) {
      throw new Error(`Body gate already exists: ${text}`);
    }

    let resolveFn: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    this.bodyGates.set(text, { resolve: resolveFn, promise });
  }

  releaseBodyGate(text: string): void {
    const gate = this.bodyGates.get(text);
    if (!gate) {
      throw new Error(`Body gate not found: ${text}`);
    }

    gate.resolve();
    this.bodyGates.delete(text);
  }

  waitForBodyMatch(text: string, timeoutMs = 30_000): Promise<number> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const check = (): void => {
        const idx = this.requests.findIndex((r) => r.body.includes(text));
        if (idx !== -1) {
          resolve(idx);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for request body containing "${text}"; seen=${this.requests.length}`));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  hasBodyContaining(text: string): boolean {
    return this.requests.some((r) => r.body.includes(text));
  }

  pendingRequests(): number {
    return this.pending_;
  }

  destroyedRequests(): number {
    return this.destroyed_;
  }

  responsesStarted(): number {
    return this.responsesStarted_;
  }

  clearRequests(): void {
    this.requests.length = 0;
    this.pending_ = 0;
    this.responsesStarted_ = 0;
    this.destroyed_ = 0;
  }

  async start(): Promise<number> {
    return await new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        this.port_ = addr && typeof addr === 'object' ? addr.port : 0;
        resolve(this.port_);
      });
    });
  }

  async close(): Promise<void> {
    this.releaseAllGates();
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  waitForRequests(count: number, timeoutMs = 30_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const check = (): void => {
        if (this.requests.length >= count) {
          resolve();
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${count} request(s); seen=${this.requests.length}`));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  waitForMarkerRequest(marker: string, timeoutMs = 30_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const check = (): void => {
        if (this.requests.some((r) => r.marker === marker)) {
          resolve();
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          const markers = this.requests.map((r) => r.marker).join(', ');
          reject(new Error(`Timed out waiting for marker "${marker}"; seen markers=[${markers}]`));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  getMarkerRequest(marker: string): RequestRecord | undefined {
    return this.requests.find((r) => r.marker === marker);
  }

  assertNoMarkerRequest(marker: string): void {
    const found = this.requests.find((r) => r.marker === marker);
    if (found !== undefined) {
      throw new Error(`Expected no request with marker "${marker}" but found one at index ${this.requests.indexOf(found)}`);
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';
    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;

    if (method === 'POST' && (url.includes('/chat/completions') || url.includes('/v1/chat/completions'))) {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        const idx = this.nextRequestIndex++;
        const marker = extractMarker(body);
        const model = extractModel(body);
        const stream = isStreamRequest(body);
        const responseModel = model || RESPONSE_MODEL;
        this.requests.push({
          body,
          time: Date.now(),
          marker,
          authHeader,
          model,
          url,
          stream,
        });
        this.pending_++;

        let finished = false;
        let destroyedCounted = false;
        const markFinished = (): void => {
          if (finished) {
            return;
          }
          finished = true;
          this.pending_--;
        };
        const markAborted = (): void => {
          if (destroyedCounted) {
            return;
          }
          destroyedCounted = true;
          if (!finished) {
            this.destroyed_++;
          }
          markFinished();
        };

        req.on('aborted', markAborted);
        res.on('close', markAborted);

        const sendResponse = (): void => {
          if (finished) {
            return;
          }

          const rid = `cmpl-${Date.now()}-${idx}`;
          const created = Math.floor(Date.now() / 1000);
          const assistantText = `Response-from-session-${marker}-${idx}`;

          this.responsesStarted_++;

          if (stream) {
            const streamChunk = (chunk: unknown): void => {
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            };

            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });
            streamChunk({
              id: rid,
              object: 'chat.completion.chunk',
              created,
              model: responseModel,
              choices: [{
                index: 0,
                delta: { role: 'assistant' },
                finish_reason: null,
              }],
            });
            streamChunk({
              id: rid,
              object: 'chat.completion.chunk',
              created,
              model: responseModel,
              choices: [{
                index: 0,
                delta: { content: assistantText },
                finish_reason: null,
              }],
            });
            streamChunk({
              id: rid,
              object: 'chat.completion.chunk',
              created,
              model: responseModel,
              choices: [{
                index: 0,
                finish_reason: 'stop',
              }],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            });
            res.write('data: [DONE]\n\n');
            res.end();
            markFinished();
            return;
          }

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
            Connection: 'close',
          });
          res.end(JSON.stringify({
            id: rid,
            object: 'chat.completion',
            created,
            model: responseModel,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: assistantText,
              },
              finish_reason: 'stop',
            }],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
            },
          }));
          markFinished();
        };

        const markerGate = this.gates.get(marker);
        if (markerGate) {
          void markerGate.promise.then(sendResponse);
        } else {
          const bodyGate = [...this.bodyGates.entries()].find(([text]) => body.includes(text));
          if (bodyGate) {
            void bodyGate[1].promise.then(sendResponse);
          } else {
            sendResponse();
          }
        }
      });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to get free port')));
        return;
      }

      const port = addr.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

const shouldSkip = !isEnabled || opencodePath === null;

describe.skipIf(shouldSkip)('OpenCode parallel sessions', () => {
  let upstream: DummyUpstream | undefined;
  let ocClient: Awaited<ReturnType<typeof createOpencode>>['client'] | undefined;
  let ocServer: { close: () => void } | undefined;
  let eventCollectPromise: Promise<void> | undefined;
  let eventSubscriptionAbortController: AbortController | undefined;
  const allEvents: OpenCodeEvent[] = [];
  const rawEvents: unknown[] = [];

  beforeAll(async () => {
    if (opencodePath === null) {
      throw new Error('opencode CLI not found on PATH');
    }

    const version = await runCommand(opencodePath, ['--version'], 5_000);
    console.log(`[opencode-parallel] resolved: ${opencodePath}`);
    console.log(`[opencode-parallel] version: ${version}`);

    upstream = new DummyUpstream();
    await upstream.start();

    const opencodePort = await getFreePort();
    const { client, server } = await createOpencode({
      port: opencodePort,
      timeout: SERVER_START_TIMEOUT,
      config: {
        model: RESPONSE_MODEL,
        small_model: RESPONSE_MODEL,
        provider: {
          opencode: {
            options: {
              baseURL: `http://127.0.0.1:${upstream.port}`,
              apiKey: DUMMY_API_KEY,
            },
          },
        },
      },
    });
    ocClient = client;
    ocServer = server;

    eventSubscriptionAbortController = new AbortController();
    const { stream } = await client.event.subscribe(
      { directory: process.cwd() },
      { signal: eventSubscriptionAbortController.signal },
    );
    eventCollectPromise = (async () => {
      for await (const event of stream) {
        rawEvents.push(event);
        allEvents.push(event);
      }
    })();
  }, SERVER_START_TIMEOUT + 10_000);

  afterAll(async () => {
    const cleanupErrors: string[] = [];
    const runCleanup = async (label: string, action: () => void | Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    if (upstream) {
      await runCleanup('release gates', () => upstream.releaseAllGates());
    }
    if (eventSubscriptionAbortController) {
      await runCleanup('abort event subscription', () => {
        eventSubscriptionAbortController.abort();
      });
    }
    if (ocClient) {
      await runCleanup('dispose client', () => ocClient.global.dispose());
    }
    if (ocServer) {
      await runCleanup('close server', () => {
        ocServer.close();
      });
    }
    if (upstream) {
      await runCleanup('close upstream', () => upstream.close());
    }
    if (eventCollectPromise) {
      await runCleanup('stop event subscription', () => waitForPromiseWithTimeout(
        eventCollectPromise,
        10_000,
        'event subscription did not stop during cleanup',
      ));
    }

    if (cleanupErrors.length > 0) {
      throw new Error(`Cleanup had ${cleanupErrors.length} failure(s): ${cleanupErrors.join('; ')}`);
    }
  }, 30_000);

  it('should run two parallel sessions with isolation', async () => {
    if (!ocClient || !upstream) {
      throw new Error('setup failed');
    }

    const dir = process.cwd();
    const baseEventIndex = allEvents.length;

    upstream.clearRequests();
    upstream.activateGate('SESSION-MARKER-A');
    upstream.activateGate('SESSION-MARKER-B');

    const [sessionA, sessionB] = await Promise.all([
      ocClient.session.create({ directory: dir, title: 'Session-A' }),
      ocClient.session.create({ directory: dir, title: 'Session-B' }),
    ]);
    const sessionAId = sessionA.data?.id;
    const sessionBId = sessionB.data?.id;
    if (!sessionAId || !sessionBId) {
      throw new Error('session creation failed');
    }

    const promptA = ocClient.session.promptAsync({
      sessionID: sessionAId,
      directory: dir,
      model: MODEL,
      parts: [{ type: 'text' as const, text: 'SESSION-MARKER-A tell me about apples' }],
    });
    const promptB = ocClient.session.promptAsync({
      sessionID: sessionBId,
      directory: dir,
      model: MODEL,
      parts: [{ type: 'text' as const, text: 'SESSION-MARKER-B tell me about oranges' }],
    });

    await upstream.waitForRequests(2, 60_000);
    expect(upstream.pendingRequests()).toBe(2);
    expect(upstream.responsesStarted()).toBe(0);

    const requestA = upstream.requests.find((request) => request.marker === 'SESSION-MARKER-A');
    const requestB = upstream.requests.find((request) => request.marker === 'SESSION-MARKER-B');
    if (!requestA || !requestB) {
      throw new Error('expected both session requests to reach the upstream');
    }

    expect(requestA.model).toBe(requestB.model);
    expect(requestA.model).not.toBe('');
    expect(requestA.authHeader).toBe(`Bearer ${DUMMY_API_KEY}`);
    expect(requestB.authHeader).toBe(`Bearer ${DUMMY_API_KEY}`);
    expect(requestA.url).toContain('chat/completions');
    expect(requestB.url).toContain('chat/completions');

    upstream.releaseGate('SESSION-MARKER-A');
    upstream.releaseGate('SESSION-MARKER-B');

    await Promise.all([promptA, promptB]);

    await Promise.all([
      waitForCondition(
        () => hasSessionIdle(allEvents.slice(baseEventIndex), sessionAId),
        SESSION_TIMEOUT,
        'timed out waiting for session A to finish',
        () => `collected=[${describeRecentEvents(allEvents.slice(baseEventIndex))}] raw=[${describeRawEvents(rawEvents.slice(baseEventIndex))}] requests=[${describeRequests(upstream.requests)}]`,
      ),
      waitForCondition(
        () => hasSessionIdle(allEvents.slice(baseEventIndex), sessionBId),
        SESSION_TIMEOUT,
        'timed out waiting for session B to finish',
        () => `collected=[${describeRecentEvents(allEvents.slice(baseEventIndex))}] raw=[${describeRawEvents(rawEvents.slice(baseEventIndex))}] requests=[${describeRequests(upstream.requests)}]`,
      ),
    ]);
    const testEvents = allEvents.slice(baseEventIndex);
    const sessionAEvents = testEvents.filter((event) => extractSessionID(event) === sessionAId);
    const sessionBEvents = testEvents.filter((event) => extractSessionID(event) === sessionBId);
    assertSessionEventIsolation(sessionAEvents, 'SESSION-MARKER-A', 'SESSION-MARKER-B');
    assertSessionEventIsolation(sessionBEvents, 'SESSION-MARKER-B', 'SESSION-MARKER-A');
    expect(hasSessionIdle(testEvents, sessionAId)).toBe(true);
    expect(hasSessionIdle(testEvents, sessionBId)).toBe(true);
    expect(upstream.pendingRequests()).toBe(0);
  }, SESSION_TIMEOUT * 3);

  it('should abort target session and let survivor complete', async () => {
    if (!ocClient || !upstream) {
      throw new Error('setup failed');
    }

    const dir = process.cwd();
    const baseEventIndex = allEvents.length;

    upstream.clearRequests();
    upstream.activateGate('SESSION-ABORT-TARGET');
    upstream.activateGate('SESSION-SURVIVOR');

    const [abortSession, survivorSession] = await Promise.all([
      ocClient.session.create({ directory: dir, title: 'Abort-Target' }),
      ocClient.session.create({ directory: dir, title: 'Survivor' }),
    ]);
    const abortId = abortSession.data?.id;
    const survivorId = survivorSession.data?.id;
    if (!abortId || !survivorId) {
      throw new Error('abort test session creation failed');
    }

    const abortPrompt = ocClient.session.promptAsync({
      sessionID: abortId,
      directory: dir,
      model: MODEL,
      parts: [{ type: 'text' as const, text: 'SESSION-ABORT-TARGET will be aborted' }],
    });
    const survivorPrompt = ocClient.session.promptAsync({
      sessionID: survivorId,
      directory: dir,
      model: MODEL,
      parts: [{ type: 'text' as const, text: 'SESSION-SURVIVOR must complete' }],
    });

    await upstream.waitForRequests(2, 30_000);
    expect(upstream.pendingRequests()).toBe(2);
    expect(upstream.responsesStarted()).toBe(0);

    const abortResult = await ocClient.session.abort({ sessionID: abortId, directory: dir });
    if (abortResult.error !== undefined) {
      throw new Error(`abort failed: ${JSON.stringify(abortResult.error)}`);
    }

    await waitForCondition(
      () => upstream.destroyedRequests() >= 1,
      15_000,
      'timed out waiting for aborted upstream connection to close',
    );

    expect(upstream.responsesStarted()).toBe(0);
    upstream.releaseGate('SESSION-SURVIVOR');

    const settledResults = await Promise.allSettled([abortPrompt, survivorPrompt]);
    const [abortSettled, survivorSettled] = settledResults;
    if (abortSettled.status === 'rejected') {
      throw new Error(`Abort prompt should have settled with null data but was rejected: ${abortSettled.reason instanceof Error ? abortSettled.reason.message : String(abortSettled.reason)}`);
    }
    if (abortSettled.value?.data !== null) {
      throw new Error(`Abort prompt should have null data but got: ${JSON.stringify(abortSettled.value)}`);
    }
    if (survivorSettled.status === 'rejected') {
      throw new Error(`Survivor prompt should have succeeded but was rejected: ${survivorSettled.reason instanceof Error ? survivorSettled.reason.message : String(survivorSettled.reason)}`);
    }

    await waitForCondition(
      () => hasSessionIdle(allEvents.slice(baseEventIndex), survivorId),
      SESSION_TIMEOUT,
      'timed out waiting for survivor session to finish',
      () => `collected=[${describeRecentEvents(allEvents.slice(baseEventIndex))}] raw=[${describeRawEvents(rawEvents.slice(baseEventIndex))}] requests=[${describeRequests(upstream.requests)}]`,
    );
    const testEvents = allEvents.slice(baseEventIndex);
    const abortEvents = testEvents.filter((event) => extractSessionID(event) === abortId);
    const survivorEvents = testEvents.filter((event) => extractSessionID(event) === survivorId);

    assertNoForeignMarker(abortEvents, 'SESSION-SURVIVOR');
    assertSessionEventIsolation(survivorEvents, 'SESSION-SURVIVOR', 'SESSION-ABORT-TARGET');
    expect(hasSessionIdle(testEvents, survivorId)).toBe(true);
    expect(upstream.destroyedRequests()).toBeGreaterThanOrEqual(1);
    expect(upstream.pendingRequests()).toBe(0);
  }, SESSION_TIMEOUT * 3);

  it('should handle two prompts in the same session', async () => {
    if (!ocClient || !upstream) {
      throw new Error('setup failed');
    }

    const dir = process.cwd();
    const baseEventIndex = allEvents.length;

    upstream.clearRequests();
    upstream.activateGate('SESSION-FIFO-1');
    upstream.activateBodyGate('SESSION-FIFO-2');

    const newSession = await ocClient.session.create({ directory: dir, title: 'FIFO-Test' });
    const sessionId = newSession.data?.id;
    if (!sessionId) {
      throw new Error('session creation failed');
    }

    const prompt1 = ocClient.session.promptAsync({
      sessionID: sessionId,
      directory: dir,
      model: MODEL,
      parts: [{ type: 'text' as const, text: 'SESSION-FIFO-1 first prompt' }],
    });

    await upstream.waitForMarkerRequest('SESSION-FIFO-1', 60_000);
    expect(upstream.requests.length).toBe(1);

    const prePrompt2EventCount = allEvents.length;
    const prompt2 = ocClient.session.promptAsync({
      sessionID: sessionId,
      directory: dir,
      model: MODEL,
      parts: [{ type: 'text' as const, text: 'SESSION-FIFO-2 second prompt' }],
    });

    await waitForCondition(
      () => allEvents.slice(prePrompt2EventCount).some(
        (event) =>
          extractSessionID(event) === sessionId &&
          getEventTextFragments(event).some((text) =>
            text.includes('SESSION-FIFO-2'),
          ),
      ),
      30_000,
      'timed out waiting for second prompt acknowledgement',
      () => `events=[${describeRecentEvents(allEvents.slice(prePrompt2EventCount))}]`,
    );

    // FIFO-2 must not reach the upstream provider while FIFO-1 is still
    // gated — the gate is released below.
    expect(upstream.hasBodyContaining('SESSION-FIFO-2')).toBe(false);

    upstream.releaseGate('SESSION-FIFO-1');
    await upstream.waitForBodyMatch('SESSION-FIFO-2', 60_000);
    upstream.releaseBodyGate('SESSION-FIFO-2');

    await waitForCondition(
      () => hasSessionIdle(allEvents.slice(baseEventIndex), sessionId),
      SESSION_TIMEOUT,
      'timed out waiting for FIFO session to complete',
      () => `collected=[${describeRecentEvents(allEvents.slice(baseEventIndex))}] requests=[${describeRequests(upstream.requests)}]`,
    );

    await expect(prompt1).resolves.toBeDefined();
    await expect(prompt2).resolves.toBeDefined();
    expect(upstream.pendingRequests()).toBe(0);
  }, SESSION_TIMEOUT * 3);

  it('should allow reuse of completed sessions for new prompts', async () => {
    if (!ocClient || !upstream) {
      throw new Error('setup failed');
    }

    const dir = process.cwd();
    const baseEventIndex = allEvents.length;

    upstream.clearRequests();
    upstream.activateGate('SESSION-REUSE-FIRST');
    upstream.activateGate('SESSION-REUSE-SECOND');

    const [sessionReuse1, sessionReuse2] = await Promise.all([
      ocClient.session.create({ directory: dir, title: 'Reuse-A' }),
      ocClient.session.create({ directory: dir, title: 'Reuse-B' }),
    ]);
    const reuseId1 = sessionReuse1.data?.id;
    const reuseId2 = sessionReuse2.data?.id;
    if (!reuseId1 || !reuseId2) {
      throw new Error('reuse test session creation failed');
    }

    const prompt1 = ocClient.session.promptAsync({
      sessionID: reuseId1,
      directory: dir,
      model: MODEL,
      parts: [{ type: 'text' as const, text: 'SESSION-REUSE-FIRST initial' }],
    });
    const prompt2 = ocClient.session.promptAsync({
      sessionID: reuseId2,
      directory: dir,
      model: MODEL,
      parts: [{ type: 'text' as const, text: 'SESSION-REUSE-SECOND initial' }],
    });

    await upstream.waitForRequests(2, 30_000);
    upstream.releaseAllGates();

    await Promise.all([
      waitForCondition(
        () => hasSessionIdle(allEvents.slice(baseEventIndex), reuseId1),
        SESSION_TIMEOUT,
        'timed out waiting for reuse session 1',
        () => `collected=[${describeRecentEvents(allEvents.slice(baseEventIndex))}] requests=[${describeRequests(upstream.requests)}]`,
      ),
      waitForCondition(
        () => hasSessionIdle(allEvents.slice(baseEventIndex), reuseId2),
        SESSION_TIMEOUT,
        'timed out waiting for reuse session 2',
        () => `collected=[${describeRecentEvents(allEvents.slice(baseEventIndex))}] requests=[${describeRequests(upstream.requests)}]`,
      ),
    ]);
    await Promise.all([prompt1, prompt2]);

    upstream.clearRequests();
    upstream.activateGate('SESSION-REUSE-AGAIN');
    const prompt3 = ocClient.session.promptAsync({
      sessionID: reuseId1,
      directory: dir,
      model: MODEL,
      parts: [{ type: 'text' as const, text: 'SESSION-REUSE-AGAIN fresh turn' }],
    });
    const prompt4 = ocClient.session.promptAsync({
      sessionID: reuseId2,
      directory: dir,
      model: MODEL,
      parts: [{ type: 'text' as const, text: 'SESSION-REUSE-AGAIN another turn' }],
    });

    await upstream.waitForRequests(2, 30_000);
    upstream.releaseAllGates();

    await Promise.all([
      waitForCondition(
        () => hasSessionIdle(allEvents.slice(baseEventIndex), reuseId1),
        SESSION_TIMEOUT,
        'timed out waiting for reuse session 1 second turn',
        () => `collected=[${describeRecentEvents(allEvents.slice(baseEventIndex))}] requests=[${describeRequests(upstream.requests)}]`,
      ),
      waitForCondition(
        () => hasSessionIdle(allEvents.slice(baseEventIndex), reuseId2),
        SESSION_TIMEOUT,
        'timed out waiting for reuse session 2 second turn',
        () => `collected=[${describeRecentEvents(allEvents.slice(baseEventIndex))}] requests=[${describeRequests(upstream.requests)}]`,
      ),
    ]);
    await Promise.all([prompt3, prompt4]);

    expect(upstream.pendingRequests()).toBe(0);
  }, SESSION_TIMEOUT * 3);
});

describe.skipIf(shouldSkip)('OpenCodeClient via Takt adapter (integration)', () => {
  let taktUpstream: DummyUpstream | undefined;
  let taktOcClient: import('../../src/infra/opencode/client.js').OpenCodeClient | undefined;
  let taktResetSharedServer: (() => void) | undefined;

  beforeAll(async () => {
    vi.clearAllMocks();
    const upstream = new DummyUpstream();
    taktUpstream = upstream;
    await upstream.start();

    createOpencodeMock.mockImplementation(async (config: Record<string, unknown>) => {
      const mod = await vi.importActual<typeof import('@opencode-ai/sdk/v2')>('@opencode-ai/sdk/v2');
      const serverConfig = (config.config ?? {}) as Record<string, unknown>;
      const injectedConfig = {
        ...config,
        config: {
          ...serverConfig,
          model: RESPONSE_MODEL,
          small_model: RESPONSE_MODEL,
          provider: {
            opencode: {
              options: {
                baseURL: `http://127.0.0.1:${upstream.port}`,
                apiKey: DUMMY_API_KEY,
              },
            },
          },
        },
      };
      return mod.createOpencode(injectedConfig);
    });

    const { OpenCodeClient, resetSharedServer } = await import('../../src/infra/opencode/client.js');
    taktResetSharedServer = resetSharedServer;
    resetSharedServer();
    taktOcClient = new OpenCodeClient();
  });

  beforeEach(() => {
    taktUpstream?.releaseAllGates();
    taktUpstream?.clearRequests();
    taktResetSharedServer?.();
  });

  afterAll(async () => {
    if (taktUpstream) {
      taktUpstream.releaseAllGates();
      await taktUpstream.close();
    }
    vi.restoreAllMocks();
  });

  it('should send two new session (no sessionId) calls to upstream concurrently', async () => {
    if (!taktUpstream || !taktOcClient) {
      throw new Error('setup failed');
    }

    taktUpstream.clearRequests();
    taktUpstream.activateGate('TAKT-CONCURRENT-A');
    taktUpstream.activateGate('TAKT-CONCURRENT-B');

    const callA = taktOcClient.call('coder', 'TAKT-CONCURRENT-A message', {
      cwd: process.cwd(),
      model: RESPONSE_MODEL,
    });
    const callB = taktOcClient.call('coder', 'TAKT-CONCURRENT-B message', {
      cwd: process.cwd(),
      model: RESPONSE_MODEL,
    });

    await Promise.all([
      taktUpstream.waitForMarkerRequest('TAKT-CONCURRENT-A', 60_000),
      taktUpstream.waitForMarkerRequest('TAKT-CONCURRENT-B', 60_000),
    ]);

    expect(taktUpstream.pendingRequests()).toBe(2);

    taktUpstream.releaseAllGates();

    const results = await Promise.all([callA, callB]);
    expect(results[0].status).toBe('done');
    expect(results[1].status).toBe('done');
    expect(taktUpstream.pendingRequests()).toBe(0);
  }, SESSION_TIMEOUT * 3);

  it('should not let one call abort interrupt another concurrent call', async () => {
    if (!taktUpstream || !taktOcClient) {
      throw new Error('setup failed');
    }

    taktUpstream.clearRequests();
    taktUpstream.activateGate('TAKT-ABORT-TARGET');
    taktUpstream.activateGate('TAKT-SURVIVOR');

    const abortController = new AbortController();
    const abortTarget = taktOcClient.call('coder', 'TAKT-ABORT-TARGET message', {
      cwd: process.cwd(),
      model: RESPONSE_MODEL,
      abortSignal: abortController.signal,
    });
    const survivor = taktOcClient.call('coder', 'TAKT-SURVIVOR message', {
      cwd: process.cwd(),
      model: RESPONSE_MODEL,
    });

    await Promise.all([
      taktUpstream.waitForMarkerRequest('TAKT-ABORT-TARGET', 60_000),
      taktUpstream.waitForMarkerRequest('TAKT-SURVIVOR', 60_000),
    ]);

    expect(taktUpstream.pendingRequests()).toBe(2);

    abortController.abort();
    const abortResult = await abortTarget;
    expect(abortResult.status).toBe('error');

    expect(taktUpstream.getMarkerRequest('TAKT-SURVIVOR')).toBeDefined();

    taktUpstream.releaseGate('TAKT-SURVIVOR');

    const survivorResult = await survivor;
    expect(survivorResult.status).toBe('done');
  }, SESSION_TIMEOUT * 3);

  it('should serialize same session ID calls in FIFO order', async () => {
    if (!taktUpstream || !taktOcClient) {
      throw new Error('setup failed');
    }

    // Create a real session to get a valid session ID
    taktUpstream.clearRequests();
    const seedResult = await taktOcClient.call('coder', 'seed session for FIFO', {
      cwd: process.cwd(),
      model: RESPONSE_MODEL,
    });
    expect(seedResult.status).toBe('done');
    const sessionId = seedResult.sessionId;
    if (!sessionId) {
      throw new Error('FIFO test seed call returned no sessionId');
    }

    taktUpstream.clearRequests();
    taktUpstream.activateGate('TAKT-FIFO-1');
    taktUpstream.activateBodyGate('TAKT-FIFO-2');

    const ac2 = new AbortController();
    const registerAbortSpy = vi.spyOn(ac2.signal, 'addEventListener');

    const call1 = taktOcClient.call('coder', 'TAKT-FIFO-1 first', {
      cwd: process.cwd(),
      model: RESPONSE_MODEL,
      sessionId,
    });
    const call2 = taktOcClient.call('coder', 'TAKT-FIFO-2 second', {
      cwd: process.cwd(),
      model: RESPONSE_MODEL,
      sessionId,
      abortSignal: ac2.signal,
    });

    // Wait for call2 to be enqueued — visible via the abort listener
    // registration in acquireSharedServer.  This ensures call2 has been
    // accepted by the queue before we assert it hasn't reached upstream.
    await vi.waitFor(() => {
      expect(registerAbortSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    expect(registerAbortSpy.mock.calls[1]).toEqual([
      'abort',
      expect.any(Function),
      { once: true },
    ]);

    await taktUpstream.waitForMarkerRequest('TAKT-FIFO-1', 60_000);
    expect(taktUpstream.pendingRequests()).toBe(1);
    expect(taktUpstream.hasBodyContaining('TAKT-FIFO-2')).toBe(false);

    // Release the first — the second call is now unblocked.  Wait for
    // the second request body to arrive (body-gated).
    taktUpstream.releaseGate('TAKT-FIFO-1');
    await taktUpstream.waitForBodyMatch('TAKT-FIFO-2', 60_000);
    taktUpstream.releaseBodyGate('TAKT-FIFO-2');

    const results = await Promise.all([call1, call2]);
    expect(results[0].status).toBe('done');
    expect(results[1].status).toBe('done');
    expect(taktUpstream.pendingRequests()).toBe(0);
  }, SESSION_TIMEOUT * 3);

  it('should queue a follow-up call started from init callback behind the first', async () => {
    if (!taktUpstream || !taktOcClient) {
      throw new Error('setup failed');
    }

    taktUpstream.clearRequests();
    taktUpstream.activateGate('TAKT-INIT-FIRST');
    taktUpstream.activateBodyGate('TAKT-INIT-SECOND');

    let call2Promise: Promise<AgentResponse> | undefined;
    const ac2 = new AbortController();
    const registerAbortSpy = vi.spyOn(ac2.signal, 'addEventListener');
    const onStream = vi.fn((event) => {
      if (event.type === 'init' && typeof event.data?.sessionId === 'string') {
        call2Promise = taktOcClient!.call('coder', 'TAKT-INIT-SECOND follow-up', {
          cwd: process.cwd(),
          model: RESPONSE_MODEL,
          sessionId: event.data.sessionId,
          abortSignal: ac2.signal,
        });
      }
    });

    const call1 = taktOcClient.call('coder', 'TAKT-INIT-FIRST initial', {
      cwd: process.cwd(),
      model: RESPONSE_MODEL,
      onStream,
    });

    await taktUpstream.waitForMarkerRequest('TAKT-INIT-FIRST', 60_000);

    await vi.waitFor(() => {
      expect(call2Promise).toBeDefined();
      expect(registerAbortSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    expect(registerAbortSpy.mock.calls[1]).toEqual([
      'abort',
      expect.any(Function),
      { once: true },
    ]);

    expect(taktUpstream.hasBodyContaining('TAKT-INIT-SECOND')).toBe(false);
    expect(taktUpstream.pendingRequests()).toBe(1);

    taktUpstream.releaseGate('TAKT-INIT-FIRST');
    await taktUpstream.waitForBodyMatch('TAKT-INIT-SECOND', 60_000);
    taktUpstream.releaseBodyGate('TAKT-INIT-SECOND');

    const results = await Promise.all([call1, call2Promise!]);
    expect(results[0].status).toBe('done');
    expect(results[1].status).toBe('done');
    expect(taktUpstream.pendingRequests()).toBe(0);
  }, SESSION_TIMEOUT * 3);
});
