import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFile, mockPlatform } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockPlatform: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('node:os', () => ({
  platform: mockPlatform,
}));

import { sendNotification } from '../shared/utils/notification.js';

describe('sendNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('macOS notifications invoke osascript without shell interpolation', () => {
    mockPlatform.mockReturnValue('darwin');

    sendNotification({
      title: 'build "done"',
      message: "step 'review' finished",
      subtitle: 'team "alpha"',
      sound: 'success',
    });

    expect(mockExecFile).toHaveBeenCalledWith(
      'osascript',
      [
        '-e',
        expect.stringContaining(`display notification "step 'review' finished"`),
      ],
      expect.any(Function),
    );
  });

  it('Linux notifications pass title and message as separate arguments', () => {
    mockPlatform.mockReturnValue('linux');

    sendNotification({
      title: "title'; rm -rf /",
      message: 'body $(whoami)',
      sound: 'error',
    });

    expect(mockExecFile).toHaveBeenCalledWith(
      'notify-send',
      ['-u', 'critical', "title'; rm -rf /", 'body $(whoami)'],
      expect.any(Function),
    );
  });
});
