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
import type { SessionState } from '../infra/config/project/sessionState.js';
import type { ImageAttachmentStore } from '../features/interactive/imageAttachments.js';

const {
  mockRender,
  mockRenderToString,
  mockCreateTuiConversation,
  mockDetermineWorkflow,
  mockSelectInteractiveMode,
  mockSelectRecentSession,
  mockSelectAction,
  mockDisplayAndClearSessionState,
  mockGetWorkflowDescription,
  mockLoadPersonaSessions,
  mockTakeSessionState,
  mockWatchProcessExit,
  mockReleaseProcessExit,
  storeOverride,
} = vi.hoisted(() => ({
  mockRender: vi.fn(),
  mockRenderToString: vi.fn(),
  mockCreateTuiConversation: vi.fn(),
  mockDetermineWorkflow: vi.fn(),
  mockSelectInteractiveMode: vi.fn(),
  mockSelectRecentSession: vi.fn(),
  mockSelectAction: vi.fn(),
  mockDisplayAndClearSessionState: vi.fn(),
  mockGetWorkflowDescription: vi.fn(),
  mockLoadPersonaSessions: vi.fn(),
  mockTakeSessionState: vi.fn(),
  mockWatchProcessExit: vi.fn(),
  mockReleaseProcessExit: vi.fn(),
  /** Lets one test hand runTui a real store in a temp directory. */
  storeOverride: { current: undefined as ((cwd: string) => unknown) | undefined },
}));

const mockCreateStore = (cwd: string): unknown => storeOverride.current?.(cwd);

