/**
 * Tests for runSelector
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn(),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn((key: string) => key),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
}));

vi.mock('../features/interactive/runSessionReader.js', () => ({
  listRecentRuns: vi.fn(),
}));

import { selectOption } from '../shared/prompt/index.js';
import { info } from '../shared/ui/index.js';
import { listRecentRuns } from '../features/interactive/runSessionReader.js';
import { selectRun } from '../features/interactive/runSelector.js';

const mockListRecentRuns = vi.mocked(listRecentRuns);
const mockSelectOption = vi.mocked(selectOption);
const mockInfo = vi.mocked(info);

describe('selectRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return null and show message when no runs exist', async () => {
    mockListRecentRuns.mockReturnValue([]);

    const result = await selectRun('/some/path', 'en');

    expect(result).toBeNull();
    expect(mockInfo).toHaveBeenCalledWith('interactive.runSelector.noRuns');
  });

  it('should present run options and return selected slug', async () => {
    mockListRecentRuns.mockReturnValue([
      { slug: 'run-1', task: 'First task', piece: 'default', status: 'completed', startTime: '2026-02-01T10:00:00Z' },
      { slug: 'run-2', task: 'Second task', piece: 'custom', status: 'aborted', startTime: '2026-01-15T08:00:00Z' },
    ]);
    mockSelectOption.mockResolvedValue('run-1');

    const result = await selectRun('/some/path', 'en');

    expect(result).toBe('run-1');
    expect(mockSelectOption).toHaveBeenCalledTimes(1);

    const callArgs = mockSelectOption.mock.calls[0];
    expect(callArgs[0]).toBe('interactive.runSelector.prompt');
    const options = callArgs[1];
    expect(options).toHaveLength(2);
    expect(options[0].value).toBe('run-1');
    expect(options[0].label).toBe('First task');
    expect(options[1].value).toBe('run-2');
    expect(options[1].label).toBe('Second task');
  });

  it('should return null when user cancels selection', async () => {
    mockListRecentRuns.mockReturnValue([
      { slug: 'run-1', task: 'Task', piece: 'default', status: 'completed', startTime: '2026-02-01T00:00:00Z' },
    ]);
    mockSelectOption.mockResolvedValue(null);

    const result = await selectRun('/some/path', 'en');

    expect(result).toBeNull();
  });

  it('should truncate long task labels', async () => {
    const longTask = 'A'.repeat(100);
    mockListRecentRuns.mockReturnValue([
      { slug: 'run-1', task: longTask, piece: 'default', status: 'completed', startTime: '2026-02-01T00:00:00Z' },
    ]);
    mockSelectOption.mockResolvedValue('run-1');

    await selectRun('/some/path', 'en');

    const options = mockSelectOption.mock.calls[0][1];
    expect(options[0].label.length).toBeLessThanOrEqual(61); // 60 + '…'
  });
});
