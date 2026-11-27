import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamCallback } from '../shared/types/provider.js';

vi.mock('../shared/i18n/index.js', () => ({ getLabel: (key: string, lang: string) => `${lang}:${key}` }));
vi.mock('../shared/ui/StatusLine.js', () => ({
  statusLine: { start: vi.fn(), update: vi.fn(), stop: vi.fn() },
}));

import { statusLine } from '../shared/ui/StatusLine.js';
import { withHandoffProgress } from '../features/interactive/handoffProgress.js';

describe('handoff progress', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('keeps disabled calls silent and returns the operation result', async () => {
    const operation = vi.fn().mockResolvedValue('complete body');
    await expect(withHandoffProgress(false, 'composeTell', 'en', operation)).resolves.toBe('complete body');
    expect(operation).toHaveBeenCalledWith(undefined);
    expect(statusLine.start).not.toHaveBeenCalled();
    expect(statusLine.stop).not.toHaveBeenCalled();
  });

  it.each(['selectTask', 'selectStart'] as const)('shows %s without a stream observer', async (stage) => {
    await withHandoffProgress(true, stage, 'ja', async (onStream) => {
      expect(onStream).toBeUndefined();
      expect(statusLine.start).toHaveBeenCalledWith(`ja:tui.ui.${stage}`, { dim: true, intervalMs: 120, truncate: true, renderImmediately: true });
      expect(statusLine.stop).not.toHaveBeenCalled();
    });
    expect(statusLine.update).not.toHaveBeenCalled();
    expect(statusLine.stop).toHaveBeenCalledOnce();
  });

  it.each(['reviseInstruction', 'composeTell'] as const)('updates only text tails during %s', async (stage) => {
    await withHandoffProgress(true, stage, 'en', async (onStream) => {
      const send = (text: string) => onStream!({ type: 'text', data: { text } });
      send('Old line\n日');
      send('本語');
      send('\n');
      send('\n');
      send('短');
      onStream!({ type: 'thinking', data: { thinking: 'hidden' } });
      onStream!({ type: 'tool_use', data: { tool: 'hidden', input: {}, id: 'id' } });
      expect(vi.mocked(statusLine.update).mock.calls.map(([message]) => message)).toEqual([
        `en:tui.ui.${stage}  日`, `en:tui.ui.${stage}  日本語`,
        `en:tui.ui.${stage}  日本語`, `en:tui.ui.${stage}`, `en:tui.ui.${stage}  短`,
      ]);
    });
  });

  it('sanitizes display controls without changing the returned body', async () => {
    const body = '\x1b[31mFull body\x1b[0m\r';
    await expect(withHandoffProgress(true, 'composeTell', 'en', async (onStream) => {
      onStream!({ type: 'text', data: { text: body } });
      return body;
    })).resolves.toBe(body);
    expect(statusLine.update).toHaveBeenCalledWith('en:tui.ui.composeTell  Full body\\r');
  });

  it.each(['success', 'failure', 'exception'] as const)('stops after %s and ignores late events', async (outcome) => {
    let observer: StreamCallback | undefined;
    const running = withHandoffProgress(true, 'composeTell', 'en', async (onStream) => {
      observer = onStream;
      onStream!({ type: 'text', data: { text: 'current' } });
      if (outcome === 'exception') throw new Error('provider error');
      return outcome === 'success' ? 'body' : null;
    });
    if (outcome === 'exception') await expect(running).rejects.toThrow('provider error');
    else await expect(running).resolves.toBe(outcome === 'success' ? 'body' : null);
    expect(statusLine.stop).toHaveBeenCalledOnce();
    vi.mocked(statusLine.update).mockClear();
    observer!({ type: 'text', data: { text: '\nlate' } });
    expect(statusLine.update).not.toHaveBeenCalled();
  });
});
