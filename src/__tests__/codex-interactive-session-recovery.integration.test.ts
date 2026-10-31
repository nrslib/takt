import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { callAIWithRetry } from '../features/interactive/aiCaller.js';
import { CodexProvider } from '../infra/providers/codex.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { getPersonaSessionsPath, loadPersonaSessions, updatePersonaSession } from '../infra/config/project/sessionStore.js';
import { makeSessionContext } from './test-helpers.js';
import type { StreamCallback } from '../shared/types/provider.js';

const sdk = vi.hoisted(() => ({ run: vi.fn(), start: vi.fn() }));
vi.mock('../infra/managed-providers/preflight.js', () => ({ checkManagedProviders: vi.fn(async () => {}) }));
vi.mock('../infra/managed-providers/loader.js', () => ({ loadManagedSdk: async () => ({
  directory: process.cwd(), modules: [await import('@openai/codex-sdk')], stale: false,
}) }));
vi.mock('@openai/codex-sdk', () => ({ Codex: class {
  startThread() { sdk.start(); return { runStreamed: (prompt: unknown) => sdk.run(undefined, prompt) }; }
  resumeThread(id: string) { return { id, runStreamed: (prompt: unknown) => sdk.run(id, prompt) }; }
} }));

const savedId = '00000000-0000-4000-8000-000000000099';
let cwd: string;
let context: ReturnType<typeof makeSessionContext>;

function refusal() {
  return `Codex Exec exited with code 1: Reading prompt from stdin...\nError: thread/resume: thread/resume failed: no rollout found for thread id ${savedId} (code -32600)\n`;
}

function success(id: string | undefined, text = 'fresh reply') {
  return { events: (async function* () {
    if (id !== undefined) yield { type: 'thread.started', thread_id: id };
    yield { type: 'item.completed', item: { id: 'reply', type: 'agent_message', text } };
    yield { type: 'turn.completed' };
  })() };
}

function rejectResume(tool = false) {
  sdk.run.mockImplementationOnce(async () => ({ events: (async function* () {
    if (tool) yield { type: 'item.started', item: { id: 'tool', type: 'command_execution', command: 'test' } };
    throw new Error(refusal());
  })() }));
}

const invoke = (options: Parameters<typeof callAIWithRetry>[5] = {}) =>
  callAIWithRetry('continue', 'system', undefined, cwd, context, { outputMode: 'silent', ...options });

beforeEach(() => {
  vi.clearAllMocks();
  sdk.run.mockReset(); sdk.start.mockReset();
  cwd = join(getGlobalConfigDir(), 'codex-interactive');
  mkdirSync(cwd, { recursive: true });
  context = makeSessionContext({ provider: new CodexProvider(), providerType: 'codex', sessionId: savedId });
  updatePersonaSession(cwd, context.personaName, savedId, 'codex');
});

it.each(['fresh-session', undefined])('recovers once and uses the fresh result ID on the next turn (%s)', async (freshId) => {
  rejectResume();
  sdk.run.mockImplementationOnce(async (_id, prompt) => {
    expect(loadPersonaSessions(cwd, 'codex')).toEqual({});
    expect(prompt).toContain('continue');
    return success(freshId);
  });
  const recovered = await invoke();
  expect(sdk.run.mock.calls.map(([id]) => id)).toEqual([savedId, undefined]);
  expect(recovered).toMatchObject({ sessionId: freshId, result: { success: true, content: 'fresh reply', sessionId: freshId } });
  expect(loadPersonaSessions(cwd, 'codex')).toEqual(freshId === undefined ? {} : {
    [context.personaName]: freshId, [`${context.personaName}:codex`]: freshId,
  });
  context = { ...context, sessionId: recovered.sessionId };
  sdk.run.mockResolvedValueOnce(success(freshId, 'next reply'));
  expect((await invoke()).result?.content).toBe('next reply');
  expect(sdk.run.mock.calls.map(([id]) => id)).toEqual([savedId, undefined, freshId]);
});

it.each(['response', 'exception'] as const)('does not restore the rejected ID when fresh execution fails (%s)', async (failure) => {
  rejectResume();
  if (failure === 'response') sdk.run.mockResolvedValueOnce({ events: (async function* () {
    yield { type: 'turn.failed', error: { message: 'Authentication failed' } };
  })() });
  else sdk.start.mockImplementationOnce(() => { throw new Error('SDK startup failed'); });
  const recovered = await invoke();
  expect(recovered.sessionId).toBeUndefined();
  expect(recovered.result?.success ?? false).toBe(false);
  expect(loadPersonaSessions(cwd, 'codex')).toEqual({});
  expect(sdk.run).toHaveBeenCalledTimes(failure === 'response' ? 2 : 1);
  expect(sdk.start).toHaveBeenCalledOnce();
  context = { ...context, sessionId: recovered.sessionId };
  sdk.run.mockResolvedValueOnce(success('next-session'));
  expect((await invoke()).result?.success).toBe(true);
  expect(sdk.run.mock.lastCall?.[0]).toBeUndefined();
});

it.each(['abort', 'disabled', 'effort', 'tool', 'tool-observer'] as const)('clears a rejected ID without resending when %s prevents retry', async (condition) => {
  const controller = new AbortController();
  if (condition === 'disabled') context.disableSessionRetry = true;
  if (condition === 'effort') context.effort = 'high';
  const onStream = vi.fn<StreamCallback>((event) => {
    if (condition === 'abort' && event.type === 'result') controller.abort();
  });
  rejectResume(condition.startsWith('tool'));
  const result = await invoke({ abortSignal: controller.signal, ...(condition === 'tool-observer' || condition === 'abort' ? { onStream } : {}) });
  expect(sdk.run).toHaveBeenCalledOnce();
  expect(sdk.start).not.toHaveBeenCalled();
  expect(result.sessionId).toBeUndefined();
  expect(result.result?.sessionId).toBeUndefined();
  expect(result.result?.success).toBe(false);
  expect(loadPersonaSessions(cwd, 'codex')).toEqual({});
  if (condition === 'tool-observer') expect(onStream).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_use' }));
});

it.each([false, () => false])('preserves storage permission while clearing the local rejected ID (%s)', async (persistSession) => {
  const before = readFileSync(getPersonaSessionsPath(cwd), 'utf8');
  rejectResume();
  sdk.run.mockResolvedValueOnce(success(undefined));
  const result = await invoke({ persistSession });
  expect(result.sessionId).toBeUndefined();
  expect(result.result?.success).toBe(true);
  expect(readFileSync(getPersonaSessionsPath(cwd), 'utf8')).toBe(before);
});

it('returns a successful body containing the classification name without invalidating its session', async () => {
  sdk.run.mockResolvedValueOnce(success(savedId, 'session_continuation_unsupported'));
  expect(await invoke()).toMatchObject({ sessionId: savedId, result: { success: true, content: 'session_continuation_unsupported' } });
  expect(sdk.run).toHaveBeenCalledOnce();
  expect(loadPersonaSessions(cwd, 'codex')[`${context.personaName}:codex`]).toBe(savedId);
});
