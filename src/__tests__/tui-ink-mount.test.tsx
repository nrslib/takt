import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountInk, type InkMountOptions } from '../features/tui/inkMount.js';

const { mockRender } = vi.hoisted(() => ({ mockRender: vi.fn() }));

vi.mock('ink', () => ({ render: mockRender }));
vi.mock('../features/tui/terminalOwnership.js', () => ({
  takeTerminalOwnership: () => ({
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
    release: vi.fn(),
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockRender.mockImplementation(() => {
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => { exit = resolve; });
    return {
      waitUntilExit: () => exited,
      waitUntilRenderFlush: async () => undefined,
      clear: vi.fn(),
      unmount: exit,
    };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Settles a minimal mount immediately so tests can inspect its rendering options and teardown. */
function mountWithOptions(options?: InkMountOptions): Promise<string> {
  return mountInk(({ settle }) => {
    settle('done');
    return createElement('span');
  }, 'exited early', undefined, options);
}

describe('mountInk rendering scope', () => {
  it.each([undefined, { anchorLiveFrame: false }])(
    'should keep default rendering without an explicit opt-in (%j)',
    async (options) => {
      vi.stubEnv('TERM_PROGRAM', 'Apple_Terminal');

      await expect(mountWithOptions(options)).resolves.toBe('done');

      const renderOptions = mockRender.mock.calls[0]?.[1];
      expect(renderOptions).toMatchObject({ interactive: true, exitOnCtrlC: false });
      expect(renderOptions).not.toHaveProperty('anchorLiveFrame');
      expect(renderOptions).not.toHaveProperty('reflowsCursorGroup');
    },
  );

  it.each([
    ['Apple_Terminal', true],
    ['iTerm.app', false],
  ])('should use anchored rendering only when requested on %s', async (termProgram, reflowsCursorGroup) => {
    vi.stubEnv('TERM_PROGRAM', termProgram);

    await expect(mountWithOptions({ anchorLiveFrame: true })).resolves.toBe('done');

    expect(mockRender.mock.calls[0]?.[1]).toMatchObject({
      anchorLiveFrame: true,
      reflowsCursorGroup,
    });
  });
});
