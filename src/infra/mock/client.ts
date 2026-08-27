/**
 * Mock agent client for testing
 *
 * Returns immediate fixed responses without any API calls.
 * Useful for testing workflows without incurring costs or latency.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AgentResponse } from '../../core/models/index.js';
import type { PreparedProviderMcp } from '../providers/mcp/types.js';
import type { StreamCallback, StreamEvent } from '../../shared/types/provider.js';
import { appendPrivateFile } from '../../shared/utils/private-file.js';
import { getScenarioQueue } from './scenario.js';
import type { MockCallOptions, ScenarioEntry } from './types.js';
import { assertPathSegmentsAreSafe } from '../../shared/utils/pathBoundary.js';

export type { MockCallOptions };

const RUNTIME_ENV_KEYS = [
  'TMPDIR',
  'TEMP',
  'TMP',
  'TAKT_RUNTIME_TMP',
  'GRADLE_USER_HOME',
  'npm_config_cache',
] as const;

/**
 * Generate a mock session ID
 */
function generateMockSessionId(): string {
  return `mock-session-${randomUUID()}`;
}

function structuredTextOutput(
  schema: Record<string, unknown> | undefined,
  content: string,
): Record<string, unknown> | undefined {
  if (schema?.type !== 'object' || schema.additionalProperties !== false) {
    return undefined;
  }
  const properties = schema.properties;
  const required = schema.required;
  if (
    typeof properties !== 'object'
    || properties === null
    || Array.isArray(properties)
    || !Array.isArray(required)
    || required.length !== 1
    || required[0] !== 'content'
  ) {
    return undefined;
  }
  const contentSchema = Reflect.get(properties, 'content');
  if (
    typeof contentSchema !== 'object'
    || contentSchema === null
    || Array.isArray(contentSchema)
    || Reflect.get(contentSchema, 'type') !== 'string'
  ) {
    return undefined;
  }
  return { content };
}

function recordMockCall(
  event: 'start' | 'complete' | 'mcp_tool_call',
  personaName: string,
  details?: {
    model?: string;
    permissionMode?: MockCallOptions['permissionMode'];
    allowedTools?: readonly string[];
    status?: AgentResponse['status'];
    aborted?: boolean;
    mcpServers?: Record<string, { transport: string }>;
    mcpToolCall?: { server: string; transport: string; tool: string; result: unknown; nonce?: string };
    inputSessionId?: string;
    returnedSessionId?: string;
  },
): void {
  const logPath = process.env.TAKT_MOCK_CALL_LOG;
  if (!logPath) {
    return;
  }
  const runtimeEnvironment = Object.fromEntries(
    RUNTIME_ENV_KEYS.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  appendPrivateFile(logPath, `${JSON.stringify({
    event,
    provider: 'mock',
    personaName,
    runtimeEnvironment,
    ...details,
    ...(details?.inputSessionId === undefined ? {} : {
      inputSessionId: mockSessionIdentity(details.inputSessionId),
    }),
    ...(details?.returnedSessionId === undefined ? {} : {
      returnedSessionId: mockSessionIdentity(details.returnedSessionId),
    }),
  })}\n`);
}

/**
 * Record a deterministic MCP tool call event for the mock provider
 * (order.md:240-242). Invoked when `preparedMcp.resolvedServers` has at
 * least one enabled server, so E2E tests can assert that runtime-resolved
 * MCP servers reach the provider.
 */
function recordMcpToolCall(
  personaName: string,
  serverName: string,
  transport: string,
  tool: string,
  result: unknown,
  nonce: string | undefined,
): void {
  recordMockCall('mcp_tool_call', personaName, {
    mcpToolCall: { server: serverName, transport, tool, result, nonce },
  });
}

/**
 * Build a compact MCP server summary for mock call logging
 * (issue #1137). Records server name and transport only; secret values
 * (env/headers) are never logged.
 */
function buildMcpServerSummary(
  preparedMcp: PreparedProviderMcp | undefined,
): Record<string, { transport: string }> | undefined {
  const resolved = preparedMcp?.resolvedServers;
  if (!resolved?.enabled || Object.keys(resolved.servers).length === 0) {
    return undefined;
  }
  const summary: Record<string, { transport: string }> = {};
  for (const [name, server] of Object.entries(resolved.servers)) {
    summary[name] = { transport: server.type ?? 'stdio' };
  }
  return summary;
}

function mockSessionIdentity(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

async function delayWithAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    throw new Error('Mock scenario wait_for_abort requires an abort signal');
  }
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

/** Records the completion and builds the response returned whenever a mock call is aborted. */
function finishAbortedCall(personaName: string, sessionId: string): AgentResponse {
  recordMockCall('complete', personaName, {
    status: 'blocked',
    aborted: true,
    returnedSessionId: sessionId,
  });
  return {
    persona: personaName,
    status: 'blocked',
    content: '[MOCK:ABORTED]\n\nMock response interrupted by abort signal.',
    timestamp: new Date(),
    sessionId,
  };
}

/** Read through a call so the narrowing from an earlier check does not persist. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function streamTextChunks(
  chunks: NonNullable<ScenarioEntry['textChunks']>,
  onStream: StreamCallback,
  signal: AbortSignal | undefined,
): Promise<'completed' | 'aborted'> {
  for (const chunk of chunks) {
    // Checked before every emission, not only around a delay: a chunk without a
    // delay, or an abort raised while the caller handled the previous chunk,
    // must stop the stream just as promptly.
    if (isAborted(signal)) {
      return 'aborted';
    }
    if (chunk.delayMs !== undefined) {
      try {
        await delayWithAbort(chunk.delayMs, signal);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          return 'aborted';
        }
        throw e;
      }
    }
    if (isAborted(signal)) {
      return 'aborted';
    }
    onStream({ type: 'text', data: { text: chunk.text } });
  }
  return isAborted(signal) ? 'aborted' : 'completed';
}

/**
 * Writes the prompt a call received, for a test that needs to assert on what
 * reached the provider.
 *
 * Deliberately separate from the call log, which is contractually free of
 * prompt content: this one is written only when its own variable names a file,
 * and nothing but a test sets it.
 */
function recordMockPrompt(personaName: string, prompt: string): void {
  const logPath = process.env.TAKT_MOCK_PROMPT_LOG;
  if (!logPath) {
    return;
  }
  appendPrivateFile(logPath, `${JSON.stringify({ personaName, prompt })}\n`);
}

function applyScenarioFileWrites(entry: ScenarioEntry | undefined, cwd: string): void {
  for (const write of entry?.fileWrites ?? []) {
    const target = resolve(cwd, write.path);
    assertPathSegmentsAreSafe(
      cwd,
      target,
      (violation) => new Error(`Mock scenario file_writes path violates cwd boundary (${violation})`),
      { rejectSamePath: true },
    );
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, write.content, 'utf-8');
  }
}

