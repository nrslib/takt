import { afterEach, describe, expect, it, vi } from 'vitest';
import * as githubPr from '../infra/github/pr.js';
import { stripAnsi } from '../shared/utils/text.js';

const { mockResolveConfigValue, mockLogError } = vi.hoisted(() => ({
  mockResolveConfigValue: vi.fn<(...args: unknown[]) => unknown>(),
  mockLogError: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValue: (...args: unknown[]) => Reflect.apply(mockResolveConfigValue, undefined, args),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/utils/index.js')>();
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: mockLogError }),
  };
});

import { runLinkedCacciaSafely } from '../features/caccia/index.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('linked Caccia guard', () => {
  it('does not resolve PR identity or start Caccia when the setting is disabled', async () => {
    mockResolveConfigValue.mockReturnValue({ enabled: false });

    await expect(runLinkedCacciaSafely(
      '/project',
      'https://gitlab.com/org/repo/-/merge_requests/42',
    )).resolves.toBeUndefined();

    expect(mockResolveConfigValue).toHaveBeenCalledTimes(1);
    expect(mockResolveConfigValue).toHaveBeenCalledWith('/project', 'caccia');
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('skips a non-GitHub PR before parsing its URL without changing the parent result', async () => {
    mockResolveConfigValue.mockImplementation((_projectCwd: unknown, key: unknown) => {
      if (key === 'caccia') {
        return { enabled: true };
      }
      return key === 'vcsProvider' ? 'gitlab' : undefined;
    });

    await expect(runLinkedCacciaSafely(
      '/project',
      'https://gitlab.com/org/repo/-/merge_requests/42',
    )).resolves.toBeUndefined();

    expect(mockResolveConfigValue).toHaveBeenCalledWith('/project', 'vcsProvider');
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it.each(['terminal', 'silent'] as const)('handles linked errors using the parent %s display without throwing', async (outputMode) => {
    mockResolveConfigValue.mockImplementation((_cwd: unknown, key: unknown) =>
      key === 'caccia' ? { enabled: true, waitTimeoutMs: 100 } : key === 'vcsProvider' ? 'github' : undefined);
    const statusSpy = vi.spyOn(githubPr, 'fetchCodeRabbitReviewStatus').mockRejectedValue(new Error('review lookup failed'));
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { chunks.push(String(chunk)); return true; });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { chunks.push(String(chunk)); return true; });
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { chunks.push(args.join(' ') + '\n'); });
    const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { chunks.push(args.join(' ') + '\n'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { chunks.push(args.join(' ') + '\n'); });
    const controller = new AbortController();
    const display = { outputMode, taskPrefix: 'parent-task', taskDisplayLabel: 'parent-display-label', taskColorIndex: 2 };
    try {
      await expect(Reflect.apply(runLinkedCacciaSafely, undefined, [
        '/project', 'https://github.com/org/repo/pull/42', controller.signal, display,
      ])).resolves.toBeUndefined();
      expect(mockLogError).toHaveBeenCalledOnce();
      expect(statusSpy.mock.calls[0]?.[3]).toBe(controller.signal);
      if (outputMode === 'silent') {
        expect(chunks.join('')).toBe('');
      } else {
        const lines = stripAnsi(chunks.join('')).split('\n').filter((line) => line.trim() !== '');
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) expect(line).toMatch(/^\[parent-display-label\]/u);
        expect(lines.some((line) => /fail|失敗/iu.test(line))).toBe(true);
      }
    } finally { statusSpy.mockRestore(); stdout.mockRestore(); stderr.mockRestore(); log.mockRestore(); error.mockRestore(); warn.mockRestore(); }
  });
});
