import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createManagerTurnExecutor } from '../features/manager/turnExecutor.js';
import { makeProvider } from './test-helpers.js';
import type { Provider, ProviderAgent } from '../infra/providers/types.js';
import type { FormalSpecVerificationResult } from '../features/interactive/formalSpecVerification.js';
import { runFormalSpecVerification, cleanupFormalSpecVerificationArtifacts } from '../features/interactive/formalSpecVerification.js';

vi.mock('../features/interactive/formalSpecVerification.js', () => ({
  runFormalSpecVerification: vi.fn(), cleanupFormalSpecVerificationArtifacts: vi.fn(),
}));
const verification: FormalSpecVerificationResult = { verdict: 'passed', verificationStarted: true,
  quint: { status: 'passed' }, alloy: { status: 'passed' },
  artifacts: { runDirectory: '/repo/.takt/runs/verify-test', specifications: { quint: '/repo/spec.qnt' }, logs: {} } };
const success = { persona: 'manager', status: 'done' as const, timestamp: new Date() };
function fixture(mode = true) {
  const call = vi.fn<ProviderAgent['call']>();
  const setup = vi.fn<Provider['setup']>(() => ({ call }));
  const executor = createManagerTurnExecutor('/repo', { ctx: { provider: makeProvider({ setup }), providerType: 'mock', model: undefined, lang: 'ja' },
    strategy: { systemPrompt: 'manager system prompt' } });
  const input = { prompt: '/verify', sessionId: 'same-conversation', assignment: { kind: 'repository' as const, repositoryDirectory: '/repo' },
    abortSignal: new AbortController().signal, verify: { repositoryDirectory: '/repo', mode, comments: false, modelCheckTimeoutSeconds: 42 },
    recovery: { context: '{"pending":{"specifications":{"quint":"module csv {}"}}}', invalidateSession: vi.fn() } };
  return { call, setup, executor, input };
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(runFormalSpecVerification).mockResolvedValue(verification); });
afterEach(() => { vi.restoreAllMocks(); });
it('uses the interactive checker and returns its result to the same read-only manager session', async () => {
  const f = fixture();
  f.call.mockResolvedValueOnce({ ...success, content: '```quint\nmodule csv {}\n```\n```alloy\nsig CSV {}\n```', sessionId: 'generated' });
  f.call.mockResolvedValueOnce({ ...success, content: '', structuredOutput: { message: '検証を通過しました。', summary: null }, sessionId: 'interpreted' });
  expect(await f.executor.execute(f.input)).toMatchObject({ message: '検証を通過しました。', summary: null, sessionId: 'interpreted' });
  expect(runFormalSpecVerification).toHaveBeenCalledExactlyOnceWith('```quint\nmodule csv {}\n```\n```alloy\nsig CSV {}\n```', '/repo', {
    abortSignal: f.input.abortSignal, modelCheckTimeoutSeconds: 42,
  });
  expect(f.call.mock.calls[0]?.[0]).toContain(f.input.recovery.context);
  expect(f.call.mock.calls[0]?.[1]).toMatchObject({ sessionId: 'same-conversation', internalAgentIsolation: 'strict-readonly' });
  expect(f.call.mock.calls[1]?.[0]).toContain('"verdict": "passed"');
  expect(f.call.mock.calls[1]?.[1]).toMatchObject({ sessionId: 'generated', permissionMode: 'readonly', readonlyFileReadPaths: ['/repo/spec.qnt'] });
  for (const [, options] of f.call.mock.calls) expect(options).not.toHaveProperty('mcpServers');
  expect(cleanupFormalSpecVerificationArtifacts).toHaveBeenCalledExactlyOnceWith(verification);
});
it('returns the interactive unavailable message without calling providers or checkers when disabled', async () => {
  const f = fixture(false);
  expect(await f.executor.execute(f.input)).toMatchObject({ message: '/verify は形式仕様モードでのみ使用できます。', sessionId: 'same-conversation' });
  expect(f.call).not.toHaveBeenCalled(); expect(runFormalSpecVerification).not.toHaveBeenCalled();
});
it('does not verify a normal proposal automatically', async () => {
  const f = fixture(); const { verify: _verify, ...input } = f.input;
  f.call.mockResolvedValueOnce({ ...success, content: '', structuredOutput: { message: '登録案です。', summary: null } });
  await f.executor.execute(input);
  expect(runFormalSpecVerification).not.toHaveBeenCalled();
});
it('cleans successful artifacts even when interpretation fails', async () => {
  const f = fixture();
  f.call.mockResolvedValueOnce({ ...success, content: '```quint\nmodule csv {}\n```' });
  f.call.mockRejectedValueOnce(new Error('interpretation failed'));
  const result = await f.executor.execute(f.input);
  expect(result.message).toContain('interpretation failed');
  expect(result.message).toContain('"verdict": "passed"');
  expect(cleanupFormalSpecVerificationArtifacts).toHaveBeenCalledExactlyOnceWith(verification);
});
it('returns checker startup diagnostics without asking the manager to interpret an unstarted verification', async () => {
  const f = fixture();
  vi.mocked(runFormalSpecVerification).mockResolvedValue({ ...verification, verdict: 'error', verificationStarted: false, artifacts: undefined, message: 'No specification blocks' });
  f.call.mockResolvedValueOnce({ ...success, content: 'No formal model', sessionId: 'generated' });
  expect(await f.executor.execute(f.input)).toMatchObject({ message: 'No formal model\n\nNo specification blocks', sessionId: 'generated' });
  expect(f.call).toHaveBeenCalledTimes(1);
});
it('reports retained artifacts for a counterexample', async () => {
  const f = fixture();
  vi.mocked(runFormalSpecVerification).mockResolvedValue({ ...verification, verdict: 'failed', artifactRetention: { status: 'passed' } });
  f.call.mockResolvedValueOnce({ ...success, content: '```quint\nmodule csv {}\n```' });
  f.call.mockResolvedValueOnce({ ...success, content: '', structuredOutput: { message: '反例が見つかりました。', summary: null } });
  expect((await f.executor.execute(f.input)).message).toContain('検証の仕様とログを保持しました: /repo/.takt/runs/verify-test');
});
it('does not start checkers after cancellation during generation', async () => {
  const f = fixture(); const controller = new AbortController();
  f.call.mockImplementationOnce(async () => { controller.abort(); return { ...success, content: '```quint\nmodule csv {}\n```' }; });
  await expect(f.executor.execute({ ...f.input, abortSignal: controller.signal })).rejects.toThrow();
  expect(runFormalSpecVerification).not.toHaveBeenCalled();
});