function findScenarioFiles(root: string, filename: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      return findScenarioFiles(entryPath, filename);
    }
    return entry.isFile() && entry.name === filename ? [entryPath] : [];
  });
}

type ScenarioFileConditionEvaluation =
  | { readonly matches: true }
  | { readonly matches: false; readonly mismatchError: Error };

function evaluateScenarioFileCondition(
  condition: ScenarioEntry['fileCondition'],
  cwd: string,
): ScenarioFileConditionEvaluation {
  if (condition === undefined) return { matches: true };
  const matches = findScenarioFiles(cwd, condition.filename);
  if (condition.state === 'missing') {
    return matches.length === 0
      ? { matches: true }
      : {
        matches: false,
        mismatchError: new Error(`Mock scenario expected ${condition.filename} to be missing`),
      };
  }
  if (matches.length !== 1) {
    return {
      matches: false,
      mismatchError: new Error(
        `Mock scenario expected exactly one ${condition.filename}, found ${matches.length}`,
      ),
    };
  }
  if (condition.state === 'unreadable') {
    try {
      readFileSync(matches[0]!, 'utf-8');
    } catch {
      return { matches: true };
    }
    return {
      matches: false,
      mismatchError: new Error(`Mock scenario expected ${condition.filename} to be unreadable`),
    };
  }
  let content: string;
  try {
    content = readFileSync(matches[0]!, 'utf-8');
  } catch (error) {
    return {
      matches: false,
      mismatchError: new Error(
        `Mock scenario expected ${condition.filename} to be readable`,
        { cause: error },
      ),
    };
  }
  if (!content.includes(condition.includes)) {
    return {
      matches: false,
      mismatchError: new Error(
        `Mock scenario expected ${condition.filename} to contain the required text`,
      ),
    };
  }
  return { matches: true };
}

/**
 * Call mock agent - returns immediate fixed response
 */
