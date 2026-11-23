import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { WORKER_ENDPOINT, WORKER_FRAME_MAX_BYTES, WorkerRequestSchema, WorkerResponseSchema, WorkerRejectedError,
  type WorkerConnectionSink, type WorkerRequest, type WorkerResponse } from '../../core/worker-pool/remoteProtocol.js';

async function* frames(stream: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  for await (const chunk of stream) {
    pending += decoder.write(Buffer.from(chunk));
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (Buffer.byteLength(line) > WORKER_FRAME_MAX_BYTES) throw new Error('Worker frame exceeds capacity');
      yield JSON.parse(line) as unknown;
    }
    if (Buffer.byteLength(pending) > WORKER_FRAME_MAX_BYTES) throw new Error('Worker frame exceeds capacity');
  }
  if (pending.length !== 0 || decoder.end().length !== 0) throw new Error('Worker frame was truncated');
}

export async function createWorkerServer(input: {
  host: string; port: number;
  runtime: { authenticate(token: string): Promise<void>;
    receive(token: string, request: WorkerRequest, sink: WorkerConnectionSink): Promise<void>; disconnect(sink: WorkerConnectionSink): void };
  onError(error: unknown): void;
}) {
  const connections = new Set<WorkerConnectionSink>();
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== WORKER_ENDPOINT) {
      response.writeHead(404).end();
      request.resume();
      return;
    }
    response.setHeader('content-type', 'application/x-ndjson');
    let ended = false;
    let authenticated = false;
    let workerId: string | undefined;
    const disconnected = (): void => {
      ended = true;
      connections.delete(sink);
      input.runtime.disconnect(sink);
    };
    const sink: WorkerConnectionSink = {
      send(message) {
        if (response.destroyed || response.writableEnded) return;
        response.write(`${JSON.stringify(message)}\n`);
      },
      close() {
        if (ended) return;
        ended = true;
        response.end(); request.resume(); disconnected();
      },
      fail(error) {
        if (ended) return;
        if (error instanceof WorkerRejectedError) {
          // An unfinished unauthenticated request must not retain a socket after its rejection is flushed.
          if (!authenticated) response.once('finish', () => { request.destroy(); });
          sink.send({ kind: 'rejected', reason: error.message });
          sink.close();
        } else {
          ended = true;
          if (!request.destroyed) input.onError(new Error(workerId === undefined
            ? 'Worker communication failed' : `Worker ${workerId} communication failed`));
          response.destroy(); request.destroy(); disconnected();
        }
      },
    };
    connections.add(sink);
    response.once('close', disconnected);
    void (async () => {
      const authorization = request.headers.authorization;
      if (authorization === undefined || !authorization.startsWith('Bearer ')) throw new WorkerRejectedError('Worker token is required');
      const token = authorization.slice(7);
      await input.runtime.authenticate(token);
      authenticated = true;
      let connected = false;
      // Keep the response writable when message validation or authentication rejects a frame.
      for await (const value of frames(request.iterator({ destroyOnReturn: false }))) {
        const parsed = WorkerRequestSchema.safeParse(value);
        if (!parsed.success) throw new WorkerRejectedError('Invalid worker protocol message');
        const message = parsed.data;
        if (!connected && message.kind !== 'connect' || connected && message.kind === 'connect') {
          throw new WorkerRejectedError('Worker connection handshake is required exactly once');
        }
        await input.runtime.receive(token, message, sink);
        if (message.kind === 'connect') workerId = message.workerId;
        connected = true;
      }
    })().catch((error: unknown) => { sink.fail(error); }).finally(disconnected);
  });
  server.requestTimeout = 0;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(input.port, input.host, () => { server.removeListener('error', reject); resolve(); });
  });
  server.on('error', input.onError);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Worker server has no TCP address');
  return {
    port: address.port,
    async close() {
      for (const sink of connections) sink.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve(); }));
    },
  };
}

export interface WorkerTransport {
  send(request: WorkerRequest): void;
  close(): void;
  closed: Promise<void>;
}

export function connectWorkerTransport(input: { url: URL; token: string; onResponse(response: WorkerResponse): void }): WorkerTransport {
  let response: IncomingMessage | undefined;
  let finish!: () => void;
  let fail!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const receive = (received: IncomingMessage): void => {
    response = received;
    void (async () => {
      if (received.statusCode !== undefined && received.statusCode >= 500 && received.statusCode < 600) {
        throw new Error('Worker endpoint is temporarily unavailable');
      }
      if (received.statusCode !== 200) throw new WorkerRejectedError(`Worker endpoint rejected connection (HTTP ${received.statusCode})`);
      for await (const value of frames(received)) input.onResponse(WorkerResponseSchema.parse(value));
    })().then(finish, (error: unknown) => { request.destroy(); fail(error instanceof WorkerRejectedError ? error : new Error('Worker connection was interrupted')); });
  };
  const url = new URL(input.url);
  url.pathname = `${url.pathname.replace(/\/$/, '')}${WORKER_ENDPOINT}`;
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    method: 'POST', headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/x-ndjson' },
  }, receive);
  request.on('error', () => { response?.destroy(); finish(); });
  request.on('close', finish);
  request.setNoDelay(true);
  request.flushHeaders();
  return {
    send(message) { if (!request.destroyed) request.write(`${JSON.stringify(message)}\n`); },
    close() { request.destroy(); response?.destroy(); finish(); },
    closed,
  };
}
