import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationPlan } from '../features/interactive/conversationPlan.js';
import type { InteractiveModeResult } from '../features/interactive/interactive.js';
import type { TuiConversationRunOptions } from '../features/tui/conversationRunner.js';
import { makeSessionContext } from './test-helpers.js';

const doubles = vi.hoisted(() => ({
  runner: vi.fn(),
  plan: vi.fn(),
  conversation: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  info: vi.fn(),
  pending: { content: undefined as string | undefined },
}));

vi.mock('../features/tui/conversationRunner.js', () => ({ runTuiConversation: doubles.runner }));
vi.mock('../features/tui/tuiConversation.js', () => ({ createTuiConversation: doubles.conversation }));
vi.mock('../features/interactive/conversationPlan.js', () => ({ createAssistantConversationPlan: doubles.plan }));
vi.mock('../features/tasks/index.js', () => ({ determineWorkflow: vi.fn().mockResolvedValue('default') }));
vi.mock('../features/interactive/modeSelection.js', () => ({ selectInteractiveMode: vi.fn().mockResolvedValue('assistant') }));
vi.mock('../features/interactive/taskInstructionFormat.js', () => ({
  resolveFormalSpecConfiguration: vi.fn().mockResolvedValue({ mode: false, comments: true, modelCheckTimeoutSeconds: 300 }),
}));
vi.mock('../features/interactive/interactive-summary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/interactive/interactive-summary.js')>()),
  createPostSummaryActionSelector: () => vi.fn().mockResolvedValue('save_task'),
}));
vi.mock('../features/interactive/imageAttachments.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/interactive/imageAttachments.js')>()),
  createSessionImageAttachmentStore: () => ({ listAttachments: () => [], seal: vi.fn(), cleanup: vi.fn() }),
  cleanupImageAttachmentStoreOnProcessExit: () => vi.fn(),
}));
vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/config/index.js')>()),
  getWorkflowDescription: () => ({ name: 'default', description: '', workflowStructure: '', stepPreviews: [] }),
}));
vi.mock('../infra/config/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/config/paths.js')>()),
  ensureDir: vi.fn(),
}));
vi.mock('../shared/utils/private-file.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/utils/private-file.js')>()),
  readPrivateFileState: doubles.read,
  writePrivateFileWithModeExpected: doubles.write,
}));
vi.mock('../shared/ui/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/ui/index.js')>()),
  info: doubles.info,
}));

import { getLabel } from '../shared/i18n/index.js';
import { runTui } from '../features/tui/runTui.js';

beforeEach(() => {
  vi.clearAllMocks();
  doubles.pending.content = undefined;
  doubles.read.mockImplementation((path: string) => doubles.pending.content === undefined
    ? { state: { path, exists: false } }
    : { state: { path, exists: true }, content: Buffer.from(doubles.pending.content) });
  doubles.conversation.mockReturnValue({ getSourceContext: () => undefined, getSessionId: () => undefined });
  const plan: ConversationPlan = {
    ctx: makeSessionContext(),
    strategy: {
      systemPrompt: 'test prompt', formalSpec: false, modelCheckTimeoutSeconds: 300,
      allowedTools: [], transformPrompt: (message) => message, introMessage: 'conversation ready',
    },
  };
  doubles.plan.mockReturnValue(plan);
});

function finishUnrelatedRun(): void {
  doubles.pending.content = JSON.stringify({
    version: 1, publicationId: 'unrelated-run', status: 'pending',
    state: {
      status: 'error', errorMessage: 'unrelated provider unavailable',
      workflowName: 'unrelated-workflow', timestamp: '2026-10-09T00:00:00.000Z',
    },
  });
}

describe('TUI operation notices', () => {
  it.each([
    { lang: 'ja', action: 'save_task', label: 'tui.ui.taskSaved' },
    { lang: 'en', action: 'save_task', label: 'tui.ui.taskSaved' },
    { lang: 'ja', action: 'create_issue', label: 'tui.ui.issueCreated' },
    { lang: 'en', action: 'create_issue', label: 'tui.ui.issueCreated' },
    { lang: 'ja', action: 'execute', label: 'tui.ui.runFinished' },
    { lang: 'en', action: 'execute', label: 'tui.ui.runFinished' },
  ] as const)('should report $action in $lang independently of an unrelated failed run', async ({ lang, action, label }) => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    doubles.runner.mockImplementation(async (options: TuiConversationRunOptions) => {
      expect(options.initialEntries).toEqual([{ role: 'system', content: 'conversation ready' }]);
      finishUnrelatedRun();
      const result: InteractiveModeResult = { action, task: 'current task' };
      expect(await options.dispatch!(result)).toEqual({ kind: 'dispatched', notice: getLabel(label, lang) });
      return { action: 'cancel', task: '' };
    });

    await runTui({ cwd: '/test-project', lang, previewCount: undefined, taskHistory: [], dispatch });

    expect(dispatch).toHaveBeenCalledExactlyOnceWith('default', expect.objectContaining({ action, task: 'current task' }));
    expect(doubles.read.mock.calls.filter(([path]) => String(path).endsWith('/session-state.json'))).toEqual([]);
    expect(doubles.write.mock.calls.filter(([path]) => String(path).endsWith('/session-state.json'))).toEqual([]);
    expect(doubles.info).not.toHaveBeenCalled();
  });

  it('should show the conversation intro without reading or consuming an unrelated run at startup', async () => {
    finishUnrelatedRun();
    doubles.runner.mockImplementation(async (options: TuiConversationRunOptions) => {
      expect(options.initialEntries).toEqual([{ role: 'system', content: 'conversation ready' }]);
      return { action: 'cancel', task: '' };
    });

    await runTui({ cwd: '/test-project', lang: 'ja', previewCount: undefined, taskHistory: [] });

    expect(doubles.read.mock.calls.filter(([path]) => String(path).endsWith('/session-state.json'))).toEqual([]);
    expect(doubles.write.mock.calls.filter(([path]) => String(path).endsWith('/session-state.json'))).toEqual([]);
    expect(doubles.info).not.toHaveBeenCalled();
  });

  it('should return cancellation without a completion notice', async () => {
    const dispatch = vi.fn().mockResolvedValue({ kind: 'cancelled' });
    doubles.runner.mockImplementation(async (options: TuiConversationRunOptions) => {
      expect(await options.dispatch!({ action: 'save_task', task: 'current task' })).toEqual({ kind: 'cancelled' });
      return { action: 'cancel', task: '' };
    });

    await runTui({ cwd: '/test-project', lang: 'ja', previewCount: undefined, taskHistory: [], dispatch });
  });

  it('should propagate a dispatch failure without returning a completion notice', async () => {
    const error = new Error('dispatch failed');
    doubles.runner.mockImplementation(async (options: TuiConversationRunOptions) => {
      await options.dispatch!({ action: 'execute', task: 'current task' });
      return { action: 'cancel', task: '' };
    });

    await expect(runTui({
      cwd: '/test-project', lang: 'ja', previewCount: undefined, taskHistory: [],
      dispatch: vi.fn().mockRejectedValue(error),
    })).rejects.toBe(error);
  });
});
