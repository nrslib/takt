/**
 * Tests for the runTui lifecycle contract: the readline selectors run on the
 * bare terminal before and between Ink mounts, the terminal is released around
 * each of them, and the conversation result reaches the caller.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskHistorySummaryItem } from '../features/interactive/interactive-summary-types.js';
import type { ConversationViewProps } from '../features/tui/ConversationView.js';
import type { PassthroughViewProps } from '../features/tui/PassthroughView.js';
import type { RunTuiOptions } from '../features/tui/runTui.js';
import type { ImageAttachmentStore } from '../features/interactive/imageAttachments.js';

const {
  mockRender,
  mockCreateTuiConversation,
  mockDetermineWorkflow,
  mockSelectInteractiveMode,
  mockSelectRecentSession,
  mockSelectAction,
  mockDisplayAndClearSessionState,
  mockGetWorkflowDescription,
  mockLoadPersonaSessions,
  mockWatchProcessExit,
  mockReleaseProcessExit,
  storeOverride,
} = vi.hoisted(() => ({
  mockRender: vi.fn(),
  mockCreateTuiConversation: vi.fn(),
  mockDetermineWorkflow: vi.fn(),
  mockSelectInteractiveMode: vi.fn(),
  mockSelectRecentSession: vi.fn(),
  mockSelectAction: vi.fn(),
  mockDisplayAndClearSessionState: vi.fn(),
  mockGetWorkflowDescription: vi.fn(),
  mockLoadPersonaSessions: vi.fn(),
  mockWatchProcessExit: vi.fn(),
  mockReleaseProcessExit: vi.fn(),
  /** Lets one test hand runTui a real store in a temp directory. */
  storeOverride: { current: undefined as (() => unknown) | undefined },
}));

const mockCreateStore = (...args: unknown[]): unknown => storeOverride.current?.(...args);

vi.mock('ink', () => ({
  render: (...args: unknown[]) => mockRender(...args),
  Box: () => null,
  Static: () => null,
  Text: () => null,
  useInput: () => undefined,
  useStdout: () => ({ stdout: undefined }),
}));

vi.mock('../features/tui/tuiConversation.js', () => ({
  createTuiConversation: (...args: unknown[]) => mockCreateTuiConversation(...args),
}));

vi.mock('../features/tasks/index.js', () => ({
  determineWorkflow: (...args: unknown[]) => mockDetermineWorkflow(...args),
}));

vi.mock('../features/interactive/modeSelection.js', () => ({
  selectInteractiveMode: (...args: unknown[]) => mockSelectInteractiveMode(...args),
}));

vi.mock('../features/interactive/sessionSelector.js', () => ({
  selectRecentSession: (...args: unknown[]) => mockSelectRecentSession(...args),
}));

vi.mock('../features/interactive/conversationLoop.js', () => ({
  displayAndClearSessionState: (...args: unknown[]) => mockDisplayAndClearSessionState(...args),
}));

vi.mock('../features/interactive/interactive-summary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/interactive/interactive-summary.js')>()),
  createPostSummaryActionSelector: () => mockSelectAction,
}));

vi.mock('../features/interactive/imageAttachments.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../features/interactive/imageAttachments.js')>();
  return {
    ...actual,
    // Delegates to the real net so the process listener really is registered,
    // and records the calls so the wiring can be asserted.
    cleanupImageAttachmentStoreOnProcessExit: (store: ImageAttachmentStore) => {
      mockWatchProcessExit(store);
      const release = actual.cleanupImageAttachmentStoreOnProcessExit(store);
      return () => {
        mockReleaseProcessExit();
        release();
      };
    },
    createSessionImageAttachmentStore: (...args: unknown[]) =>
      mockCreateStore?.(...args) ?? actual.createSessionImageAttachmentStore(),
  };
});

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/config/index.js')>()),
  getWorkflowDescription: (...args: unknown[]) => mockGetWorkflowDescription(...args),
  loadPersonaSessions: (...args: unknown[]) => mockLoadPersonaSessions(...args),
}));

import { runTui } from '../features/tui/runTui.js';
import { takeTerminalOwnership } from '../features/tui/terminalOwnership.js';
import { ProviderNotConfiguredError } from '../features/interactive/sessionInitialization.js';

const originalStdoutWrite = process.stdout.write;

/** Ownership can only be taken again once the previous holder released it. */
function expectTerminalReleased(): void {
  const reacquired = takeTerminalOwnership();
  reacquired.release();
}

const TASK_HISTORY: TaskHistorySummaryItem[] = [];

type MountedProps = ConversationViewProps | PassthroughViewProps;