it.each([true, false])('uses manager-only generation guidance with comments=%s', async (comments) => {
  const f = fixture();
  f.input.verify.comments = comments;
  f.call.mockResolvedValueOnce({ ...success, content: '```quint\nmodule csv {}\n```' });
  f.call.mockResolvedValueOnce({ ...success, content: '', structuredOutput: { message: '検証結果', summary: null } });
  await f.executor.execute(f.input);
  const prompt = f.setup.mock.calls[1]![0].systemPrompt!;
  expect(prompt).toContain('このゴールでは Quint と Alloy の両方を常に含める。');
  expect(prompt).not.toContain('タスクがその記法ではどうしても表現できない場合にだけ');
  expect(prompt.includes('Quint と Alloy の各コードブロック内では')).toBe(comments);
});


it('keeps provider calls in the conversation directory while verifying another repository', async () => {
  const f = fixture();
  vi.mocked(runFormalSpecVerification).mockResolvedValue({ ...verification, artifacts: {
    runDirectory: '/other/.takt/runs/verify-test', specifications: { quint: '/other/spec.qnt' }, logs: {},
  } });
  f.call.mockResolvedValueOnce({ ...success, content: '```quint\nmodule csv {}\n```', sessionId: 'generated' });
  f.call.mockResolvedValueOnce({ ...success, content: '', structuredOutput: { message: '検証結果', summary: null } });
  await f.executor.execute({ ...f.input, verify: { ...f.input.verify, repositoryDirectory: '/other' } });
  expect(f.setup.mock.calls[1]![0].systemPrompt).toContain('"/other"');
  for (const [, options] of f.call.mock.calls) expect(options).toMatchObject({ cwd: '/repo', callerManagedSession: true });
  expect(f.call.mock.calls[1]![1].readonlyFileReadPaths).toEqual(['/other/spec.qnt']);
  expect(runFormalSpecVerification).toHaveBeenCalledWith(expect.any(String), '/other', expect.objectContaining({ modelCheckTimeoutSeconds: 42 }));
});

it.each([
  { verdict: 'failed', failure: 'call' }, { verdict: 'error', failure: 'call' },
  { verdict: 'failed', failure: 'response' }, { verdict: 'error', failure: 'response' },
  { verdict: 'failed', failure: 'parse' }, { verdict: 'error', failure: 'parse' },
] as const)('returns the $verdict checker result and retained artifacts when interpretation fails during $failure', async ({ verdict, failure }) => {
  const f = fixture();
  const result: FormalSpecVerificationResult = { ...verification, verdict,
    quint: { status: verdict, message: verdict === 'failed' ? 'invCSV violated' : 'Quint execution failed' }, artifactRetention: { status: 'passed' } };
  vi.mocked(runFormalSpecVerification).mockResolvedValue(result);
  f.call.mockResolvedValueOnce({ ...success, content: '```quint\nmodule csv {}\n```', sessionId: 'generated' });
  if (failure === 'call') f.call.mockRejectedValueOnce(new Error('interpretation failed'));
  else if (failure === 'response') f.call.mockResolvedValueOnce({ ...success, status: 'error', content: '', error: 'interpretation failed' });
  else f.call.mockResolvedValueOnce({ ...success, content: '', structuredOutput: { message: '', summary: null }, sessionId: 'interpreted' });
  const output = await f.executor.execute(f.input);
  expect(output.summary).toBeNull(); expect(output.assignment).toEqual(f.input.assignment);
  expect(output.sessionId).toBe(failure === 'parse' ? 'interpreted' : 'generated');
  const serialized = output.message.match(/```json\n([\s\S]*?)\n```/);
  expect(serialized).not.toBeNull();
  expect(JSON.parse(serialized![1]!)).toEqual(result);
  expect(output.message).toContain('/repo/.takt/runs/verify-test');
  expect(output.message).toContain('検証の仕様とログを保持しました');
  expect(runFormalSpecVerification).toHaveBeenCalledTimes(1);
  expect(cleanupFormalSpecVerificationArtifacts).toHaveBeenCalledExactlyOnceWith(result);
});

