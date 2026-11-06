import { afterEach, expect, it, vi } from 'vitest';
import type { Options, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import { createManagerTurnExecutor } from '../features/manager/turnExecutor.js';
import { ClaudeProvider } from '../infra/providers/claude.js';
import { createLogger, resetDebugLogger, setVerboseConsole } from '../shared/utils/debug.js';
import { diagnosticLoggingSuppressed } from '../shared/utils/diagnostic-context.js';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../infra/managed-providers/loader.js', () => import('./helpers/managed-sdk.js'));
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>(),
  query: queryMock,
}));

afterEach(() => { resetDebugLogger(); vi.restoreAllMocks(); queryMock.mockReset(); });

it.each([false, true])('delivers permission warnings from a private manager turn without revealing its diagnostics (switch fails: %s)', async (fails) => {
  resetDebugLogger();
  setVerboseConsole(true);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const privateLogger = createLogger('private-provider');
  const init: SDKSystemMessage = {
    type: 'system', subtype: 'init', permissionMode: 'default',
    session_id: 'test-session', uuid: '00000000-0000-4000-8000-000000000001',
    apiKeySource: 'none', claude_code_version: 'test', cwd: '/tmp/project',
    tools: [], mcp_servers: [], model: 'test', slash_commands: [],
    output_style: 'default', skills: [], plugins: [],
  };
  queryMock.mockImplementationOnce(({ options }: { options: Options }) => {
    expect(diagnosticLoggingSuppressed()).toBe(true);
    options.stderr?.('private-provider-stderr');
    privateLogger.info('private-user-text');
    return {
      interrupt: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {
        expect(diagnosticLoggingSuppressed()).toBe(true);
        privateLogger.warn('private-provider-warning');
        if (fails) throw new Error('auto disabled by policy');
      }),
      async *[Symbol.asyncIterator]() {
        yield init;
        expect(diagnosticLoggingSuppressed()).toBe(true);
        privateLogger.error('private-assistant-text');
        yield { type: 'result', subtype: 'success', structured_output: { message: 'private-reply', summary: null } };
      },
    };
  });
  const executor = createManagerTurnExecutor('/tmp/project', {
    ctx: { providerType: 'claude-sdk', provider: new ClaudeProvider(), lang: 'en', model: undefined },
    strategy: { systemPrompt: 'private-system-prompt' },
  });
  expect(await executor.execute({
    prompt: 'private-user-text', sessionId: 'saved-session', abortSignal: new AbortController().signal,
    assignment: undefined, recovery: { context: 'private-business-context', invalidateSession: vi.fn(async () => {}) },
  })).toMatchObject({ message: 'private-reply' });

  const warnings = stderr.mock.calls.map(([chunk]) => String(chunk));
  expect(warnings).toHaveLength(fails ? 2 : 1);
  expect(warnings.every((line) => line.includes('[WARN] [claude-sdk]'))).toBe(true);
  expect(warnings[0]).toContain('requested=bypassPermissions');
  expect(warnings[0]).toContain('actual=default');
  expect(warnings[0]).toContain('target=auto');
  if (fails) expect(warnings[1]).toContain('failed; continuing with default');
  expect(warnings.join('')).not.toContain('private-');
  expect(diagnosticLoggingSuppressed()).toBe(false);
});
