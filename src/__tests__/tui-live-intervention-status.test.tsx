import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockInitializeSession, mockMountInk } = vi.hoisted(() => ({
  mockInitializeSession: vi.fn(),
  mockMountInk: vi.fn(),
}));

vi.mock('../features/interactive/sessionInitialization.js', () => ({
  initializeSession: (...args: unknown[]) => mockInitializeSession(...args),
}));

vi.mock('../features/tui/inkMount.js', () => ({
  mountInk: (...args: unknown[]) => mockMountInk(...args),
}));

import { runLiveInterventionMode } from '../features/tasks/list/liveInterventionMode.js';
import { LiveInterventionFileStore } from '../infra/workflow/live-intervention-store.js';

type MountTree = (handlers: {
  readonly settle: (value: unknown) => void;
  readonly fail: (error: unknown) => void;
}) => ReactElement;

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('live intervention status in the mounted TUI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInitializeSession.mockReturnValue({
      provider: { getRuntimeInstructions: () => null, setup: vi.fn() },
      providerType: 'mock',
      model: 'mock-model',
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes the live reader through both TUI runners to one view at the production interval', async () => {
    vi.useFakeTimers();
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-live-status-mode-'));
    const worktreePath = join(projectCwd, '.takt', 'worktrees', 'live-task');
    const runDirectory = join(worktreePath, '.takt', 'runs', 'live-run');
    mkdirSync(join(runDirectory, 'logs'), { recursive: true });
    mkdirSync(join(runDirectory, 'reports'), { recursive: true });
    const metaPath = join(runDirectory, 'meta.json');
    const writeMeta = (currentStep: string, phase: 1 | 2): void => {
      writeFileSync(metaPath, JSON.stringify({
        task: 'running task',
        workflow: 'default',
        runSlug: 'live-run',
        runRoot: '.takt/runs/live-run',
        reportDirectory: '.takt/runs/live-run/reports',
        contextDirectory: '.takt/runs/live-run/context',
        logsDirectory: '.takt/runs/live-run/logs',
        status: 'running',
        startTime: '2026-09-03T00:00:00.000Z',
        currentStep,
        phase,
      }), 'utf8');
    };
    writeMeta('initial', 1);

    const mounted = createDeferred<void>();
    let mountedApp: ReturnType<typeof render> | undefined;
    let settleMounted: ((value: unknown) => void) | undefined;
    let mountSettled = false;
    let liveStatusRefreshIntervalMs: number | undefined;
    mockMountInk.mockImplementation(async (buildTree: MountTree) => {
      let settle!: (value: unknown) => void;
      let fail!: (error: unknown) => void;
      const settled = new Promise<unknown>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      const element = buildTree({ settle, fail });
      liveStatusRefreshIntervalMs = (element.props as {
        readonly liveStatusRefreshIntervalMs?: number;
      }).liveStatusRefreshIntervalMs;
      const app = render(element);
      mountedApp = app;
      settleMounted = (value: unknown) => {
        if (!mountSettled) {
          mountSettled = true;
          settle(value);
        }
      };
      mounted.resolve();
      try {
        return await settled;
      } finally {
        app.unmount();
      }
    });

    const runPromise = runLiveInterventionMode(projectCwd, {
      kind: 'running',
      name: 'live-task',
      createdAt: '2026-09-03T00:00:00.000Z',
      filePath: join(projectCwd, '.takt', 'tasks.yaml'),
      content: 'running task',
      runSlug: 'live-run',
      worktreePath,
      data: { task: 'running task', workflow: 'default', worktree: true },
    });

    try {
      await mounted.promise;
      const app = mountedApp;
      if (app === undefined) {
        throw new Error('TUI was not mounted');
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(app.lastFrame()).toContain('step=initial phase=1 pending=0');

      await new LiveInterventionFileStore(projectCwd, 'live-run').issue('project-side pending instruction');
      writeMeta('updated\u001b]0;terminal-title\u0007-step\nname\tend', 2);
      await vi.advanceTimersByTimeAsync(500);

      expect(liveStatusRefreshIntervalMs).toBe(500);
      expect(app.lastFrame()).toContain('step=updated-step name end phase=2 pending=1');
      expect(app.lastFrame()).not.toContain('\u001b');

      settleMounted?.({
        exit: { kind: 'result', result: { action: 'cancel', task: '' } },
        carried: { history: [], queue: [] },
      });
      await runPromise;
    } finally {
      settleMounted?.({
        exit: { kind: 'result', result: { action: 'cancel', task: '' } },
        carried: { history: [], queue: [] },
      });
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });
});