vi.mock('ink', () => ({
  render: (...args: unknown[]) => mockRender(...args),
  renderToString: (...args: unknown[]) => mockRenderToString(...args),
  Box: () => null,
  Text: () => null,
  useInput: () => undefined,
  useStdout: () => ({ stdout: undefined }),
  useWindowSize: () => ({ columns: 100, rows: 24 }),
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
    createSessionImageAttachmentStore: (cwd: string) =>
      mockCreateStore(cwd) ?? actual.createSessionImageAttachmentStore(cwd),
  };
});

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/config/index.js')>()),
  getWorkflowDescription: (...args: unknown[]) => mockGetWorkflowDescription(...args),
  loadPersonaSessions: (...args: unknown[]) => mockLoadPersonaSessions(...args),
  takeSessionState: (...args: unknown[]) => mockTakeSessionState(...args),
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
  mockRenderToString.mockReturnValue('final transcript');
  // clearAllMocks keeps implementations, and some cases install a throwing one.
  mockCreateTuiConversation.mockReset();
  // The run talks to the conversation between mounts — a resumed session, a
  // rejected draft — so the double answers that contract by default.
  mockCreateTuiConversation.mockReturnValue({
    resumeSession: vi.fn(),
    recordRejectedDraft: vi.fn(),
    commandAvailability: {},
    tracksResultSource: false,
  });
  mockDetermineWorkflow.mockResolvedValue('default');
  mockSelectInteractiveMode.mockResolvedValue('assistant');
  mockSelectRecentSession.mockResolvedValue(null);
  mockSelectAction.mockResolvedValue('execute');
  mockLoadPersonaSessions.mockReturnValue({});
  mockTakeSessionState.mockReturnValue(null);
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

    tree.conversationProps().onExit({ kind: 'result', result: { action: 'execute', task: 'do it' } }, { history: [], queue: [] });
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
    tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, { history: [], queue: [] });
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

    tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, { history: [], queue: [] });
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
    it('should hold the finalized transcript until Ink clears the live frame', async () => {
      const written = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);
      const entries = [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'answer' },
      ] as const;

      const conversation = tree.conversationProps();
      conversation.finalizeTranscript(entries, 14);

      expect(mockRenderToString).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          props: expect.objectContaining({
            entries,
            userMessageColors: conversation.userMessageColors,
          }),
        }),
        { columns: 14 },
      );
      expect(written.mock.calls.flat().map(String)).not.toContain('final transcript\n');

      conversation.onExit(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        { history: [], queue: [] },
      );
      await run;

      expect(written.mock.calls.flat().map(String)
        .filter((chunk) => chunk === 'final transcript\n')).toHaveLength(1);
    });

    it('should fail after unmount when writing the finalized transcript fails', async () => {
      const failure = new Error('transcript write failed');
      vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
        if (String(chunk) === 'final transcript\n') {
          throw failure;
        }
        return true;
      }) as typeof process.stdout.write);
      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);

      const conversation = tree.conversationProps();
      conversation.finalizeTranscript([{ role: 'user', content: 'question' }], 14);
      conversation.onExit(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        { history: [], queue: [] },
      );

      await expect(run).rejects.toBe(failure);
      expect(tree.unmount).toHaveBeenCalledOnce();
    });

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

      tree.conversationProps().onExit({ kind: 'choose_action', task: 'ship it' }, { history: ['ship it'], queue: [] });

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

      tree.conversationProps().onExit({ kind: 'choose_action', task: 'ship it' }, { history: ['ship it'], queue: [] });
      await waitForMount(tree, 2);

      expect(tree.mounts.count).toBe(2);
      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, { history: [], queue: [] });
      await run;
    });

    it('should mount the conversation again when the action selector continues', async () => {
      const tree = scriptRender();
      mockSelectAction.mockResolvedValue('continue');
      const run = startRun();
      await waitForMount(tree, 1);

      const first = tree.conversationProps();
      expect(first.initialEntries.length).toBeGreaterThan(0);
      first.onExit({ kind: 'choose_action', task: 'ship it' }, { history: ['ship it'], queue: [] });
      await waitForMount(tree, 2);

      expect(tree.mounts.count).toBe(2);
      const second = tree.conversationProps();
      // The transcript is already in the scrollback; printing it again would double it.
      expect(second.initialEntries).toEqual([]);
      expect(second.initialHistory).toEqual(['ship it']);
      expect(second.autoSubmit).toBe(false);
      // The same session object carries the conversation across the remount.
      expect(second.conversation).toBe(first.conversation);
      expect(second.userMessageColors).toBe(first.userMessageColors);

      second.onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, { history: [], queue: [] });
      await run;
    });

    it('should give a rejected /go draft back to the conversation before remounting', async () => {
      const tree = scriptRender();
      const conversation = {
        resumeSession: vi.fn(),
        commandAvailability: {},
        tracksResultSource: true,
        recordRejectedDraft: vi.fn(),
      };
      mockCreateTuiConversation.mockReturnValue(conversation);
      mockSelectAction.mockResolvedValue('continue');
      const run = startRun();
      await waitForMount(tree, 1);

      tree.conversationProps().onExit(
        { kind: 'choose_action', task: 'proposed order', origin: 'go' },
        { history: ['ship it'], queue: [] },
      );
      await waitForMount(tree, 2);

      // The next revision has to start from the draft that was turned down.
      expect(conversation.recordRejectedDraft).toHaveBeenCalledWith('proposed order');

      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, { history: [], queue: [] });
      await run;
    });

    it('should keep a /retry order out of the conversation when it is not confirmed', async () => {
      const tree = scriptRender();
      const conversation = {
        resumeSession: vi.fn(),
        commandAvailability: {},
        tracksResultSource: true,
        recordRejectedDraft: vi.fn(),
      };
      mockCreateTuiConversation.mockReturnValue(conversation);
      mockSelectAction.mockResolvedValue('continue');
      const run = startRun();
      await waitForMount(tree, 1);

      // `/retry` offers the order the task already has; declining it says nothing
      // about the conversation, and recording it would poison the next summary.
      tree.conversationProps().onExit(
        { kind: 'choose_action', task: 'previous order', origin: 'retry' },
        { history: [], queue: [] },
      );
      await waitForMount(tree, 2);

      expect(conversation.recordRejectedDraft).not.toHaveBeenCalled();

      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, { history: [], queue: [] });
      await run;
    });

    it('should record nothing when the selector is left without choosing', async () => {
      const tree = scriptRender();
      const conversation = {
        resumeSession: vi.fn(),
        commandAvailability: {},
        tracksResultSource: true,
        recordRejectedDraft: vi.fn(),
      };
      mockCreateTuiConversation.mockReturnValue(conversation);
      // The selector's own Cancel row resolves to null, which is not a rejected
      // draft — the readline loop records nothing for it either.
      mockSelectAction.mockResolvedValue(null);
      const run = startRun();
      await waitForMount(tree, 1);

      tree.conversationProps().onExit(
        { kind: 'choose_action', task: 'proposed order', origin: 'go' },
        { history: [], queue: [] },
      );
      await waitForMount(tree, 2);

      expect(conversation.recordRejectedDraft).not.toHaveBeenCalled();

      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, { history: [], queue: [] });
      await run;
    });

    it('should carry the command path of a confirmed task only where the mode records it', async () => {
      const tree = scriptRender();
      mockCreateTuiConversation.mockReturnValue({
        resumeSession: vi.fn(),
        commandAvailability: {},
        tracksResultSource: true,
        recordRejectedDraft: vi.fn(),
      });
      mockSelectAction.mockResolvedValue('execute');
      const run = startRun();
      await waitForMount(tree, 1);

      tree.conversationProps().onExit(
        { kind: 'choose_action', task: 'revised order', origin: 'go' },
        { history: [], queue: [] },
      );

      // The caller writes the revised order.md only for a task that came from /go.
      await expect(run).resolves.toEqual({
        kind: 'selected',
        workflowId: 'default',
        result: { action: 'execute', task: 'revised order', source: 'go' },
      });
    });

    it('should leave the command path off for a mode that does not record it', async () => {
      const tree = scriptRender();
      mockSelectAction.mockResolvedValue('execute');
      const run = startRun();
      await waitForMount(tree, 1);

      tree.conversationProps().onExit(
        { kind: 'choose_action', task: 'ship it', origin: 'go' },
        { history: [], queue: [] },
      );

      await expect(run).resolves.toEqual({
        kind: 'selected',
        workflowId: 'default',
        result: { action: 'execute', task: 'ship it' },
      });
    });

    it('should load the chosen session and mount the conversation again', async () => {
      const tree = scriptRender();
      const conversation = { resumeSession: vi.fn(), commandAvailability: {} };
      mockCreateTuiConversation.mockReturnValue(conversation);
      mockSelectRecentSession.mockResolvedValue('session-abc');
      const run = startRun();
      await waitForMount(tree, 1);

      tree.conversationProps().onExit({ kind: 'resume_session' }, { history: ['/resume'], queue: [] });
      await waitForMount(tree, 2);

      expect(mockSelectRecentSession).toHaveBeenCalledWith('/repo', 'en');
      expect(conversation.resumeSession).toHaveBeenCalledWith('session-abc');
      expect(tree.mounts.count).toBe(2);
      expect(tree.conversationProps().initialHistory).toEqual(['/resume']);

      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, { history: [], queue: [] });
      await run;
    });

    it('should keep the session untouched when the picker chooses none', async () => {
      const tree = scriptRender();
      const conversation = { resumeSession: vi.fn(), commandAvailability: {} };
      mockCreateTuiConversation.mockReturnValue(conversation);
      mockSelectRecentSession.mockResolvedValue(null);
      const run = startRun();
      await waitForMount(tree, 1);

      tree.conversationProps().onExit({ kind: 'resume_session' }, { history: [], queue: [] });
      await waitForMount(tree, 2);

      expect(conversation.resumeSession).not.toHaveBeenCalled();
      expect(tree.mounts.count).toBe(2);

      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, { history: [], queue: [] });
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

      tree.conversationProps().onExit({ kind: 'result', result: { action: 'execute', task: 'go' } }, { history: [], queue: [] });
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

      try {
        const tree = scriptRender();
        const run = startRun();
        await waitForMount(tree, 1);
        tree.conversationProps().onExit(
          { kind: 'result', result: { action: 'execute', task: 'go' } },
          { history: [], queue: [] },
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
        // The pasted image travels with the result: the caller passes it to the
        // task it starts, so losing it here would silently drop the attachment.
        expect(finished.result.attachments).toEqual([attachment]);

        finished.result.cleanupAttachments?.();
        finished.result.cleanupAttachments?.();
        expect(mockReleaseProcessExit).toHaveBeenCalledTimes(1);
        expect(process.listeners('exit').filter((listener) => !listenersBefore.includes(listener)))
          .toEqual([]);
      } finally {
        // A failed assertion must not leave the temp directory behind.
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('should release the net when the selection is cancelled before Ink', async () => {
      scriptRender();
      mockDetermineWorkflow.mockResolvedValue(null);

      await expect(startRun()).resolves.toEqual({ kind: 'cancelled' });

      expect(mockWatchProcessExit).toHaveBeenCalledTimes(1);
      expect(mockReleaseProcessExit).toHaveBeenCalledTimes(1);
    });
  });

  describe('resident session', () => {
    it('should run the decision and come back to the same conversation', async () => {
      const tree = scriptRender();
      const dispatch = vi.fn().mockResolvedValue(undefined);
      const conversation = { resumeSession: vi.fn(), commandAvailability: {} };
      mockCreateTuiConversation.mockReturnValue(conversation);
      const run = startRun({ dispatch });
      await waitForMount(tree, 1);

      const first = tree.conversationProps();
      first.onExit({ kind: 'result', result: { action: 'execute', task: 'ship it' } }, { history: ['ship it'], queue: [] });
      await waitForMount(tree, 2);

      expect(dispatch).toHaveBeenCalledExactlyOnceWith(
        'default',
        expect.objectContaining({ action: 'execute', task: 'ship it' }),
      );
      const second = tree.conversationProps();
      // The same session, and the run's own result written into the transcript.
      expect(second.conversation).toBe(first.conversation);
      expect(second.initialEntries.map((entry) => entry.content))
        .toContain('The workflow run finished. Describe the next task, or /cancel to leave.');
      expect(second.initialHistory).toEqual(['ship it']);

      second.onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, { history: [], queue: [] });
      await expect(run).resolves.toMatchObject({ result: { action: 'cancel' } });
    });

    it('should put the line the last mount was writing back into the next one', async () => {
      const tree = scriptRender();
      const dispatch = vi.fn().mockResolvedValue(undefined);
      mockCreateTuiConversation.mockReturnValue({ resumeSession: vi.fn(), commandAvailability: {} });
      const run = startRun({ dispatch });
      await waitForMount(tree, 1);

      const first = tree.conversationProps();
      // Nothing carried into the first mount, and a half-written line out of it.
      expect(first.initialDraft).toBeUndefined();
      first.onExit(
        { kind: 'result', result: { action: 'execute', task: 'ship it' } },
        { history: ['ship it'], queue: [], draft: { text: 'half typed', cursor: 5 } },
      );
      await waitForMount(tree, 2);

      const second = tree.conversationProps();
      expect(second.initialDraft).toEqual({ text: 'half typed', cursor: 5 });

      // An empty prompt carries nothing, and the mount after it starts blank.
      second.onExit({ kind: 'result', result: { action: 'execute', task: 'again' } }, { history: [], queue: [] });
      await waitForMount(tree, 3);
      expect(tree.conversationProps().initialDraft).toBeUndefined();

      tree.conversationProps().onExit(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        { history: [], queue: [] },
      );
      await expect(run).resolves.toMatchObject({ result: { action: 'cancel' } });
    });

    it('should report what the finished run recorded about itself', async () => {
      const tree = scriptRender();
      // The shape the run actually writes (SessionState), so the greeting is
      // built from the same fields a real run leaves behind.
      const sessionState: SessionState = {
        status: 'success',
        workflowName: 'review',
        taskContent: 'ship it',
        timestamp: '2026-01-02T03:04:05.000Z',
      };
      mockTakeSessionState.mockReturnValue(sessionState);
      const run = startRun({ dispatch: vi.fn().mockResolvedValue(undefined) });
      await waitForMount(tree, 1);

      tree.conversationProps()
        .onExit({ kind: 'result', result: { action: 'save_task', task: 'ship it' } }, { history: [], queue: [] });
      await waitForMount(tree, 2);

      const notice = tree.conversationProps().initialEntries.map((entry) => entry.content).join('\n');
      expect(notice).toContain('review');
      // The status and the time it finished are what the banner reports.
      expect(notice).toContain('completed successfully');
      expect(notice).toContain(new Date(sessionState.timestamp).toLocaleString('en-US'));

      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, { history: [], queue: [] });
      await run;
    });

    it('should end the run on cancel without dispatching anything', async () => {
      const tree = scriptRender();
      const dispatch = vi.fn().mockResolvedValue(undefined);
      const run = startRun({ dispatch });
      await waitForMount(tree, 1);

      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, { history: [], queue: [] });

      await expect(run).resolves.toMatchObject({
        kind: 'selected',
        result: { action: 'cancel', task: '' },
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(tree.mounts.count).toBe(1);
    });

    it('should hand the result straight back when no dispatcher was given', async () => {
      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);

      tree.conversationProps().onExit({ kind: 'result', result: { action: 'execute', task: 'go' } }, { history: [], queue: [] });

      await expect(run).resolves.toMatchObject({ result: { action: 'execute', task: 'go' } });
      expect(tree.mounts.count).toBe(1);
    });
  });

  describe('mode setup', () => {
    it('should mark quiet mode for auto-submit only when the run was seeded', async () => {
      const tree = scriptRender();
      mockSelectInteractiveMode.mockResolvedValue('quiet');

      const seeded = startRun({ userMessage: 'ship the login page' });
      await waitForMount(tree, 1);
      expect(tree.conversationProps().autoSubmit).toBe(true);
      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, { history: [], queue: [] });
      await seeded;

      const bare = startRun();
      await waitForMount(tree, 2);
      expect(tree.conversationProps().autoSubmit).toBe(false);
      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, { history: [], queue: [] });
      await bare;
    });

    it('should announce a resumed session and a missing one with --continue', async () => {
      const tree = scriptRender();
      mockLoadPersonaSessions.mockReturnValue({ interactive: { mock: 'saved-session' } });
      const resumed = startRun({ continueSession: true });
      await waitForMount(tree, 1);
      expect(tree.conversationProps().initialEntries.map((entry) => entry.content))
        .toContain('Resuming previous session');
      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, { history: [], queue: [] });
      await resumed;

      mockLoadPersonaSessions.mockReturnValue({});
      const fresh = startRun({ continueSession: true });
      await waitForMount(tree, 2);
      expect(tree.conversationProps().initialEntries.map((entry) => entry.content))
        .toContain('No previous assistant session found. Starting a new session.');
      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, { history: [], queue: [] });
      await fresh;
    });

    it('should stay silent about sessions without --continue', async () => {
      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);

      const contents = tree.conversationProps().initialEntries.map((entry) => entry.content);
      expect(contents).not.toContain('Resuming previous session');
      expect(contents).not.toContain('No previous assistant session found. Starting a new session.');

      tree.conversationProps().onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, { history: [], queue: [] });
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
    }): {
      waitForMount(): Promise<void>;
      exit(): void;
      fail(error: Error): void;
      readonly unmount: ReturnType<typeof vi.fn>;
    } {
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
          .onExit({ kind: 'result', result: { action: 'execute', task: 'go' } }, { history: [], queue: [] }),
        fail: (error: Error) => requireRendered().onExit({ kind: 'failed', error }, { history: [], queue: [] }),
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

      tree.conversationProps().onExit({ kind: 'failed', error: failure }, { history: [], queue: [] });

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