interface MountedTree {
  /** Props of the tree currently mounted; throws before the first mount. */
  props(): MountedProps;
  conversationProps(): ConversationViewProps;
  exitInk(): void;
  readonly mounts: { readonly count: number };
  readonly unmount: ReturnType<typeof vi.fn>;
}

/**
 * Ink double that records each mount. Every mount gets its own exit promise, so
 * a remount behaves like a fresh tree rather than resolving the previous one.
 */
function scriptRender(): MountedTree {
  const mounts = { count: 0 };
  let rendered: MountedProps | undefined;
  let exitInk: (() => void) | undefined;
  const unmount = vi.fn(() => exitInk?.());

  mockRender.mockImplementation((element: { props: MountedProps }) => {
    mounts.count += 1;
    rendered = element.props;
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    exitInk = resolveExit;
    return { unmount, clear: () => undefined, waitUntilExit: () => exited };
  });

  const requireProps = (): MountedProps => {
    if (!rendered) {
      throw new Error('no Ink tree is mounted');
    }
    return rendered;
  };

  return {
    mounts,
    unmount,
    props: requireProps,
    conversationProps: () => {
      const props = requireProps();
      if (!('onExit' in props)) {
        throw new Error('the mounted tree is not the conversation');
      }
      return props;
    },
    exitInk: () => exitInk?.(),
  };
}

function startRun(overrides?: Partial<RunTuiOptions>) {
  const run = runTui({
    cwd: '/repo',
    lang: 'en',
    previewCount: undefined,
    taskHistory: TASK_HISTORY,
    ...overrides,
  });
  // A run can fail before the test attaches its expectation — the selectors are
  // async, so the failure lands during the wait. Marking it handled here keeps
  // that from being reported as an unhandled rejection; the later `rejects`
  // assertion still sees it.
  run.catch(() => undefined);
  return run;
}

/** Waits until the tree the run mounts next is rendered and its props readable. */
async function waitForMount(tree: MountedTree, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (tree.mounts.count >= expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the run never mounted tree #${expected}`);
}

afterEach(() => {
  // A failed teardown test must not leave the process streams swapped.
  process.stdout.write = originalStdoutWrite;
  storeOverride.current = undefined;
});

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations, and some cases install a throwing one.
  mockCreateTuiConversation.mockReset();
  mockDetermineWorkflow.mockResolvedValue('default');
  mockSelectInteractiveMode.mockResolvedValue('assistant');
  mockSelectRecentSession.mockResolvedValue(null);
  mockSelectAction.mockResolvedValue('execute');
  mockLoadPersonaSessions.mockReturnValue({});
  mockGetWorkflowDescription.mockReturnValue({
    name: 'default',
    description: 'default workflow',
    workflowStructure: '1. plan',
    stepPreviews: [],
  });
});

