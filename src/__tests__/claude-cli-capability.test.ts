import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

const {
  assertClaudeSkillsDisableSupported,
  ClaudeCliCapabilityAbortError,
} = await import('../infra/claude/cli-capability.js');

async function expectCapabilityAbort(
  pending: Promise<void>,
  expectedReason: unknown,
): Promise<void> {
  const error = await pending.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(ClaudeCliCapabilityAbortError);
  expect((error as InstanceType<typeof ClaudeCliCapabilityAbortError>).reason)
    .toBe(expectedReason);
}

describe('Claude Skills CLI capability', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('allows a Claude executable that advertises --disable-slash-commands', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '--disable-slash-commands', '');
    });

    await expect(assertClaudeSkillsDisableSupported('claude-supported')).resolves.toBeUndefined();
    expect(execFileMock).toHaveBeenCalledWith(
      'claude-supported',
      ['--help'],
      expect.objectContaining({
        maxBuffer: 1024 * 1024,
        timeout: 5_000,
        killSignal: 'SIGTERM',
        signal: expect.any(AbortSignal),
      }),
      expect.any(Function),
    );
  });

  it('rejects a Claude executable that does not advertise --disable-slash-commands', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '--help', '');
    });

    await expect(assertClaudeSkillsDisableSupported('claude-unsupported'))
      .rejects.toThrow(/--disable-slash-commands.*2\.1\.220/i);
  });

  it.each(['ENOENT', 'EACCES'])('propagates a %s failure to start the Claude executable', async (code) => {
    const error = Object.assign(new Error(`spawn claude-missing ${code}`), { code });
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(error, '', '');
    });

    await expect(assertClaudeSkillsDisableSupported(`claude-missing-${code}`)).rejects.toBe(error);
  });

  it('shares an in-flight probe for concurrent calls and caches successful checks', async () => {
    let completeProbe: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      completeProbe = callback;
    });

    const first = assertClaudeSkillsDisableSupported('claude-concurrent');
    const second = assertClaudeSkillsDisableSupported('claude-concurrent');

    expect(execFileMock).toHaveBeenCalledOnce();
    completeProbe?.(null, '--disable-slash-commands', '');
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

    await assertClaudeSkillsDisableSupported('claude-concurrent');
    expect(execFileMock).toHaveBeenCalledOnce();
  });

  it('probes each executable independently', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '--disable-slash-commands', '');
    });

    await assertClaudeSkillsDisableSupported('claude-first-path');
    await assertClaudeSkillsDisableSupported('claude-second-path');

    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('does not start a probe for an already-aborted caller', async () => {
    const controller = new AbortController();
    const abortReason = new Error('pre-aborted caller');
    controller.abort(abortReason);

    await expectCapabilityAbort(
      assertClaudeSkillsDisableSupported('claude-pre-aborted', controller.signal),
      abortReason,
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('aborts a caller and cancels the probe after its final waiter leaves', async () => {
    const controller = new AbortController();
    execFileMock.mockImplementation((_file, _args, options, callback) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        callback(error, '', '');
      }, { once: true });
    });

    const abortReason = new Error('test abort');
    const pending = assertClaudeSkillsDisableSupported('claude-abort', controller.signal);
    controller.abort(abortReason);

    await expectCapabilityAbort(pending, abortReason);
  });

  it('keeps a shared probe running while another caller is still waiting', async () => {
    const firstController = new AbortController();
    let completeProbe: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
    let probeSignal: AbortSignal | undefined;
    execFileMock.mockImplementation((_file, _args, options, callback) => {
      probeSignal = options.signal;
      completeProbe = callback;
    });

    const first = assertClaudeSkillsDisableSupported('claude-shared-abort', firstController.signal);
    const second = assertClaudeSkillsDisableSupported('claude-shared-abort');
    const abortReason = new Error('first caller aborted');
    firstController.abort(abortReason);

    await expectCapabilityAbort(first, abortReason);
    expect(probeSignal?.aborted).toBe(false);
    completeProbe?.(null, '--disable-slash-commands', '');
    await expect(second).resolves.toBeUndefined();
  });

  it('retries after a failed probe', async () => {
    const failure = new Error('probe failed');
    execFileMock
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(failure, '', '');
      })
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(null, '--disable-slash-commands', '');
      });

    await expect(assertClaudeSkillsDisableSupported('claude-retry')).rejects.toBe(failure);
    await expect(assertClaudeSkillsDisableSupported('claude-retry')).resolves.toBeUndefined();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});
