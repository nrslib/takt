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
import type { RunTuiOptions } from '../features/tui/runTui.js';
import type { SessionState } from '../infra/config/project/sessionState.js';
import type { ImageAttachmentStore } from '../features/interactive/imageAttachments.js';

const {
  mockRender,
  mockCreateTuiConversation,
  mockDetermineWorkflow,
  mockSelectInteractiveMode,
  mockSelectInteractiveProvider,
  mockSelectRecentSession,
  mockSelectAction,
  mockDisplayAndClearSessionState,
  mockGetWorkflowDescription,
  mockLoadPersonaSessions,
  mockTakeSessionState,
  mockResolveAssistantProviderModel,
  mockWatchProcessExit,
  mockReleaseProcessExit,
  storeOverride,
  realTuiConversation,
} = vi.hoisted(() => ({
  mockRender: vi.fn(),
  mockCreateTuiConversation: vi.fn(),
  mockDetermineWorkflow: vi.fn(),
  mockSelectInteractiveMode: vi.fn(),
  mockSelectInteractiveProvider: vi.fn(),
  mockSelectRecentSession: vi.fn(),
  mockSelectAction: vi.fn(),
  mockDisplayAndClearSessionState: vi.fn(),
  mockGetWorkflowDescription: vi.fn(),
  mockLoadPersonaSessions: vi.fn(),
  mockTakeSessionState: vi.fn(),
  mockResolveAssistantProviderModel: vi.fn(),
  mockWatchProcessExit: vi.fn(),
  mockReleaseProcessExit: vi.fn(),
  /** Lets one test hand runTui a real store in a temp directory. */
  storeOverride: { current: undefined as ((cwd: string) => unknown) | undefined },
  /** Lets persistence coverage use the production conversation/session factory. */
  realTuiConversation: { current: false },
}));

const mockCreateStore = (cwd: string): unknown => storeOverride.current?.(cwd);

vi.mock('ink', () => ({
  render: (...args: unknown[]) => mockRender(...args),
  Box: () => null,
  Static: () => null,
  Text: () => null,
  useInput: () => undefined,
  useStdout: () => ({ stdout: undefined }),
}));

vi.mock('../features/tui/tuiConversation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../features/tui/tuiConversation.js')>();
  return {
    ...actual,
    createTuiConversation: (...args: Parameters<typeof actual.createTuiConversation>) =>
      realTuiConversation.current
        ? actual.createTuiConversation(...args)
        : mockCreateTuiConversation(...args),
  };
});

vi.mock('../features/tasks/index.js', () => ({
  determineWorkflow: (...args: unknown[]) => mockDetermineWorkflow(...args),
}));

vi.mock('../features/interactive/modeSelection.js', () => ({
  selectInteractiveMode: (...args: unknown[]) => mockSelectInteractiveMode(...args),
}));

vi.mock('../features/interactive/providerSelection.js', () => ({
  selectInteractiveProvider: (...args: unknown[]) => mockSelectInteractiveProvider(...args),
}));

