import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSkillPermissionHandler } from '../features/tasks/execute/skillPermissionHandler.js';
import { isInputWaiting } from '../features/tasks/execute/inputWait.js';
import { confirmWithCancel } from '../shared/prompt/confirm.js';

vi.mock('../shared/prompt/confirm.js', () => ({ confirmWithCancel: vi.fn() }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => expect(isInputWaiting()).toBe(false));

describe('Skill permission input', () => {
  it.each([
    { answer: { kind: 'value' as const, value: true }, expected: true },
    { answer: { kind: 'value' as const, value: false }, expected: false },
    { answer: { kind: 'cancelled' as const }, expected: false },
  ])('uses the answer $answer with a deny default', async ({ answer, expected }) => {
    const flush = vi.fn();
    const display = { current: { flush } } as unknown as Parameters<typeof createSkillPermissionHandler>[0];
    vi.mocked(confirmWithCancel).mockImplementation(async () => {
      expect(isInputWaiting()).toBe(true);
      return answer;
    });
    const signal = new AbortController().signal;
    const handler = createSkillPermissionHandler(display, 'en');
    await expect(handler({ patterns: ['probe-repo'] }, signal)).resolves.toBe(expected);
    expect(confirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('["probe-repo"]'), false, signal);
    expect(flush).toHaveBeenCalledOnce();
    expect(display.current).toBeNull();
  });

  it('does not display an already aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createSkillPermissionHandler({ current: null }, 'en')({ patterns: ['cancelled'] }, controller.signal)).resolves.toBe(false);
    expect(confirmWithCancel).not.toHaveBeenCalled();
  });

  it('serializes requests and skips an aborted queued request', async () => {
    let finishFirst!: (answer: { kind: 'value'; value: boolean }) => void;
    vi.mocked(confirmWithCancel)
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ kind: 'value', value: false });
    const handler = createSkillPermissionHandler({ current: null }, 'en');
    const first = handler({ patterns: ['first'] }, new AbortController().signal);
    await Promise.resolve();
    const cancelled = new AbortController();
    const second = handler({ patterns: ['cancelled'] }, cancelled.signal);
    const third = handler({ patterns: ['third'] }, new AbortController().signal);
    cancelled.abort();
    await expect(second).resolves.toBe(false);
    expect(confirmWithCancel).toHaveBeenCalledTimes(1);
    finishFirst({ kind: 'value', value: true });
    await expect(first).resolves.toBe(true);
    await expect(third).resolves.toBe(false);
    expect(confirmWithCancel).toHaveBeenCalledTimes(2);
    expect(vi.mocked(confirmWithCancel).mock.calls[1]![0]).toContain('["third"]');
  });

  it('releases input wait after a failure and accepts the next request', async () => {
    const failure = new Error('input failed');
    vi.mocked(confirmWithCancel).mockRejectedValueOnce(failure).mockResolvedValueOnce({ kind: 'value', value: true });
    const handler = createSkillPermissionHandler({ current: null }, 'en');
    await expect(handler({ patterns: ['first'] }, new AbortController().signal)).rejects.toBe(failure);
    expect(isInputWaiting()).toBe(false);
    await expect(handler({ patterns: ['second'] }, new AbortController().signal)).resolves.toBe(true);
  });

  it('waits for active input cleanup after abort before returning denial', async () => {
    vi.mocked(confirmWithCancel).mockImplementation((_message, _default, signal) => new Promise((resolve) => {
      signal!.addEventListener('abort', () => resolve({ kind: 'cancelled' }), { once: true });
    }));
    const controller = new AbortController();
    const handler = createSkillPermissionHandler({ current: null }, 'en');
    const answer = handler({ patterns: ['active'] }, controller.signal);
    await Promise.resolve();
    expect(isInputWaiting()).toBe(true);
    controller.abort();
    await expect(answer).resolves.toBe(false);
    expect(isInputWaiting()).toBe(false);
  });
});
