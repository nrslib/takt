import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractRetrySelectionAgreement } from '../features/interactive/retrySelectionAgreement.js';
import type { SessionContext } from '../features/interactive/aiCaller.js';

const { callAI } = vi.hoisted(() => ({ callAI: vi.fn() }));
vi.mock('../features/interactive/aiCaller.js', () => ({ callAIWithRetry: callAI }));

const context: SessionContext = {
  provider: {} as SessionContext['provider'],
  providerType: 'mock',
  model: undefined,
  lang: 'en',
  personaName: 'assistant',
  sessionId: 'conversation-session',
};
const options = { cwd: '/repo', lang: 'en' as const, history: [], sessionContext: context };

beforeEach(() => {
  callAI.mockReset();
});

describe('extractRetrySelectionAgreement', () => {
  it('does not call a provider when there is no conversation', async () => {
    expect(await extractRetrySelectionAgreement({
      ...options, sessionContext: { ...context, sessionId: undefined },
    })).toBe('');
    expect(callAI).not.toHaveBeenCalled();
  });

  it.each(['en', 'ja'] as const)('extracts a concise agreement from local history without reusing the session in %s', async (lang) => {
    callAI.mockResolvedValueOnce({ result: { success: true, content: '  Restart task-a at root > child > final-gate.  ' } });
    const history = [
      { role: 'user' as const, content: 'Restart task-a at root > child > final-gate.' },
      { role: 'assistant' as const, content: 'Agreed.' },
    ];
    const agreement = await extractRetrySelectionAgreement({ ...options, lang, history });
    expect(agreement).toBe('Restart task-a at root > child > final-gate.');
    const [prompt, , tools, cwd, selectedContext, callOptions] = callAI.mock.calls[0]!;
    expect(JSON.parse(prompt).conversation).toEqual(history);
    expect(cwd).toBe('/repo');
    expect(tools).toEqual([]);
    expect(selectedContext).toMatchObject({
      sessionId: undefined, mcpServers: undefined, taskStateMcpServers: undefined, disableSessionRetry: true,
    });
    expect(callOptions).toMatchObject({
      persistSession: false, permissionMode: 'readonly', internalAgentIsolation: 'strict-readonly',
    });
    expect(context.sessionId).toBe('conversation-session');
  });

  it('uses the existing session only to extract agreement when local history is absent', async () => {
    callAI.mockResolvedValueOnce({ result: { success: true, content: 'Continue task-a.' }, sessionId: 'new-session' });
    expect(await extractRetrySelectionAgreement(options)).toBe('Continue task-a.');
    expect(callAI.mock.calls[0]![4].sessionId).toBe('conversation-session');
    expect(context.sessionId).toBe('conversation-session');
  });

  it.each([
    { result: null, error: 'provider unavailable' },
    { result: { success: false, content: 'provider rejected' } },
    { result: { success: true, content: '   ' } },
  ])('reports unsuccessful extraction instead of substituting the transcript: %j', async (response) => {
    callAI.mockResolvedValueOnce(response);
    await expect(extractRetrySelectionAgreement(options)).rejects.toThrow();
    expect(callAI).toHaveBeenCalledOnce();
  });

  it('propagates provider exceptions without retrying extraction', async () => {
    callAI.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(extractRetrySelectionAgreement(options)).rejects.toThrow('provider unavailable');
    expect(callAI).toHaveBeenCalledOnce();
  });
});
