/**
 * Tests for instruct mode
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setupRawStdin, restoreStdin, toRawInputs, createMockProvider } from './helpers/stdinSimulator.js';

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(() => ({ provider: 'mock', language: 'en' })),
  getBuiltinWorkflowsEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../shared/context.js', () => ({
  isQuietMode: vi.fn(() => false),
}));

vi.mock('../infra/config/paths.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadPersonaSessions: vi.fn(() => ({})),
  updatePersonaSession: vi.fn(),
  getProjectConfigDir: vi.fn(() => '/tmp'),
  loadSessionState: vi.fn(() => null),
  clearSessionState: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  blankLine: vi.fn(),
  StreamDisplay: vi.fn().mockImplementation(() => ({
    createHandler: vi.fn(() => vi.fn()),
    flush: vi.fn(),
  })),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn(),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn((_key: string, _lang: string) => 'Mock label'),
  getLabelObject: vi.fn(() => ({
    intro: 'Instruct mode intro',
    resume: 'Resuming',
    noConversation: 'No conversation',
    summarizeFailed: 'Summarize failed',
    continuePrompt: 'Continue',
    proposed: 'Proposed task:',
    actionPrompt: 'What to do?',
    actions: {
      execute: 'Execute',
      saveTask: 'Save task',
      continue: 'Continue',
    },
    cancelled: 'Cancelled',
  })),
}));

vi.mock('../shared/prompts/index.js', () => ({
  loadTemplate: vi.fn((_name: string, _lang: string) => 'Mock template content'),
}));

import { getProvider } from '../infra/providers/index.js';
import { runInstructMode } from '../features/tasks/list/instructMode.js';
import { selectOption } from '../shared/prompt/index.js';
import { info } from '../shared/ui/index.js';
import { loadTemplate } from '../shared/prompts/index.js';

const mockGetProvider = vi.mocked(getProvider);
const mockSelectOption = vi.mocked(selectOption);
const mockInfo = vi.mocked(info);
const mockLoadTemplate = vi.mocked(loadTemplate);
const attachmentSessionDirs = new Set<string>();

function setupMockProvider(responses: string[]): void {
  const { provider } = createMockProvider(responses);
  mockGetProvider.mockReturnValue(provider);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectOption.mockResolvedValue('execute');
});

afterEach(() => {
  restoreStdin();
  for (const sessionDir of attachmentSessionDirs) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  attachmentSessionDirs.clear();
});

function createOscImagePaste(): string {
  const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  return `\x1B]1337;File=inline=1;name=reference.png;size=${imageData.length}:${imageData.toString('base64')}\x07`;
}

function trackAttachmentSession(tempPath: string): void {
  attachmentSessionDirs.add(path.dirname(path.dirname(tempPath)));
}

describe('runInstructMode', () => {
  it('should return action=cancel when user types /cancel', async () => {
    setupRawStdin(toRawInputs(['/cancel']));
    setupMockProvider([]);

    const result = await runInstructMode('/project', 'branch context', 'feature-branch', 'my-task', 'Do something', '');

    expect(result.action).toBe('cancel');
    expect(result.task).toBe('');
  });

  it('should return action=execute with task on /go after conversation', async () => {
    setupRawStdin(toRawInputs(['add more tests', '/go']));
    setupMockProvider(['What kind of tests?', 'Add unit tests for the feature.']);

    const result = await runInstructMode('/project', 'branch context', 'feature-branch', 'my-task', 'Do something', '');

    expect(result.action).toBe('execute');
    expect(result.task).toBe('Add unit tests for the feature.');
  });

  it('should return action=execute with task on initial /go with inline task text', async () => {
    setupRawStdin(toRawInputs(['/go add more tests', '/cancel']));
    setupMockProvider(['Add unit tests from inline /go task.']);

    const result = await runInstructMode('/project', 'branch context', 'feature-branch', 'my-task', 'Do something', '');

    expect(result.action).toBe('execute');
    expect(result.task).toBe('Add unit tests from inline /go task.');
  });

  it('should return action=execute with task on initial suffix /go command text', async () => {
    setupRawStdin(toRawInputs(['add more tests /go', '/cancel']));
    setupMockProvider(['Add unit tests from suffix /go task.']);

    const result = await runInstructMode('/project', 'branch context', 'feature-branch', 'my-task', 'Do something', '');

    expect(result.action).toBe('execute');
    expect(result.task).toBe('Add unit tests from suffix /go task.');
  });

  it('should return action=save_task when user selects save task', async () => {
    setupRawStdin(toRawInputs(['describe task', '/go']));
    setupMockProvider(['response', 'Summarized task.']);
    mockSelectOption.mockResolvedValue('save_task');

    const result = await runInstructMode('/project', 'branch context', 'feature-branch', 'my-task', 'Do something', '');

    expect(result.action).toBe('save_task');
    expect(result.task).toBe('Summarized task.');
  });

  it('should preserve pasted image attachments from the conversation loop', async () => {
    setupRawStdin([
      `use ${createOscImagePaste()}\r`,
      '/go\r',
    ]);
    setupMockProvider(['response', 'Use [Image #1].']);

    const result = await runInstructMode('/project', 'branch context', 'feature-branch', 'my-task', 'Do something', '');

    expect(result.action).toBe('execute');
    expect(result.task).toBe('Use [Image #1].');
    expect(result.attachments?.[0]?.fileName).toBe('image-1.png');
    expect(result.attachments?.[0]?.tempPath).toBeDefined();
    trackAttachmentSession(result.attachments![0]!.tempPath);
    expect(fs.existsSync(result.attachments![0]!.tempPath)).toBe(true);
  });

  it('should continue editing when user selects continue', async () => {
    setupRawStdin(toRawInputs(['describe task', '/go', '/cancel']));
    setupMockProvider(['response', 'Summarized task.']);
    mockSelectOption.mockResolvedValueOnce('continue');

    const result = await runInstructMode('/project', 'branch context', 'feature-branch', 'my-task', 'Do something', '');

    expect(result.action).toBe('cancel');
  });

  it('should reject /go with no prior conversation', async () => {
    setupRawStdin(toRawInputs(['/go', '/cancel']));
    setupMockProvider([]);

    const result = await runInstructMode('/project', 'branch context', 'feature-branch', 'my-task', 'Do something', '');

    expect(result.action).toBe('cancel');
  });

  it('should exclude execute from action selector options', async () => {
    setupRawStdin(toRawInputs(['task', '/go']));
    setupMockProvider(['response', 'Task summary.']);
    mockSelectOption.mockResolvedValue('save_task');

    await runInstructMode('/project', 'branch context', 'feature-branch', 'my-task', 'Do something', '');

    const selectCall = mockSelectOption.mock.calls.find((call) =>
      Array.isArray(call[1])
    );
    expect(selectCall).toBeDefined();
    const options = selectCall![1] as Array<{ value: string }>;
    const values = options.map((o) => o.value);
    expect(values).not.toContain('execute');
    expect(values).toContain('save_task');
    expect(values).toContain('continue');
    expect(values).not.toContain('create_issue');
  });

  it('should use dedicated instruct system prompt with task context', async () => {
    setupRawStdin(toRawInputs(['/cancel']));
    setupMockProvider([]);

    await runInstructMode('/project', 'branch context', 'feature-branch', 'my-task', 'Do something', 'existing note');

    expect(mockLoadTemplate).toHaveBeenCalledWith(
      'score_instruct_system_prompt',
      'en',
      expect.objectContaining({
        taskName: 'my-task',
        taskContent: 'Do something',
        branchName: 'feature-branch',
        branchContext: 'branch context',
        retryNote: 'existing note',
      }),
    );
  });

  it('should inject selected run context into system prompt variables', async () => {
    setupRawStdin(toRawInputs(['/cancel']));
    setupMockProvider([]);

    const runSessionContext = {
      task: 'Previous run task',
      workflow: 'default',
      status: 'completed',
      stepLogs: [
        { step: 'implement', persona: 'coder', status: 'completed', content: 'done' },
      ],
      reports: [
        { filename: '00-plan.md', content: '# Plan' },
      ],
    };

    await runInstructMode('/project', 'branch context', 'feature-branch', 'my-task', 'Do something', '', undefined, runSessionContext);

    expect(mockLoadTemplate).toHaveBeenCalledWith(
      'score_instruct_system_prompt',
      'en',
      expect.objectContaining({
        hasRunSession: true,
        runTask: 'Previous run task',
        runWorkflow: 'default',
        runStatus: 'completed',
      }),
    );
  });

  it('should inject previousOrderContent into template variables when provided', async () => {
    setupRawStdin(toRawInputs(['/cancel']));
    setupMockProvider([]);

    await runInstructMode('/project', 'branch context', 'feature-branch', 'my-task', 'Do something', '', undefined, undefined, '# Previous Order\nDo the thing');

    expect(mockLoadTemplate).toHaveBeenCalledWith(
      'score_instruct_system_prompt',
      'en',
      expect.objectContaining({
        hasOrderContent: true,
        orderContent: '# Previous Order\nDo the thing',
      }),
    );
  });

  it('should set hasOrderContent=false when previousOrderContent is null', async () => {
    setupRawStdin(toRawInputs(['/cancel']));
    setupMockProvider([]);

    await runInstructMode('/project', 'branch context', 'feature-branch', 'my-task', 'Do something', '', undefined, undefined, null);

    expect(mockLoadTemplate).toHaveBeenCalledWith(
      'score_instruct_system_prompt',
      'en',
      expect.objectContaining({
        hasOrderContent: false,
        orderContent: '',
      }),
    );
  });

  it('should return execute with previous order content on /replay when previousOrderContent is set', async () => {
    setupRawStdin(toRawInputs(['/replay']));
    setupMockProvider([]);

    const previousOrder = '# Previous Order\nDo the thing';
    const result = await runInstructMode(
      '/project', 'branch context', 'feature-branch', 'my-task', 'Do something', '',
      undefined, undefined, previousOrder,
    );

    expect(result.action).toBe('execute');
    expect(result.task).toBe(previousOrder);
  });

  it('should show error and continue when /replay is used without previousOrderContent', async () => {
    setupRawStdin(toRawInputs(['/replay', '/cancel']));
    setupMockProvider([]);

    const result = await runInstructMode(
      '/project', 'branch context', 'feature-branch', 'my-task', 'Do something', '',
      undefined, undefined, null,
    );

    expect(result.action).toBe('cancel');
    expect(mockInfo).toHaveBeenCalledWith('Mock label');
  });
});