it.each(['passed', 'failed', 'error'] as const)('returns the completed %s checker result when interpretation is cancelled', async (verdict) => {
  const f = fixture(); const controller = new AbortController();
  const result: FormalSpecVerificationResult = { ...verification, verdict, quint: { status: verdict }, artifactRetention: { status: 'passed' } };
  vi.mocked(runFormalSpecVerification).mockResolvedValue(result);
  f.call.mockResolvedValueOnce({ ...success, content: '```quint\nmodule csv {}\n```' });
  f.call.mockImplementationOnce(async () => {
    controller.abort(); throw new Error('cancelled');
  });
  const output = await f.executor.execute({ ...f.input, abortSignal: controller.signal });
  expect(JSON.parse(output.message.match(/```json\n([\s\S]*?)\n```/)![1]!)).toEqual(result);
  if (verdict !== 'passed') expect(output.message).toContain(result.artifacts!.runDirectory);
  expect(cleanupFormalSpecVerificationArtifacts).toHaveBeenCalledExactlyOnceWith(result);
});

it('recovers a rejected generation session before verifying and interpreting in the fresh session', async () => {
  const f = fixture();
  f.call.mockResolvedValueOnce({ ...success, status: 'error', content: '', error: 'cannot resume', failureCategory: 'session_continuation_unsupported' });
  f.call.mockImplementationOnce(async (prompt, options) => {
    expect(f.input.recovery.invalidateSession).toHaveBeenCalledOnce();
    expect(prompt).toContain(f.input.recovery.context);
    expect(options).toMatchObject({ cwd: '/repo', sessionId: undefined, callerManagedSession: true });
    return { ...success, content: '```quint\nmodule csv {}\n```', sessionId: 'fresh' };
  });
  f.call.mockResolvedValueOnce({ ...success, content: '', structuredOutput: { message: '検証結果', summary: null }, sessionId: 'interpreted' });
  expect(await f.executor.execute(f.input)).toMatchObject({ sessionId: 'interpreted' });
  expect(f.call.mock.calls[0]![1].sessionId).toBe('same-conversation');
  expect(f.call.mock.calls[2]![1].sessionId).toBe('fresh');
  expect(runFormalSpecVerification).toHaveBeenCalledOnce();
  expect(f.call).toHaveBeenCalledTimes(3);
});

it('does not reuse a rejected generation session when the fresh response has no session ID', async () => {
  const f = fixture();
  f.call.mockResolvedValueOnce({ ...success, status: 'error', content: '', failureCategory: 'session_continuation_unsupported' });
  f.call.mockResolvedValueOnce({ ...success, content: '```quint\nmodule csv {}\n```' });
  f.call.mockResolvedValueOnce({ ...success, content: '', structuredOutput: { message: '検証結果', summary: null } });
  expect((await f.executor.execute(f.input)).sessionId).toBeUndefined();
  expect(f.call.mock.calls[2]![1].sessionId).toBeUndefined();
});

it.each(['generic', 'second-rejection', 'tool-use', 'cancelled'] as const)('does not replay specification generation after %s', async (failure) => {
  const f = fixture();
  const controller = new AbortController();
  f.call.mockImplementationOnce(async (_prompt, options) => {
    if (failure === 'cancelled') controller.abort();
    if (failure === 'tool-use') options.onStream?.({ type: 'tool_use', data: { id: 'read', tool: 'Read', input: {} } });
    return { ...success, status: 'error', content: '',
      ...(failure === 'generic' ? {} : { failureCategory: 'session_continuation_unsupported' as const }) };
  });
  f.call.mockResolvedValueOnce({ ...success, status: 'error', content: '', failureCategory: 'session_continuation_unsupported' });
  await expect(f.executor.execute({ ...f.input, abortSignal: controller.signal })).rejects.toThrow();
  expect(f.call).toHaveBeenCalledTimes(failure === 'second-rejection' ? 2 : 1);
  expect(runFormalSpecVerification).not.toHaveBeenCalled();
});