describe('runTui', () => {
  it('should select the workflow and the mode before mounting Ink', async () => {
    const tree = scriptRender();
    const run = startRun();
    await waitForMount(tree, 1);

    expect(mockDetermineWorkflow).toHaveBeenCalledWith('/repo', undefined);
    expect(mockSelectInteractiveMode).toHaveBeenCalledWith(
      'en',
      undefined,
      ['assistant', 'grill-me', 'persona', 'quiet', 'passthrough'],
    );
    // The banner is printed where the readline conversation prints it.
    expect(mockDisplayAndClearSessionState).toHaveBeenCalledWith('/repo', 'en');
    expect(tree.mounts.count).toBe(1);

    tree.conversationProps().onExit({ kind: 'result', result: { action: 'execute', task: 'do it' } }, []);
    await expect(run).resolves.toEqual({
      kind: 'selected',
      workflowId: 'default',
      result: { action: 'execute', task: 'do it' },
    });
    expect(tree.unmount).toHaveBeenCalled();
  });

  it('should pass an explicit workflow through the same selector', async () => {
    const tree = scriptRender();
    mockDetermineWorkflow.mockResolvedValue('review');
    const run = startRun({ workflowId: 'review' });
    await waitForMount(tree, 1);

    expect(mockDetermineWorkflow).toHaveBeenCalledWith('/repo', 'review');
    tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, []);
    await expect(run).resolves.toMatchObject({ workflowId: 'review' });
  });

  it('should report a cancelled workflow selection without mounting Ink', async () => {
    scriptRender();
    mockDetermineWorkflow.mockResolvedValue(null);

    await expect(startRun()).resolves.toEqual({ kind: 'cancelled' });
    expect(mockRender).not.toHaveBeenCalled();
    expect(mockSelectInteractiveMode).not.toHaveBeenCalled();
  });

  it('should report a cancelled mode selection without mounting Ink', async () => {
    scriptRender();
    mockSelectInteractiveMode.mockResolvedValue(null);

    await expect(startRun()).resolves.toEqual({ kind: 'cancelled' });
    expect(mockRender).not.toHaveBeenCalled();
    expect(mockDisplayAndClearSessionState).not.toHaveBeenCalled();
  });

  it('should withhold passthrough when source context would be dropped', async () => {
    const tree = scriptRender();
    const run = startRun({ sourceContext: 'Issue #12 body' });
    await waitForMount(tree, 1);

    expect(mockSelectInteractiveMode).toHaveBeenCalledWith(
      'en',
      undefined,
      ['assistant', 'grill-me', 'persona', 'quiet'],
    );

    tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, []);
    await run;
  });

  it('should mount passthrough without building a conversation', async () => {
    const tree = scriptRender();
    mockSelectInteractiveMode.mockResolvedValue('passthrough');
    const run = startRun({ userMessage: 'seeded' });
    await waitForMount(tree, 1);

    const props = tree.props();
    expect('onDone' in props).toBe(true);
    expect(mockCreateTuiConversation).not.toHaveBeenCalled();
    if (!('onDone' in props)) {
      throw new Error('passthrough was not mounted');
    }
    expect(props.initialText).toBe('seeded');

    props.onDone({ action: 'execute', task: 'seeded' });
    await expect(run).resolves.toMatchObject({ result: { action: 'execute', task: 'seeded' } });
  });

  describe('selectors between mounts', () => {
    it('should run the action selector with Ink unmounted and finish on its choice', async () => {
      const tree = scriptRender();
      mockSelectAction.mockImplementation(() => {
        // The selector owns the bare terminal while it prompts.
        expectTerminalReleased();
        expect(tree.unmount).toHaveBeenCalled();
        return Promise.resolve('save_task');
      });
      const run = startRun();
      await waitForMount(tree, 1);

      tree.conversationProps().onExit({ kind: 'choose_action', task: 'ship it' }, ['ship it']);

      await expect(run).resolves.toEqual({
        kind: 'selected',
        workflowId: 'default',
        result: { action: 'save_task', task: 'ship it' },
      });
      expect(tree.mounts.count).toBe(1);
    });

    it('should mount the conversation again when the action selector is cancelled', async () => {
      const tree = scriptRender();
      // The selector's own Cancel row resolves to null, which the readline loop
      // treats exactly like "Continue editing" (conversationLoop.ts).
      mockSelectAction.mockResolvedValue(null);
      const run = startRun();
      await waitForMount(tree, 1);

      tree.conversationProps().onExit({ kind: 'choose_action', task: 'ship it' }, ['ship it']);
      await waitForMount(tree, 2);

      expect(tree.mounts.count).toBe(2);
      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, []);
      await run;
    });

    it('should mount the conversation again when the action selector continues', async () => {
      const tree = scriptRender();
      mockSelectAction.mockResolvedValue('continue');
      const run = startRun();
      await waitForMount(tree, 1);

      const first = tree.conversationProps();
      expect(first.initialEntries.length).toBeGreaterThan(0);
      first.onExit({ kind: 'choose_action', task: 'ship it' }, ['ship it']);
      await waitForMount(tree, 2);

      expect(tree.mounts.count).toBe(2);
      const second = tree.conversationProps();
      // The transcript is already in the scrollback; printing it again would double it.
      expect(second.initialEntries).toEqual([]);
      expect(second.initialHistory).toEqual(['ship it']);
      expect(second.autoSubmit).toBe(false);
      // The same session object carries the conversation across the remount.
      expect(second.conversation).toBe(first.conversation);

      second.onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, []);
      await run;
    });

    it('should load the chosen session and mount the conversation again', async () => {
      const tree = scriptRender();
      const conversation = { resumeSession: vi.fn(), commandAvailability: {} };
      mockCreateTuiConversation.mockReturnValue(conversation);
      mockSelectRecentSession.mockResolvedValue('session-abc');
      const run = startRun();
      await waitForMount(tree, 1);

      tree.conversationProps().onExit({ kind: 'resume_session' }, ['/resume']);
      await waitForMount(tree, 2);

      expect(mockSelectRecentSession).toHaveBeenCalledWith('/repo', 'en');
      expect(conversation.resumeSession).toHaveBeenCalledWith('session-abc');
      expect(tree.mounts.count).toBe(2);
      expect(tree.conversationProps().initialHistory).toEqual(['/resume']);

      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, []);
      await run;
    });

    it('should keep the session untouched when the picker chooses none', async () => {
      const tree = scriptRender();
      const conversation = { resumeSession: vi.fn(), commandAvailability: {} };
      mockCreateTuiConversation.mockReturnValue(conversation);
      mockSelectRecentSession.mockResolvedValue(null);
      const run = startRun();
      await waitForMount(tree, 1);

      tree.conversationProps().onExit({ kind: 'resume_session' }, []);
      await waitForMount(tree, 2);

      expect(conversation.resumeSession).not.toHaveBeenCalled();
      expect(tree.mounts.count).toBe(2);

      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, []);
      await run;
    });
  });

  describe('temp file safety net', () => {
    it('should watch the process exit while the run owns the pasted images', async () => {
      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);

      // A selector can end the process on Ctrl+C, so the net is armed for the
      // whole run — including the stretches where Ink is unmounted.
      expect(mockWatchProcessExit).toHaveBeenCalledTimes(1);
      expect(mockReleaseProcessExit).not.toHaveBeenCalled();

      tree.conversationProps().onExit({ kind: 'result', result: { action: 'execute', task: 'go' } }, []);
      await run;

      // The caller owns the files now and cleans them up after the task ran.
      expect(mockReleaseProcessExit).toHaveBeenCalledTimes(1);
    });

    it('should keep the net armed until the caller cleans the attachments up', async () => {
      // A real store with a real file, because the point is what survives on disk.
      const { createImageAttachmentStore } = await import('../features/interactive/imageAttachments.js');
      const tmpRoot = mkdtempSync(join(tmpdir(), 'takt-tui-net-'));
      const store = createImageAttachmentStore({ tmpRoot, sessionId: 'session-1' });
      storeOverride.current = () => store;
      const attachment = await store.saveImage(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        'image/png',
      );
      const sessionDir = dirname(dirname(attachment.tempPath));
      const listenersBefore = process.listeners('exit');

      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);
      tree.conversationProps().onExit(
        { kind: 'result', result: { action: 'execute', task: 'go' } },
        [],
      );
      const finished = await run;

      // The caller runs a label selector and the workflow next, and either can
      // end the process, so the net must still be armed after runTui returned.
      expect(mockReleaseProcessExit).not.toHaveBeenCalled();
      const added = process.listeners('exit')
        .filter((listener) => !listenersBefore.includes(listener));
      expect(added).toHaveLength(1);
      (added[0] as () => void)();
      expect(existsSync(sessionDir)).toBe(false);

      // The caller's own attachment cleanup is what finally takes it down.
      if (finished.kind !== 'selected') {
        throw new Error('expected the run to hand a result back');
      }
      finished.result.cleanupAttachments?.();
      finished.result.cleanupAttachments?.();
      expect(mockReleaseProcessExit).toHaveBeenCalledTimes(1);
      expect(process.listeners('exit').filter((listener) => !listenersBefore.includes(listener)))
        .toEqual([]);

      rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('should release the net when the selection is cancelled before Ink', async () => {
      scriptRender();
      mockDetermineWorkflow.mockResolvedValue(null);

      await expect(startRun()).resolves.toEqual({ kind: 'cancelled' });

      expect(mockWatchProcessExit).toHaveBeenCalledTimes(1);
      expect(mockReleaseProcessExit).toHaveBeenCalledTimes(1);
    });
  });

  describe('mode setup', () => {
    it('should mark quiet mode for auto-submit only when the run was seeded', async () => {
      const tree = scriptRender();
      mockSelectInteractiveMode.mockResolvedValue('quiet');

      const seeded = startRun({ userMessage: 'ship the login page' });
      await waitForMount(tree, 1);
      expect(tree.conversationProps().autoSubmit).toBe(true);
      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, []);
      await seeded;

      const bare = startRun();
      await waitForMount(tree, 2);
      expect(tree.conversationProps().autoSubmit).toBe(false);
      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, []);
      await bare;
    });

    it('should announce a resumed session and a missing one with --continue', async () => {
      const tree = scriptRender();
      mockLoadPersonaSessions.mockReturnValue({ interactive: { mock: 'saved-session' } });
      const resumed = startRun({ continueSession: true });
      await waitForMount(tree, 1);
      expect(tree.conversationProps().initialEntries.map((entry) => entry.content))
        .toContain('Resuming previous session');
      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, []);
      await resumed;

      mockLoadPersonaSessions.mockReturnValue({});
      const fresh = startRun({ continueSession: true });
      await waitForMount(tree, 2);
      expect(tree.conversationProps().initialEntries.map((entry) => entry.content))
        .toContain('No previous assistant session found. Starting a new session.');
      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, []);
      await fresh;
    });

    it('should stay silent about sessions without --continue', async () => {
      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);

      const contents = tree.conversationProps().initialEntries.map((entry) => entry.content);
      expect(contents).not.toContain('Resuming previous session');
      expect(contents).not.toContain('No previous assistant session found. Starting a new session.');

      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, []);
      await run;
    });

    it('should localize a missing provider raised while preparing the mode', async () => {
      scriptRender();
      mockCreateTuiConversation.mockImplementation(() => {
        throw new ProviderNotConfiguredError();
      });

      await expect(startRun()).rejects.toThrow(
        'No provider is configured. Set one in ~/.takt/config.yaml or pass --provider.',
      );
      expect(mockRender).not.toHaveBeenCalled();
    });

    it('should keep an unrelated setup failure unchanged', async () => {
      const failure = new Error('workflow file is broken');
      scriptRender();
      mockCreateTuiConversation.mockImplementation(() => {
        throw failure;
      });

      await expect(startRun()).rejects.toBe(failure);
    });
  });

  describe('teardown', () => {
    /** Ink calls that fail at a chosen stage, so each teardown step can be exercised. */
    function scriptFailingRender(failing: {
      readonly render?: Error;
      readonly unmount?: Error;
      readonly waitUntilExit?: Error;
    }): { exit(): void; readonly unmount: ReturnType<typeof vi.fn> } {
      let rendered: ConversationViewProps | undefined;
      let resolveExit!: () => void;
      // Stays pending until the tree is unmounted, so the mount does not read as
      // an early exit while the test is still driving it.
      const exited = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });
      const unmount = vi.fn(() => {
        resolveExit();
        if (failing.unmount) {
          throw failing.unmount;
        }
      });
      // Ink hands out the same promise on every call; a fresh rejected one per
      // call would report a rejection nobody could have handled.
      const exitFailure = failing.waitUntilExit
        ? Promise.reject(failing.waitUntilExit)
        : undefined;
      exitFailure?.catch(() => undefined);
      mockRender.mockImplementation((element: { props: ConversationViewProps }) => {
        if (failing.render) {
          throw failing.render;
        }
        rendered = element.props;
        return {
          unmount,
          clear: () => undefined,
          waitUntilExit: () => exitFailure ?? exited,
        };
      });
      const requireRendered = (): ConversationViewProps => {
        if (!rendered) {
          throw new Error('no Ink tree is mounted');
        }
        return rendered;
      };
      return {
        unmount,
        waitForMount: async () => {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            if (rendered) {
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          throw new Error('the run never mounted');
        },
        exit: () => requireRendered()
          .onExit({ kind: 'result', result: { action: 'execute', task: 'go' } }, []),
        fail: (error: Error) => requireRendered().onExit({ kind: 'failed', error }, []),
      };
    }

    it('should restore the terminal when render itself throws', async () => {
      const failure = new Error('render exploded');
      scriptFailingRender({ render: failure });

      await expect(startRun()).rejects.toBe(failure);
      expectTerminalReleased();
    });

    it('should keep the primary failure when unmount also fails', async () => {
      const primary = new Error('conversation exploded');
      const tree = scriptFailingRender({ unmount: new Error('unmount exploded') });
      const run = startRun();
      await tree.waitForMount();
      tree.fail(primary);

      await expect(run).rejects.toBe(primary);
      expectTerminalReleased();
    });

    it('should surface a teardown failure when the run itself succeeded', async () => {
      const teardownFailure = new Error('unmount exploded');
      const tree = scriptFailingRender({ unmount: teardownFailure });
      const run = startRun();
      await tree.waitForMount();
      tree.exit();

      await expect(run).rejects.toBe(teardownFailure);
      expectTerminalReleased();
    });

    it('should surface a rejected waitUntilExit when nothing else failed', async () => {
      const exitFailure = new Error('exit exploded');
      scriptFailingRender({ waitUntilExit: exitFailure });

      // The rejection ends the mount on its own, so the run is awaited straight
      // away rather than driven through the view.
      await expect(startRun()).rejects.toBe(exitFailure);
      expectTerminalReleased();
    });

    it('should rethrow a failure reported by the conversation', async () => {
      const tree = scriptRender();
      const failure = new Error('provider crashed');
      const run = startRun();
      await waitForMount(tree, 1);

      tree.conversationProps().onExit({ kind: 'failed', error: failure }, []);

      await expect(run).rejects.toBe(failure);
      expect(tree.unmount).toHaveBeenCalled();
      expectTerminalReleased();
    });

    it('should fail instead of hanging when Ink exits before the view settles', async () => {
      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);

      tree.exitInk();

      await expect(run).rejects.toThrow('The TUI exited before the task conversation finished.');
    });
  });
});
