/**
 * Tests for instruct mode
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

const mockGetProvider = vi.mocked(getProvider);
const mockSelectOption = vi.mocked(selectOption);
const mockInfo = vi.mocked(info);

let savedIsTTY: boolean | undefined;
let savedIsRaw: boolean | undefined;
let savedSetRawMode: typeof process.stdin.setRawMode | undefined;
let savedStdoutWrite: typeof process.stdout.write;
let savedStdinOn: typeof process.stdin.on;
let savedStdinRemoveListener: typeof process.stdin.removeListener;
let savedStdinResume: typeof process.stdin.resume;
let savedStdinPause: typeof process.stdin.pause;

function setupRawStdin(rawInputs: string[]): void {
  savedIsTTY = process.stdin.isTTY;
  savedIsRaw = process.stdin.isRaw;
  savedSetRawMode = process.stdin.setRawMode;
  savedStdoutWrite = process.stdout.write;
  savedStdinOn = process.stdin.on;
  savedStdinRemoveListener = process.stdin.removeListener;
  savedStdinResume = process.stdin.resume;
  savedStdinPause = process.stdin.pause;

  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdin, 'isRaw', { value: false, configurable: true, writable: true });
  process.stdin.setRawMode = vi.fn((mode: boolean) => {
    (process.stdin as unknown as { isRaw: boolean }).isRaw = mode;
    return process.stdin;
  }) as unknown as typeof process.stdin.setRawMode;
  process.stdout.write = vi.fn(() => true) as unknown as typeof process.stdout.write;
  process.stdin.resume = vi.fn(() => process.stdin) as unknown as typeof process.stdin.resume;
  process.stdin.pause = vi.fn(() => process.stdin) as unknown as typeof process.stdin.pause;

  let currentHandler: ((data: Buffer) => void) | null = null;
  let inputIndex = 0;

  process.stdin.on = vi.fn(((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'data') {
      currentHandler = handler as (data: Buffer) => void;
      if (inputIndex < rawInputs.length) {
        const data = rawInputs[inputIndex]!;
        inputIndex++;
        queueMicrotask(() => {
          if (currentHandler) {
            currentHandler(Buffer.from(data, 'utf-8'));
          }
        });
      }
    }
    return process.stdin;
  }) as typeof process.stdin.on);

  process.stdin.removeListener = vi.fn(((event: string) => {
    if (event === 'data') {
      currentHandler = null;
    }
    return process.stdin;
  }) as typeof process.stdin.removeListener);
}

function restoreStdin(): void {
  if (savedIsTTY !== undefined) {
    Object.defineProperty(process.stdin, 'isTTY', { value: savedIsTTY, configurable: true });
  }
  if (savedIsRaw !== undefined) {
    Object.defineProperty(process.stdin, 'isRaw', { value: savedIsRaw, configurable: true, writable: true });
  }
  if (savedSetRawMode) {
    process.stdin.setRawMode = savedSetRawMode;
  }
  if (savedStdoutWrite) {
    process.stdout.write = savedStdoutWrite;
  }
  if (savedStdinOn) {
    process.stdin.on = savedStdinOn;
  }
  if (savedStdinRemoveListener) {
    process.stdin.removeListener = savedStdinRemoveListener;
  }
  if (savedStdinResume) {
    process.stdin.resume = savedStdinResume;
  }
  if (savedStdinPause) {
    process.stdin.pause = savedStdinPause;
  }
}

function toRawInputs(inputs: (string | null)[]): string[] {
  return inputs.map((input) => {
    if (input === null) return '\x04';
    return input + '\r';
  });
}

function setupMockProvider(responses: string[]): void {
  let callIndex = 0;
  const mockCall = vi.fn(async () => {
    const content = callIndex < responses.length ? responses[callIndex] : 'AI response';
    callIndex++;
    return {
      persona: 'instruct',
      status: 'done' as const,
      content: content!,
      timestamp: new Date(),
    };
  });
  const mockProvider = {
    setup: () => ({ call: mockCall }),
    _call: mockCall,
  };
  mockGetProvider.mockReturnValue(mockProvider);
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

    const result = await runInstructMode('/project', 'branch context', 'feature-branch');

    expect(result.action).toBe('cancel');
    expect(result.task).toBe('');
  });

  it('should include branch name in intro message', async () => {
    setupRawStdin(toRawInputs(['/cancel']));
    setupMockProvider([]);

    await runInstructMode('/project', 'diff stats', 'my-feature-branch');

    const introCall = mockInfo.mock.calls.find((call) =>
      call[0]?.includes('my-feature-branch')
    );
    expect(introCall).toBeDefined();
  });

  it('should return action=execute with task on /go after conversation', async () => {
    setupRawStdin(toRawInputs(['add more tests', '/go']));
    setupMockProvider(['What kind of tests?', 'Add unit tests for the feature.']);

    const result = await runInstructMode('/project', 'branch context', 'feature-branch');

    expect(result.action).toBe('execute');
    expect(result.task).toBe('Add unit tests for the feature.');
  });

  it('should return action=save_task when user selects save task', async () => {
    setupRawStdin(toRawInputs(['describe task', '/go']));
    setupMockProvider(['response', 'Summarized task.']);
    mockSelectOption.mockResolvedValue('save_task');

    const result = await runInstructMode('/project', 'branch context', 'feature-branch');

    expect(result.action).toBe('save_task');
    expect(result.task).toBe('Summarized task.');
  });

  it('should continue editing when user selects continue', async () => {
    setupRawStdin(toRawInputs(['describe task', '/go', '/cancel']));
    setupMockProvider(['response', 'Summarized task.']);
    mockSelectOption.mockResolvedValueOnce('continue');

    const result = await runInstructMode('/project', 'branch context', 'feature-branch');

    expect(result.action).toBe('cancel');
  });

  it('should reject /go with no prior conversation', async () => {
    setupRawStdin(toRawInputs(['/go', '/cancel']));
    setupMockProvider([]);

    const result = await runInstructMode('/project', 'branch context', 'feature-branch');

    expect(result.action).toBe('cancel');
  });

  it('should use custom action selector without create_issue option', async () => {
    setupRawStdin(toRawInputs(['task', '/go']));
    setupMockProvider(['response', 'Task summary.']);

    await runInstructMode('/project', 'branch context', 'feature-branch');

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
});