export async function callMock(
  personaName: string,
  prompt: string,
  options: MockCallOptions
): Promise<AgentResponse> {
  options.onActivity?.({ kind: 'attempt_started' });
  const sessionId = options.sessionId ?? generateMockSessionId();

  // Scenario queue takes priority over explicit options
  const scenarioEntry = getScenarioQueue()?.consume(personaName);
  recordMockCall('start', personaName, {
    model: options.model,
    permissionMode: options.permissionMode,
    allowedTools: options.allowedTools,
    mcpServers: buildMcpServerSummary(options.preparedMcp),
    inputSessionId: options.sessionId,
  });
  recordMockPrompt(personaName, prompt);

  // Apply deterministic abort gating or an artificial delay when requested.
  if (scenarioEntry?.waitForAbort === true || scenarioEntry?.delayMs) {
    try {
      if (scenarioEntry.waitForAbort === true) {
        await waitForAbort(options.abortSignal);
      } else {
        await delayWithAbort(scenarioEntry.delayMs!, options.abortSignal);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        return finishAbortedCall(personaName, sessionId);
      }
      throw e;
    }
  }

  const fileCondition = evaluateScenarioFileCondition(scenarioEntry?.fileCondition, options.cwd);
  if (!fileCondition.matches && scenarioEntry?.mismatchContent === undefined) {
    throw fileCondition.mismatchError;
  }

  const status = scenarioEntry?.status ?? options.mockStatus ?? 'done';
  const statusMarker = `[MOCK:${status.toUpperCase()}]`;
  const allowedToolsSuffix = options.allowedTools && options.allowedTools.length > 0
    ? `\nAllowed tools: ${options.allowedTools.join(', ')}`
    : '';
  const scenarioContent = fileCondition.matches
    ? scenarioEntry?.content
    : scenarioEntry?.mismatchContent;
  const content = scenarioContent ?? options.mockResponse ??
    `${statusMarker}\n\nMock response for persona "${personaName}".\nPrompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}${allowedToolsSuffix}`;

  applyScenarioFileWrites(scenarioEntry, options.cwd);

  // Emit stream events if callback is provided
  if (options.onStream) {
    const initEvent: StreamEvent = {
      type: 'init',
      data: { model: 'mock-model', sessionId },
    };
    options.onStream(initEvent);
    // The caller can abort while it consumes an event, and the answer body is
    // the one thing an abort cannot take back once it is on screen.
    if (isAborted(options.abortSignal)) {
      return finishAbortedCall(personaName, sessionId);
    }

    for (const event of scenarioEntry?.streamEvents ?? []) {
      options.onStream({
        type: 'tool_use',
        data: { tool: event.tool, id: event.id, input: { ...event.input } },
      });
      if (isAborted(options.abortSignal)) {
        return finishAbortedCall(personaName, sessionId);
      }
    }

    if (scenarioEntry?.textChunks === undefined) {
      const textEvent: StreamEvent = {
        type: 'text',
        data: { text: content },
      };
      options.onStream(textEvent);
    } else {
      const outcome = await streamTextChunks(
        scenarioEntry.textChunks,
        options.onStream,
        options.abortSignal,
      );
      if (outcome === 'aborted') {
        return finishAbortedCall(personaName, sessionId);
      }
    }

    // An abort raised while the caller consumed the last text event must not be
    // followed by a success result.
    if (isAborted(options.abortSignal)) {
      return finishAbortedCall(personaName, sessionId);
    }
    const resultEvent: StreamEvent = {
      type: 'result',
      data: { success: true, result: content, sessionId },
    };
    options.onStream(resultEvent);
  }

  recordMockCall('complete', personaName, {
    status,
    aborted: false,
    returnedSessionId: sessionId,
  });

  // Runtime MCP adapter route (issue #1137): when the runner prepared MCP
  // material with an enabled server set, simulate a deterministic stdio
  // MCP server startup and a single fixture tool call so E2E tests can
  // assert that runtime-resolved MCP servers reach the provider
  // (order.md:240-242, ARCH-NEW-4). The server is selected by sorted name;
  // the fixture tool, result, and nonce remain fixed for deterministic tests.
  const preparedMcp = options.preparedMcp;
  const resolvedServers = preparedMcp?.resolvedServers;
  if (resolvedServers?.enabled && Object.keys(resolvedServers.servers).length > 0) {
    const serverName = Object.keys(resolvedServers.servers).sort()[0];
    if (serverName === undefined) {
      throw new Error('Mock MCP fixture requires an enabled server');
    }
    const serverConfig = resolvedServers.servers[serverName];
    if (serverConfig === undefined) {
      throw new Error(`Mock MCP fixture server "${serverName}" is not defined`);
    }
    const transport = serverConfig.type ?? 'stdio';
    const fixtureTool = 'echo_nonce';
    const fixtureResult = 'NONCE:fixed-test-nonce';
    const nonce = 'fixed-test-nonce';
    recordMcpToolCall(personaName, serverName, transport, fixtureTool, fixtureResult, nonce);
  }

  return {
    persona: personaName,
    status,
    content,
    timestamp: new Date(),
    sessionId,
    structuredOutput: scenarioEntry?.structuredOutput
      ?? options.structuredOutput
      ?? structuredTextOutput(options.outputSchema, content),
    error: scenarioEntry?.error ?? options.error,
    failureCategory: scenarioEntry?.failureCategory ?? options.failureCategory,
  };
}

/**
 * Call mock agent with custom system prompt (same as callMock for mock provider)
 */
export async function callMockCustom(
  personaName: string,
  prompt: string,
  _systemPrompt: string,
  options: MockCallOptions
): Promise<AgentResponse> {
  // For mock, system prompt is ignored - just return fixed response
  return callMock(personaName, prompt, options);
}