vi.mock('../features/interactive/assistantConfig.js', () => ({
  resolveAssistantProviderModel: (...args: unknown[]) => mockResolveAssistantProviderModel(...args),
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

type MountedProps = ConversationViewProps;

interface MountedTree {
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

function createConversationDouble(overrides: Record<string, unknown> = {}) {
  return {
    lang: 'en' as const,
    commandAvailability: {},
    tracksResultSource: false,
    isCommandLine: vi.fn(() => false),
    resolveLocalCommand: vi.fn(() => null),
    submit: vi.fn().mockResolvedValue({ kind: 'assistant_response', content: 'answer' }),
    createInstruction: vi.fn().mockResolvedValue({
      kind: 'task_instruction',
      task: 'instruction',
      origin: 'go',
      notices: [],
    }),
    resumeSession: vi.fn(),
    recordRejectedDraft: vi.fn(),
    snapshotHistory: vi.fn(() => []),
    setEffort: vi.fn(),
    pasteClipboardImage: vi.fn(),
    sealImages: vi.fn(),
    saveInlineImage: vi.fn(),
    ...overrides,
  };
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
  realTuiConversation.current = false;
});

beforeEach(() => {
  vi.clearAllMocks();
  realTuiConversation.current = false;
  // clearAllMocks keeps implementations, and some cases install a throwing one.
  mockCreateTuiConversation.mockReset();
  // The run talks to the conversation between mounts — a resumed session, a
  // rejected draft — so the double answers that contract by default.
  mockCreateTuiConversation.mockReturnValue(createConversationDouble());
  mockDetermineWorkflow.mockResolvedValue('default');
  mockSelectInteractiveMode.mockResolvedValue('assistant');
  mockSelectInteractiveProvider.mockResolvedValue('mock');
  mockResolveAssistantProviderModel.mockImplementation((
    _cwd: string,
    overrides?: { provider?: string; model?: string },
  ) => ({
    runtimeManaged: false,
    provider: overrides?.provider ?? 'mock',
    model: overrides?.model ?? 'mock-model',
  }));
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
      ['assistant', 'grill-me', 'persona'],
    );
    // The banner is printed where the readline conversation prints it.
    expect(mockDisplayAndClearSessionState).toHaveBeenCalledWith('/repo', 'en');
    expect(tree.mounts.count).toBe(1);
    const intro = tree.conversationProps().initialEntries.map((entry) => entry.content).join('\n');
    for (const command of ['/workflow', '/mode', '/provider', '/model <value>', '/effort <value>']) {
      expect(intro).toContain(command);
    }

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

  describe('interactive setting handoffs', () => {
    const submitInput = () => ({
      text: 'continue with the task',
      abortSignal: new AbortController().signal,
      onAssistantChunk: vi.fn(),
    });

    describe.each(['workflow', 'mode', 'provider'] as const)('/%s selector cancellation', (id) => {
      it('should preserve the active conversation and carried input state', async () => {
        const initial = createConversationDouble();
        mockCreateTuiConversation.mockReturnValue(initial);
        const tree = scriptRender();
        const run = startRun();
        await waitForMount(tree, 1);

        if (id === 'workflow') {
          mockDetermineWorkflow.mockResolvedValueOnce(null);
        } else if (id === 'mode') {
          mockSelectInteractiveMode.mockResolvedValueOnce(null);
        } else {
          mockSelectInteractiveProvider.mockResolvedValueOnce(null);
        }
        tree.conversationProps().onExit(
          { kind: 'handoff', id },
          { history: ['prior input'], queue: ['queued input'] },
        );
        await waitForMount(tree, 2);

        if (id === 'workflow') {
          expect(mockDetermineWorkflow).toHaveBeenCalledTimes(2);
          expect(mockDetermineWorkflow).toHaveBeenLastCalledWith('/repo', undefined);
        } else if (id === 'mode') {
          expect(mockSelectInteractiveMode).toHaveBeenCalledTimes(2);
          expect(mockSelectInteractiveMode).toHaveBeenLastCalledWith(
            'en',
            ['assistant', 'grill-me', 'persona'],
          );
        } else {
          expect(mockSelectInteractiveProvider).toHaveBeenCalledTimes(1);
          expect(mockSelectInteractiveProvider).toHaveBeenCalledWith('en', 'mock');
        }
        expect(mockCreateTuiConversation).toHaveBeenCalledTimes(1);
        expect(initial.snapshotHistory).not.toHaveBeenCalled();
        expect(tree.conversationProps().initialHistory).toEqual(['prior input']);
        expect(tree.conversationProps().initialQueue).toEqual(['queued input']);
        await tree.conversationProps().conversation.submit(submitInput());
        expect(initial.submit).toHaveBeenCalledTimes(1);

        tree.conversationProps().onExit(
          { kind: 'result', result: { action: 'cancel', task: '' } },
          { history: [], queue: [] },
        );
        await run;
      });
    });

    it('should defer a mode switch until the next message and preserve the workflow', async () => {
      const history = [
        { role: 'user', content: 'add auth' },
        { role: 'assistant', content: 'Which method?' },
      ];
      const first = createConversationDouble({ snapshotHistory: vi.fn(() => history) });
      const second = createConversationDouble();
      mockCreateTuiConversation
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second);
      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);

      expect(mockCreateTuiConversation).toHaveBeenCalledWith(expect.objectContaining({
        enableSettingsCommands: true,
      }));

      mockSelectInteractiveMode.mockResolvedValue('grill-me');
      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'mode' },
        { history: ['/mode'], queue: [] },
      );
      await waitForMount(tree, 2);

      expect(mockSelectInteractiveMode).toHaveBeenLastCalledWith(
        'en',
        ['assistant', 'grill-me', 'persona'],
      );
      expect(mockCreateTuiConversation).toHaveBeenCalledTimes(1);

      await tree.conversationProps().conversation.submit(submitInput());

      expect(mockCreateTuiConversation).toHaveBeenCalledTimes(2);
      expect(mockCreateTuiConversation.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        workflowContext: expect.objectContaining({ name: 'default' }),
        handoffHistory: history,
      }));
      expect(second.submit).toHaveBeenCalledTimes(1);

      tree.conversationProps().onExit(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        { history: [], queue: [] },
      );
      await run;
    });

    it('should apply only the final mode after multiple switches', async () => {
      const history = [
        { role: 'user', content: 'distinct prior request' },
        { role: 'assistant', content: 'distinct prior answer' },
      ];
      const snapshotHistory = vi.fn(() => history);
      const first = createConversationDouble({ snapshotHistory });
      const finalConversation = createConversationDouble();
      mockCreateTuiConversation
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(finalConversation);
      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);

      mockSelectInteractiveMode.mockResolvedValueOnce('persona');
      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'mode' },
        { history: [], queue: [] },
      );
      await waitForMount(tree, 2);
      mockSelectInteractiveMode.mockResolvedValueOnce('grill-me');
      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'mode' },
        { history: [], queue: [] },
      );
      await waitForMount(tree, 3);

      expect(mockCreateTuiConversation).toHaveBeenCalledTimes(1);
      await tree.conversationProps().conversation.submit(submitInput());
      expect(mockCreateTuiConversation).toHaveBeenCalledTimes(2);
      expect(snapshotHistory).toHaveBeenCalledTimes(1);
      const finalPlan = mockCreateTuiConversation.mock.calls[1]?.[0]?.plan;
      expect(finalPlan.ctx.personaName).toBe('grill-me-interactive');
      expect(finalPlan.strategy.permissionMode).toBe('readonly');
      expect(mockCreateTuiConversation.mock.calls[1]?.[0]?.handoffHistory).toEqual(history);
      expect(finalConversation.submit).toHaveBeenCalledTimes(1);

      tree.conversationProps().onExit(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        { history: [], queue: [] },
      );
      await run;
    });

    it('should rebuild the selected persona lazily with its prompt and tools', async () => {
      const history = [
        { role: 'user', content: 'review this change' },
        { role: 'assistant', content: 'I will inspect it.' },
      ];
      const first = createConversationDouble({ snapshotHistory: vi.fn(() => history) });
      const personaConversation = createConversationDouble();
      mockCreateTuiConversation
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(personaConversation);
      mockGetWorkflowDescription.mockReturnValue({
        name: 'default',
        description: 'default workflow',
        workflowStructure: '1. review',
        stepPreviews: [],
        firstStep: {
          personaContent: 'You are the exact review persona.',
          personaDisplayName: 'Exact Reviewer',
          allowedTools: ['Read', 'Grep'],
        },
      });
      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);

      mockSelectInteractiveMode.mockResolvedValue('persona');
      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'mode' },
        { history: ['/mode'], queue: [] },
      );
      await waitForMount(tree, 2);

      expect(mockCreateTuiConversation).toHaveBeenCalledTimes(1);
      await tree.conversationProps().conversation.submit(submitInput());

      const personaSetup = mockCreateTuiConversation.mock.calls[1]?.[0];
      expect(personaSetup.plan.ctx.personaName).toBe('persona-interactive');
      expect(personaSetup.plan.strategy.systemPrompt).toContain('You are the exact review persona.');
      expect(personaSetup.plan.strategy.allowedTools).toEqual(['Read', 'Grep']);
      expect(personaSetup.handoffHistory).toEqual(history);
      expect(personaConversation.submit).toHaveBeenCalledTimes(1);

      tree.conversationProps().onExit(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        { history: [], queue: [] },
      );
      await run;
    });

    it('should use the switched workflow for the first /go call and the returned result', async () => {
      const history = [
        { role: 'user' as const, content: 'old request' },
        { role: 'assistant' as const, content: 'old answer' },
      ];
      const snapshotHistory = vi.fn(() => history);
      const first = createConversationDouble({
        snapshotHistory,
      });
      const second = createConversationDouble();
      mockCreateTuiConversation
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second);
      mockGetWorkflowDescription.mockImplementation((workflowId: string) => ({
        name: workflowId,
        description: `${workflowId} workflow`,
        workflowStructure: '1. plan',
        stepPreviews: [],
      }));
      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);

      mockDetermineWorkflow.mockResolvedValue('review');
      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'workflow' },
        { history: ['/workflow'], queue: [] },
      );
      await waitForMount(tree, 2);
      expect(mockCreateTuiConversation).toHaveBeenCalledTimes(1);

      const instruction = await tree.conversationProps().conversation.createInstruction({
        ...submitInput(),
        text: '',
      });

      expect(mockGetWorkflowDescription).toHaveBeenLastCalledWith(
        'review',
        '/repo',
        undefined,
        '/repo',
        undefined,
        undefined,
      );
      expect(mockCreateTuiConversation.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        workflowContext: expect.objectContaining({ name: 'review' }),
        handoffHistory: history,
      }));
      expect(snapshotHistory).toHaveBeenCalledTimes(1);
      expect(mockCreateTuiConversation).toHaveBeenCalledTimes(2);
      expect(second.createInstruction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        text: '',
      }));
      expect(instruction).toEqual({
        kind: 'task_instruction',
        task: 'instruction',
        origin: 'go',
        notices: [],
      });

      tree.conversationProps().onExit(
        { kind: 'result', result: { action: 'execute', task: 'ship it' } },
        { history: [], queue: [] },
      );
      await expect(run).resolves.toMatchObject({ workflowId: 'review' });
    });

    it('should rebuild persona mode from the switched workflow first step', async () => {
      mockSelectInteractiveMode.mockResolvedValue('persona');
      mockGetWorkflowDescription.mockImplementation((workflowId: string) => ({
        name: workflowId,
        description: `${workflowId} workflow`,
        workflowStructure: '1. plan',
        stepPreviews: [],
        firstStep: {
          personaContent: workflowId === 'review' ? 'New reviewer persona' : 'Old coder persona',
          personaDisplayName: workflowId === 'review' ? 'Reviewer' : 'Coder',
          allowedTools: workflowId === 'review' ? ['Read'] : ['Read', 'Edit'],
        },
      }));
      const history = [
        { role: 'user' as const, content: 'review this' },
        { role: 'assistant' as const, content: 'I will inspect it.' },
      ];
      const snapshotHistory = vi.fn(() => history);
      const first = createConversationDouble({ snapshotHistory });
      const second = createConversationDouble();
      mockCreateTuiConversation
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second);
      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);

      mockDetermineWorkflow.mockResolvedValue('review');
      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'workflow' },
        { history: ['/workflow'], queue: [] },
      );
      await waitForMount(tree, 2);
      await tree.conversationProps().conversation.submit(submitInput());

      const nextPlan = mockCreateTuiConversation.mock.calls[1]?.[0]?.plan;
      expect(nextPlan.strategy.systemPrompt).toContain('New reviewer persona');
      expect(nextPlan.strategy.systemPrompt).not.toContain('Old coder persona');
      expect(nextPlan.strategy.allowedTools).toEqual(['Read']);
      expect(mockCreateTuiConversation.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        handoffHistory: history,
      }));
      expect(snapshotHistory).toHaveBeenCalledTimes(1);
      expect(mockCreateTuiConversation).toHaveBeenCalledTimes(2);
      expect(mockSelectInteractiveMode).toHaveBeenCalledTimes(1);

      tree.conversationProps().onExit(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        { history: [], queue: [] },
      );
      await run;
    });

    it('should apply a free-form model lazily and update effort on the active session', async () => {
      const history = [
        { role: 'user' as const, content: 'configure the model' },
        { role: 'assistant' as const, content: 'I will use the requested model.' },
      ];
      const snapshotHistory = vi.fn(() => history);
      const first = createConversationDouble({ snapshotHistory });
      const second = createConversationDouble();
      mockCreateTuiConversation
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second);
      const tree = scriptRender();
      mockGetWorkflowDescription.mockImplementation((
        _workflowId: string,
        _projectCwd: string,
        _previewCount: number | undefined,
        _lookupCwd: string,
        overrides?: { model?: string },
      ) => {
        if (overrides?.model !== undefined) {
          throw new Error('temporary model reached workflow preview');
        }
        return {
          name: 'default',
          description: 'default workflow',
          workflowStructure: '1. plan',
          stepPreviews: [],
        };
      });
      const run = startRun();
      await waitForMount(tree, 1);
      const resolverCallsBeforeCommands = mockResolveAssistantProviderModel.mock.calls.length;

      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'model', text: 'custom-model' },
        { history: ['/model custom-model'], queue: [] },
      );
      await waitForMount(tree, 2);
      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'effort', text: 'custom-effort' },
        { history: ['/effort custom-effort'], queue: [] },
      );
      await waitForMount(tree, 3);
      const modelLabel = tree.conversationProps().modelLabel;
      expect(modelLabel()).toContain('mock-model');
      expect(mockCreateTuiConversation).toHaveBeenCalledTimes(1);
      expect(mockResolveAssistantProviderModel).toHaveBeenCalledTimes(resolverCallsBeforeCommands);
      expect(first.submit).not.toHaveBeenCalled();

      await tree.conversationProps().conversation.submit(submitInput());

      expect(mockCreateTuiConversation).toHaveBeenCalledTimes(2);
      expect(mockCreateTuiConversation.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        handoffHistory: history,
      }));
      expect(snapshotHistory).toHaveBeenCalledTimes(1);
      expect(mockResolveAssistantProviderModel).toHaveBeenCalledTimes(resolverCallsBeforeCommands);
      expect(mockGetWorkflowDescription).toHaveBeenLastCalledWith(
        'default',
        '/repo',
        undefined,
        '/repo',
        undefined,
        undefined,
      );
      const nextPlan = mockCreateTuiConversation.mock.calls[1]?.[0]?.plan;
      expect(nextPlan.ctx).toEqual(expect.objectContaining({
        model: 'custom-model',
        effort: 'custom-effort',
        sessionId: undefined,
      }));
      expect(mockCreateTuiConversation.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        persistSession: false,
      }));
      expect(modelLabel()).toContain('custom-model');

      tree.conversationProps().onExit(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        { history: [], queue: [] },
      );
      await run;
    });

    it('should preserve the resolved persona provider when only the model changes', async () => {
      mockSelectInteractiveMode.mockResolvedValue('persona');
      mockGetWorkflowDescription.mockReturnValue({
        name: 'default',
        description: 'default workflow',
        workflowStructure: '1. plan',
        stepPreviews: [],
        firstStep: {
          personaContent: 'Reviewer persona',
          personaDisplayName: 'Reviewer',
          allowedTools: ['Read'],
        },
      });
      const initial = createConversationDouble();
      const rebuilt = createConversationDouble();
      mockCreateTuiConversation
        .mockReturnValueOnce(initial)
        .mockReturnValueOnce(rebuilt);
      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);

      const initialPlan = mockCreateTuiConversation.mock.calls[0]?.[0]?.plan;
      const initialProvider = initialPlan.ctx.providerType;
      const resolverCallsBeforeCommand = mockResolveAssistantProviderModel.mock.calls.length;
      const fallbackProvider = initialProvider === 'claude' ? 'codex' : 'claude';
      mockResolveAssistantProviderModel.mockImplementation((
        _cwd: string,
        overrides?: { provider?: string; model?: string },
      ) => ({
        runtimeManaged: false,
        provider: overrides?.provider ?? fallbackProvider,
        model: overrides?.model,
      }));

      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'model', text: 'custom-model' },
        { history: ['/model custom-model'], queue: [] },
      );
      await waitForMount(tree, 2);
      await tree.conversationProps().conversation.submit(submitInput());

      const rebuiltPlan = mockCreateTuiConversation.mock.calls[1]?.[0]?.plan;
      expect(mockResolveAssistantProviderModel).toHaveBeenCalledTimes(resolverCallsBeforeCommand);
      expect(rebuiltPlan.ctx).toEqual(expect.objectContaining({
        providerType: initialProvider,
        model: 'custom-model',
      }));

      tree.conversationProps().onExit(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        { history: [], queue: [] },
      );
      await run;
    });

    it('should preserve runtime-managed session settings across an implicit rebuild', async () => {
      mockResolveAssistantProviderModel.mockReturnValue({
        runtimeManaged: true,
        provider: 'codex',
        model: 'runtime-model',
        providerOptions: { codex: { reasoningEffort: 'high' } },
        permissionMode: 'readonly',
      });
      const first = createConversationDouble();
      const rebuilt = createConversationDouble();
      mockCreateTuiConversation
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(rebuilt);
      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);
      const resolverCallsBeforeSwitch = mockResolveAssistantProviderModel.mock.calls.length;

      mockSelectInteractiveMode.mockResolvedValue('grill-me');
      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'mode' },
        { history: ['/mode'], queue: [] },
      );
      await waitForMount(tree, 2);
      await tree.conversationProps().conversation.submit(submitInput());

      const rebuiltPlan = mockCreateTuiConversation.mock.calls[1]?.[0]?.plan;
      expect(mockResolveAssistantProviderModel).toHaveBeenCalledTimes(resolverCallsBeforeSwitch);
      expect(rebuiltPlan.ctx).toEqual(expect.objectContaining({
        providerType: 'codex',
        model: 'runtime-model',
        providerOptions: { codex: { reasoningEffort: 'high' } },
        permissionMode: 'readonly',
      }));

      tree.conversationProps().onExit(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        { history: [], queue: [] },
      );
      await run;
    });

    it('should apply a model change before the manual resend after a provider error', async () => {
      const first = createConversationDouble({
        submit: vi.fn().mockResolvedValue({ kind: 'error', message: 'unsupported model' }),
      });
      const recovered = createConversationDouble({
        submit: vi.fn().mockResolvedValue({
          kind: 'assistant_response',
          content: 'manual retry succeeded',
        }),
      });
      mockCreateTuiConversation
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(recovered);
      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);

      const failed = await tree.conversationProps().conversation.submit(submitInput());
      expect(failed).toEqual({ kind: 'error', message: 'unsupported model' });

      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'model', text: 'supported-model' },
        { history: ['/model supported-model'], queue: [] },
      );
      await waitForMount(tree, 2);

      const retried = await tree.conversationProps().conversation.submit(submitInput());

      const recoveredPlan = mockCreateTuiConversation.mock.calls[1]?.[0]?.plan;
      expect(recoveredPlan.ctx).toEqual(expect.objectContaining({
        model: 'supported-model',
        sessionId: undefined,
        disableSessionRetry: true,
      }));
      expect(retried).toMatchObject({
        kind: 'assistant_response',
        content: 'manual retry succeeded',
      });
      expect(first.submit).toHaveBeenCalledTimes(1);
      expect(recovered.submit).toHaveBeenCalledTimes(1);

      tree.conversationProps().onExit(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        { history: [], queue: [] },
      );
      await run;
    });

    it('should apply an effort change without automatically resending after a provider error', async () => {
      const submit = vi.fn()
        .mockResolvedValueOnce({ kind: 'error', message: 'unsupported effort' })
        .mockResolvedValueOnce({ kind: 'assistant_response', content: 'manual retry succeeded' });
      const conversation = createConversationDouble({ submit });
      mockCreateTuiConversation.mockReturnValue(conversation);
      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);

      expect(await tree.conversationProps().conversation.submit(submitInput())).toEqual({
        kind: 'error',
        message: 'unsupported effort',
      });
      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'effort', text: 'supported-effort' },
        { history: ['/effort supported-effort'], queue: [] },
      );
      await waitForMount(tree, 2);

      expect(submit).toHaveBeenCalledTimes(1);
      expect(conversation.setEffort).toHaveBeenCalledWith('supported-effort');
      expect(await tree.conversationProps().conversation.submit(submitInput())).toMatchObject({
        kind: 'assistant_response',
        content: 'manual retry succeeded',
      });
      expect(mockCreateTuiConversation).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledTimes(2);

      tree.conversationProps().onExit(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        { history: [], queue: [] },
      );
      await run;
    });

    it('should apply a provider change without automatically resending after a provider error', async () => {
      const history = [
        { role: 'user' as const, content: 'switch providers' },
        { role: 'assistant' as const, content: 'The current provider is unavailable.' },
      ];
      const snapshotHistory = vi.fn(() => history);
      const failed = createConversationDouble({
        submit: vi.fn().mockResolvedValue({ kind: 'error', message: 'provider unavailable' }),
        snapshotHistory,
      });
      const recovered = createConversationDouble({
        submit: vi.fn().mockResolvedValue({
          kind: 'assistant_response',
          content: 'manual retry succeeded',
        }),
      });
      mockCreateTuiConversation
        .mockReturnValueOnce(failed)
        .mockReturnValueOnce(recovered);
      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);

      expect(await tree.conversationProps().conversation.submit(submitInput())).toEqual({
        kind: 'error',
        message: 'provider unavailable',
      });
      mockSelectInteractiveProvider.mockResolvedValue('claude');
      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'provider' },
        { history: ['/provider'], queue: [] },
      );
      await waitForMount(tree, 2);

      expect(mockCreateTuiConversation).toHaveBeenCalledTimes(1);
      expect(recovered.submit).not.toHaveBeenCalled();
      expect(await tree.conversationProps().conversation.submit(submitInput())).toMatchObject({
        kind: 'assistant_response',
        content: 'manual retry succeeded',
      });
      expect(mockCreateTuiConversation.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        handoffHistory: history,
      }));
      expect(snapshotHistory).toHaveBeenCalledTimes(1);
      expect(mockCreateTuiConversation).toHaveBeenCalledTimes(2);
      expect(mockCreateTuiConversation.mock.calls[1]?.[0]?.plan.ctx.providerType).toBe('claude');
      expect(failed.submit).toHaveBeenCalledTimes(1);
      expect(recovered.submit).toHaveBeenCalledTimes(1);

      tree.conversationProps().onExit(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        { history: [], queue: [] },
      );
      await run;
    });

    it('should keep the current session when only effort changes', async () => {
      const conversation = createConversationDouble();
      mockCreateTuiConversation.mockReturnValue(conversation);
      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);

      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'effort', text: 'custom-effort' },
        { history: ['/effort custom-effort'], queue: [] },
      );
      await waitForMount(tree, 2);
      await tree.conversationProps().conversation.submit(submitInput());

      expect(mockCreateTuiConversation).toHaveBeenCalledTimes(1);
      expect(conversation.setEffort).toHaveBeenCalledWith('custom-effort');
      expect(conversation.submit).toHaveBeenCalledTimes(1);

      tree.conversationProps().onExit(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        { history: [], queue: [] },
      );
      await run;
    });

    it('should clear temporary model and effort only when the provider actually changes', async () => {
      mockSelectInteractiveMode.mockResolvedValue('persona');
      mockGetWorkflowDescription.mockImplementation((
        workflowId: string,
        _projectCwd: string,
        _previewCount: number | undefined,
        _lookupCwd: string,
        _workflowOverrides?: { provider?: string },
        firstStepOverrides?: { provider?: string },
      ) => ({
        name: workflowId,
        description: `${workflowId} workflow`,
        workflowStructure: '1. plan',
        stepPreviews: [],
        firstStep: {
          personaContent: 'Reviewer persona',
          personaDisplayName: 'Reviewer',
          allowedTools: firstStepOverrides?.provider === 'claude' ? ['Read'] : ['Bash'],
        },
      }));
      mockResolveAssistantProviderModel.mockImplementation((
        _cwd: string,
        overrides?: { provider?: string; model?: string },
      ) => ({
        runtimeManaged: false,
        provider: overrides?.provider ?? 'mock',
        model: overrides?.model ?? (overrides?.provider === 'claude' ? 'claude-default' : 'mock-model'),
      }));
      const initial = createConversationDouble();
      const changed = createConversationDouble();
      mockCreateTuiConversation
        .mockReturnValueOnce(initial)
        .mockReturnValueOnce(changed);
      const agentOverrides = { provider: 'codex', model: 'startup-model' } as const;
      const tree = scriptRender();
      const run = startRun({
        agentOverrides,
      });
      await waitForMount(tree, 1);

      for (const [id, text] of [
        ['model', 'custom-model'],
        ['effort', 'custom-effort'],
      ] as const) {
        tree.conversationProps().onExit(
          { kind: 'handoff', id, text },
          { history: [`/${id} ${text}`], queue: [] },
        );
        await waitForMount(tree, id === 'model' ? 2 : 3);
      }
      mockSelectInteractiveProvider.mockResolvedValue('claude');
      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'provider' },
        { history: ['/provider'], queue: [] },
      );
      await waitForMount(tree, 4);
      expect(mockCreateTuiConversation).toHaveBeenCalledTimes(1);

      await tree.conversationProps().conversation.submit(submitInput());

      const nextPlan = mockCreateTuiConversation.mock.calls[1]?.[0]?.plan;
      expect(nextPlan.ctx.providerType).toBe('claude');
      expect(nextPlan.ctx.model).toBe('claude-default');
      expect(nextPlan.ctx.effort).toBeUndefined();
      expect(nextPlan.strategy.allowedTools).toEqual(['Read']);
      expect(mockResolveAssistantProviderModel).toHaveBeenLastCalledWith('/repo', {
        provider: 'claude',
      });
      expect(mockGetWorkflowDescription).toHaveBeenLastCalledWith(
        'default',
        '/repo',
        undefined,
        '/repo',
        { provider: 'codex', model: 'startup-model' },
        { provider: 'claude' },
      );
      expect(agentOverrides).toEqual({ provider: 'codex', model: 'startup-model' });
      expect(mockCreateTuiConversation.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        persistSession: false,
      }));

      tree.conversationProps().onExit(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        { history: [], queue: [] },
      );
      await run;
    });

    it('should preserve temporary model and effort when the provider selection is unchanged', async () => {
      const initial = createConversationDouble();
      const changed = createConversationDouble();
      mockCreateTuiConversation
        .mockReturnValueOnce(initial)
        .mockReturnValueOnce(changed);
      const tree = scriptRender();
      const run = startRun({ agentOverrides: { provider: 'codex' } });
      await waitForMount(tree, 1);

      for (const [index, id, text] of [
        [2, 'model', 'custom-model'],
        [3, 'effort', 'custom-effort'],
      ] as const) {
        tree.conversationProps().onExit(
          { kind: 'handoff', id, text },
          { history: [`/${id} ${text}`], queue: [] },
        );
        await waitForMount(tree, index);
      }
      mockSelectInteractiveProvider.mockResolvedValue('codex');
      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'provider' },
        { history: ['/provider'], queue: [] },
      );
      await waitForMount(tree, 4);
      await tree.conversationProps().conversation.submit(submitInput());

      const nextPlan = mockCreateTuiConversation.mock.calls[1]?.[0]?.plan;
      expect(nextPlan.ctx).toEqual(expect.objectContaining({
        providerType: 'codex',
        model: 'custom-model',
        effort: 'custom-effort',
      }));

      tree.conversationProps().onExit(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        { history: [], queue: [] },
      );
      await run;
    });

    it('should keep a free-form OpenCode model out of workflow selector preview validation', async () => {
      mockSelectInteractiveProvider.mockResolvedValue('opencode');
      mockResolveAssistantProviderModel.mockImplementation((
        _cwd: string,
        overrides?: { provider?: string; model?: string },
      ) => ({
        runtimeManaged: false,
        provider: overrides?.provider ?? 'mock',
        model: overrides?.model ?? (overrides?.provider === 'opencode' ? undefined : 'mock-model'),
      }));
      mockGetWorkflowDescription.mockImplementation((
        workflowId: string,
        _projectCwd: string,
        _previewCount: number | undefined,
        _lookupCwd: string,
        workflowOverrides?: { provider?: string; model?: string },
        firstStepOverrides?: { provider?: string; model?: string },
      ) => {
        if (workflowOverrides?.provider === 'opencode' || firstStepOverrides?.model !== undefined) {
          throw new Error('temporary assistant settings reached workflow selector validation');
        }
        return {
          name: workflowId,
          description: `${workflowId} workflow`,
          workflowStructure: '1. plan',
          stepPreviews: [],
        };
      });
      const initial = createConversationDouble();
      const rebuilt = createConversationDouble();
      mockCreateTuiConversation
        .mockReturnValueOnce(initial)
        .mockReturnValueOnce(rebuilt);
      const tree = scriptRender();
      const run = startRun();
      await waitForMount(tree, 1);

      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'provider' },
        { history: ['/provider'], queue: [] },
      );
      await waitForMount(tree, 2);
      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'model', text: 'free-form-model' },
        { history: ['/model free-form-model'], queue: [] },
      );
      await waitForMount(tree, 3);

      await expect(tree.conversationProps().conversation.submit(submitInput()))
        .resolves.toMatchObject({ kind: 'assistant_response' });

      expect(mockGetWorkflowDescription).toHaveBeenLastCalledWith(
        'default',
        '/repo',
        undefined,
        '/repo',
        undefined,
        { provider: 'opencode' },
      );
      expect(mockCreateTuiConversation.mock.calls[1]?.[0]?.plan.ctx).toEqual(expect.objectContaining({
        providerType: 'opencode',
        model: 'free-form-model',
      }));

      tree.conversationProps().onExit(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        { history: [], queue: [] },
      );
      await run;
    });

    it('should not restore temporary settings in a new TUI process', async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'takt-interactive-state-'));
      try {
        const firstTree = scriptRender();
        const firstRun = startRun({ cwd: projectDir });
        await waitForMount(firstTree, 1);
        mockSelectInteractiveProvider.mockResolvedValueOnce('claude');
        firstTree.conversationProps().onExit(
          { kind: 'handoff', id: 'provider' },
          { history: ['/provider'], queue: [] },
        );
        await waitForMount(firstTree, 2);
        for (const [mount, id, text] of [
          [3, 'model', 'temporary-model'],
          [4, 'effort', 'temporary-effort'],
        ] as const) {
          firstTree.conversationProps().onExit(
            { kind: 'handoff', id, text },
            { history: [`/${id} ${text}`], queue: [] },
          );
          await waitForMount(firstTree, mount);
        }
        firstTree.conversationProps().onExit(
          { kind: 'result', result: { action: 'cancel', task: '' } },
          { history: [], queue: [] },
        );
        await firstRun;
        mockCreateTuiConversation.mockClear();
        const secondTree = scriptRender();
        const secondRun = startRun({ cwd: projectDir });
        await waitForMount(secondTree, 1);

        const restartedPlan = mockCreateTuiConversation.mock.calls[0]?.[0]?.plan;
        expect(restartedPlan.ctx.providerType).toBe('mock');
        expect(restartedPlan.ctx.model).toBe('mock-model');
        expect(restartedPlan.ctx.effort).toBeUndefined();
        expect(restartedPlan.ctx.model).not.toBe('temporary-model');
        secondTree.conversationProps().onExit(
          { kind: 'result', result: { action: 'cancel', task: '' } },
          { history: [], queue: [] },
        );
        await secondRun;
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });

    it('should not persist a successful session created with temporary provider settings', async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'takt-interactive-state-'));
      realTuiConversation.current = true;
      try {
        const tree = scriptRender();
        const run = startRun({
          cwd: projectDir,
          agentOverrides: { provider: 'codex' },
        });
        await waitForMount(tree, 1);

        mockSelectInteractiveProvider.mockResolvedValueOnce('mock');
        for (const [mount, id, text] of [
          [2, 'provider', undefined],
          [3, 'model', 'temporary-model'],
          [4, 'effort', 'temporary-effort'],
        ] as const) {
          tree.conversationProps().onExit(
            { kind: 'handoff', id, ...(text === undefined ? {} : { text }) },
            { history: [`/${id}${text === undefined ? '' : ` ${text}`}`], queue: [] },
          );
          await waitForMount(tree, mount);
        }

        await expect(tree.conversationProps().conversation.submit({
          text: 'run the temporary session',
          abortSignal: new AbortController().signal,
          onAssistantChunk: vi.fn(),
        })).resolves.toMatchObject({ kind: 'assistant_response' });

        expect(existsSync(join(projectDir, '.takt', 'persona_sessions.json'))).toBe(false);
        expect(existsSync(join(projectDir, '.takt', 'interactive-state.json'))).toBe(false);
        tree.conversationProps().onExit(
          { kind: 'result', result: { action: 'cancel', task: '' } },
          { history: [], queue: [] },
        );
        await run;

        expect(mockCreateTuiConversation).not.toHaveBeenCalled();
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
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
    it('should dispatch with no interactive overrides after provider, model, and effort handoffs', async () => {
      const first = createConversationDouble();
      const rebuilt = createConversationDouble();
      mockCreateTuiConversation
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(rebuilt);
      mockSelectInteractiveProvider.mockResolvedValue('claude');
      const dispatch = vi.fn().mockResolvedValue(undefined);
      const startupOverrides = { provider: 'codex', model: 'workflow-model' } as const;
      const tree = scriptRender();
      const run = startRun({ agentOverrides: startupOverrides, dispatch });
      await waitForMount(tree, 1);

      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'provider' },
        { history: ['/provider'], queue: [] },
      );
      await waitForMount(tree, 2);
      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'model', text: 'conversation-model' },
        { history: ['/model conversation-model'], queue: [] },
      );
      await waitForMount(tree, 3);
      tree.conversationProps().onExit(
        { kind: 'handoff', id: 'effort', text: 'conversation-effort' },
        { history: ['/effort conversation-effort'], queue: [] },
      );
      await waitForMount(tree, 4);

      await tree.conversationProps().conversation.createInstruction({
        text: '',
        abortSignal: new AbortController().signal,
        onAssistantChunk: vi.fn(),
      });
      tree.conversationProps().onExit(
        { kind: 'result', result: { action: 'execute', task: 'generated instruction' } },
        { history: ['/go'], queue: [] },
      );
      await waitForMount(tree, 5);

      expect(mockCreateTuiConversation.mock.calls[1]?.[0]?.plan.ctx).toEqual(expect.objectContaining({
        providerType: 'claude',
        model: 'conversation-model',
        effort: 'conversation-effort',
      }));
      expect(dispatch).toHaveBeenCalledExactlyOnceWith('default', {
        action: 'execute',
        task: 'generated instruction',
      });
      expect(startupOverrides).toEqual({ provider: 'codex', model: 'workflow-model' });

      tree.conversationProps().onExit(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        { history: [], queue: [] },
      );
      await run;
    });

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
