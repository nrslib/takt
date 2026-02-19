/**
 * Tests for instruct mode
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupRawStdin, restoreStdin, toRawInputs, createMockProvider } from './helpers/stdinSimulator.js';

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(() => ({ provider: 'mock', language: 'en' })),
  getBuiltinPiecesEnabled: vi.fn().mockReturnValue(true),
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
});

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

  it('should return action=save_task when user selects save task', async () => {
    setupRawStdin(toRawInputs(['describe task', '/go']));
    setupMockProvider(['response', 'Summarized task.']);
    mockSelectOption.mockResolvedValue('save_task');

    const result = await runInstructMode('/project', 'branch context', 'feature-branch', 'my-task', 'Do something', '');

    expect(result.action).toBe('save_task');
    expect(result.task).toBe('Summarized task.');
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

  it('should use custom action selector without create_issue option', async () => {
    setupRawStdin(toRawInputs(['task', '/go']));
    setupMockProvider(['response', 'Task summary.']);

    await runInstructMode('/project', 'branch context', 'feature-branch', 'my-task', 'Do something', '');

    const selectCall = mockSelectOption.mock.calls.find((call) =>
      Array.isArray(call[1])
    );
    expect(selectCall).toBeDefined();
    const options = selectCall![1] as Array<{ value: string }>;
    const values = options.map((o) => o.value);
    expect(values).toContain('execute');
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
      piece: 'default',
      status: 'completed',
      movementLogs: [
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
        runPiece: 'default',
        runStatus: 'completed',
      }),
    );
  });
});
