import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { ToolPermissionDecision, ToolPermissionDecisionHandler, ToolPermissionDecisionRequest } from '../../core/workflow/types.js';
import {
  CODEX_TOOL_PERMISSION_DECISION_TIMEOUT_MS, CODEX_TOOL_PERMISSION_ENDPOINT_ENV,
  CODEX_TOOL_PERMISSION_TOKEN_ENV, CODEX_TOOL_PERMISSION_HOOK_TIMEOUT_SECONDS,
  codexToolPermissionDenial, parseCodexToolPermissionInput, parseCodexToolPermissionDecision,
  toCodexToolPermissionOutput,
} from './tool-permission-hook-protocol.js';

export async function requestCodexToolPermissionDecision(
  handler: ToolPermissionDecisionHandler, request: ToolPermissionDecisionRequest,
): Promise<ToolPermissionDecision> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(request.abortSignal === undefined ? [] : [request.abortSignal])]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('Permission decision interrupted'));
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => controller.abort(), CODEX_TOOL_PERMISSION_DECISION_TIMEOUT_MS);
    });
    const decision: unknown = await Promise.race([handler({ ...request, abortSignal: signal }), interrupted]);
    signal.throwIfAborted();
    return parseCodexToolPermissionDecision(decision);
  } catch {
    return { decision: 'deny', reason: signal.aborted ? 'Tool permission decision interrupted or timed out' : 'Tool permission decision failed or returned invalid data' };
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

export function buildCodexToolPermissionHookCommand(handlerPath: string, credentials: { endpoint: string; token: string }): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const args = [process.execPath,
    ...(handlerPath.endsWith('.ts') ? ['--import', createRequire(import.meta.url).resolve('tsx/esm')] : []), handlerPath];
  return `${CODEX_TOOL_PERMISSION_ENDPOINT_ENV}=${quote(credentials.endpoint)} ${CODEX_TOOL_PERMISSION_TOKEN_ENV}=${quote(credentials.token)} exec ${args.map(quote).join(' ')}`;
}

export async function prepareCodexToolPermissionHook(handler: ToolPermissionDecisionHandler, abortSignal?: AbortSignal) {
  abortSignal?.throwIfAborted();
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, ...(abortSignal === undefined ? [] : [abortSignal])]);
  const token = randomBytes(32).toString('hex');
  const server = createServer((request, response) => {
    const respond = (output: ReturnType<typeof toCodexToolPermissionOutput>) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(output));
    };
    if (signal.aborted || request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}`) {
      request.resume();
      respond(codexToolPermissionDenial('Tool permission request is not authorized'));
      return;
    }
    const disconnected = new AbortController();
    const requestSignal = AbortSignal.any([signal, disconnected.signal]);
    const onClose = () => disconnected.abort();
    response.once('close', onClose);
    const timeout = setTimeout(() => {
      disconnected.abort();
      respond(codexToolPermissionDenial('Tool permission request timed out'));
      request.destroy();
    }, CODEX_TOOL_PERMISSION_DECISION_TIMEOUT_MS);
    void (async () => {
      try {
        let body = '';
        request.setEncoding('utf8');
        for await (const chunk of request) body += String(chunk);
        const input = parseCodexToolPermissionInput(JSON.parse(body) as unknown);
        const decision = await requestCodexToolPermissionDecision(handler, { ...input, abortSignal: requestSignal });
        respond(toCodexToolPermissionOutput(decision));
      } catch {
        respond(codexToolPermissionDenial('Invalid tool permission request'));
      } finally {
        clearTimeout(timeout);
        response.removeListener('close', onClose);
      }
    })();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    signal.throwIfAborted();
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Permission endpoint has no TCP address');
    const builtPath = fileURLToPath(new URL('./tool-permission-hook-handler.js', import.meta.url));
    const handlerPath = existsSync(builtPath) ? builtPath : fileURLToPath(new URL('./tool-permission-hook-handler.ts', import.meta.url));
    const endpoint = `http://127.0.0.1:${address.port}`;
    return {
      definition: { command: buildCodexToolPermissionHookCommand(handlerPath, { endpoint, token }), matcher: '.*', timeout: CODEX_TOOL_PERMISSION_HOOK_TIMEOUT_SECONDS },
      redact(text: string) {
        return text.replaceAll(token, '[REDACTED]').replaceAll(endpoint, '[REDACTED]');
      },
      async dispose() {
        lifetime.abort();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      },
    };
  } catch (error) {
    lifetime.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}
