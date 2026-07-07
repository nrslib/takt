import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkflowConfigValues } from '../infra/config/index.js';
import { getProvider } from '../infra/providers/index.js';
import { readInteractiveInput } from '../features/interactive/interactiveInput.js';
import type { ImageAttachmentStore, InteractiveImageAttachment } from '../features/interactive/imageAttachments.js';
import { callAIWithRetry } from '../features/interactive/aiCaller.js';
import { formatRunSessionForPrompt, loadRunSessionContext } from '../features/interactive/runSessionReader.js';
import { selectAndExecuteTask } from '../features/tasks/index.js';
import { runExecCommand } from '../features/exec/index.js';
import { DEFAULT_EXEC_CONFIG } from '../features/exec/defaults.js';
import { saveExecPreset, saveLastUsedExecConfig } from '../features/exec/presetStore.js';
import type { ExecConfig } from '../features/exec/types.js';
import { selectOption, type SelectOptionItem } from '../shared/prompt/index.js';
import { stripAnsi } from '../shared/utils/text.js';

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(() => ({ setup: vi.fn() })),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValue: vi.fn(() => 'en'),
  resolveWorkflowConfigValues: vi.fn(() => ({
    enableBuiltinWorkflows: true,
    language: 'en',
  })),
}));

vi.mock('../features/interactive/interactiveInput.js', () => ({
  readInteractiveInput: vi.fn(),
}));

vi.mock('../features/interactive/aiCaller.js', () => ({
  callAIWithRetry: vi.fn(),
}));

vi.mock('../features/interactive/runSessionReader.js', () => ({
  findRunForTask: vi.fn(() => 'exec-run'),
  formatRunSessionForPrompt: vi.fn(() => ({
    runStatus: 'completed',
    runReports: '# Review Result\n\napproved',
    runStepLogs: 'execute/review logs',
  })),
  loadRunSessionContext: vi.fn(() => ({
    reports: [
      {
        filename: 'review-1-review-result.md',
        content: '# Review Result\n\napproved',
      },
    ],
  })),
}));

vi.mock('../features/tasks/index.js', () => ({
  selectAndExecuteTask: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn(),
}));

const mockReadInteractiveInput = vi.mocked(readInteractiveInput);
const mockSelectOption = vi.mocked(selectOption);
const mockResolveWorkflowConfigValues = vi.mocked(resolveWorkflowConfigValues);
const mockGetProvider = vi.mocked(getProvider);
const mockCallAIWithRetry = vi.mocked(callAIWithRetry);
const mockSelectAndExecuteTask = vi.mocked(selectAndExecuteTask);
const mockLoadRunSessionContext = vi.mocked(loadRunSessionContext);
const mockFormatRunSessionForPrompt = vi.mocked(formatRunSessionForPrompt);
const execAttachmentTempDirs = new Set<string>();

function requireImageAttachmentStore(store: ImageAttachmentStore | undefined): ImageAttachmentStore {
  if (store === undefined) {
    throw new Error('Expected exec interactive input to receive an image attachment store.');
  }
  return store;
}

function trackAttachmentTempDir(attachment: InteractiveImageAttachment): void {
  execAttachmentTempDirs.add(dirname(dirname(attachment.tempPath)));
}

function mockSelectOptionQueue(...values: Array<string | null>): void {
  const queue = [...values];
  mockSelectOption.mockImplementation(<T extends string>(
    message: string,
    options: SelectOptionItem<T>[],
  ): Promise<T | null> => {
    const value = queue.shift();
    if (value === undefined) {
      throw new Error(`No queued selectOption value for "${message}"`);
    }
    if (value === null) {
      return Promise.resolve(null);
    }
    const optionValues = options.map((option) => option.value);
    if (!optionValues.includes(value as T)) {
      throw new Error(`Queued selectOption value "${value}" is not available for "${message}"`);
    }
    return Promise.resolve(value as T);
  });
}

describe('exec command setup', () => {
  let projectDir: string;
  let globalConfigDir: string;
  const originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;
  const originalTaktNoTty = process.env.TAKT_NO_TTY;
  const originalTaktNotifyWebhook = process.env.TAKT_NOTIFY_WEBHOOK;
  const originalStdinIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
    delete process.env.TAKT_NO_TTY;
    delete process.env.TAKT_NOTIFY_WEBHOOK;
    projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-command-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-exec-command-global-'));
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    mockReadInteractiveInput.mockReset();
    mockSelectOption.mockReset();
    mockResolveWorkflowConfigValues.mockReset();
    mockGetProvider.mockReset();
    mockCallAIWithRetry.mockReset();
    mockSelectAndExecuteTask.mockReset();
    mockLoadRunSessionContext.mockReset();
    mockFormatRunSessionForPrompt.mockReset();
    mockResolveWorkflowConfigValues.mockReturnValue({
      enableBuiltinWorkflows: true,
      language: 'en',
      provider: 'claude',
      model: 'opus',
    });
    mockGetProvider.mockReturnValue({ setup: vi.fn() });
    mockSelectAndExecuteTask.mockResolvedValue(undefined);
    mockLoadRunSessionContext.mockReturnValue({
      reports: [
        {
          filename: 'review-1-review-result.md',
          content: '# Review Result\n\napproved',
        },
      ],
    });
    mockFormatRunSessionForPrompt.mockReturnValue({
      runStatus: 'completed',
      runReports: '# Review Result\n\napproved',
      runStepLogs: 'execute/review logs',
    });
  });

  afterEach(() => {
    if (originalTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    }
    if (originalTaktNoTty === undefined) {
      delete process.env.TAKT_NO_TTY;
    } else {
      process.env.TAKT_NO_TTY = originalTaktNoTty;
    }
    if (originalTaktNotifyWebhook === undefined) {
      delete process.env.TAKT_NOTIFY_WEBHOOK;
    } else {
      process.env.TAKT_NOTIFY_WEBHOOK = originalTaktNotifyWebhook;
    }
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: originalStdinIsTTY,
    });
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalConfigDir, { recursive: true, force: true });
    for (const tempDir of execAttachmentTempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    execAttachmentTempDirs.clear();
  });

  it('should pass explicit assistant effort as provider options for exec assistant calls', async () => {
    saveExecPreset('effort-team', 'Explicit effort team', {
      ...DEFAULT_EXEC_CONFIG,
      session: {
        effort: 'high',
      },
    }, { projectDir, scope: 'project' });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'effort-team' })).resolves.toBeUndefined();

    expect(mockCallAIWithRetry.mock.calls[0]?.[4]).toEqual(expect.objectContaining({
      providerOptions: { claude: { effort: 'high' } },
    }));
    expect(mockCallAIWithRetry.mock.calls[1]?.[4]).toEqual(expect.objectContaining({
      providerOptions: { claude: { effort: 'high' } },
    }));
  });

  it('should start with the default config without prompting when only builtin presets exist', async () => {
    mockReadInteractiveInput.mockResolvedValueOnce('/cancel');

    await expect(runExecCommand(projectDir, {})).resolves.toBeUndefined();

    expect(mockSelectOption).not.toHaveBeenCalled();
    expect(mockReadInteractiveInput).toHaveBeenCalledWith(
      'Assistant> ',
      expect.any(String),
      {
        enableSetupCommand: true,
        enabledCommands: ['/setup', '/go', '/cancel', '/paste-image'],
      },
      expect.objectContaining({
        saveImage: expect.any(Function),
        listAttachments: expect.any(Function),
        cleanup: expect.any(Function),
      }),
    );
  });

  it('should cleanup pasted image session directory when exec is cancelled', async () => {
    let sessionDir: string | undefined;
    mockReadInteractiveInput.mockImplementationOnce(async (_prompt, _lang, _availability, imageAttachmentStore) => {
      const store = requireImageAttachmentStore(imageAttachmentStore);
      const attachment = await store.saveImage(Buffer.from('cancel-image'), 'image/png');
      sessionDir = dirname(dirname(attachment.tempPath));
      expect(existsSync(sessionDir)).toBe(true);
      return '/cancel';
    });

    await expect(runExecCommand(projectDir, {})).resolves.toBeUndefined();

    if (sessionDir === undefined) {
      throw new Error('Expected the test to create an exec image attachment session directory.');
    }
    expect(existsSync(sessionDir)).toBe(false);
  });

  it('should cleanup pasted image session directory when interactive input returns null', async () => {
    let sessionDir: string | undefined;
    mockReadInteractiveInput.mockImplementationOnce(async (_prompt, _lang, _availability, imageAttachmentStore) => {
      const store = requireImageAttachmentStore(imageAttachmentStore);
      const attachment = await store.saveImage(Buffer.from('null-image'), 'image/png');
      sessionDir = dirname(dirname(attachment.tempPath));
      expect(existsSync(sessionDir)).toBe(true);
      return null;
    });

    await expect(runExecCommand(projectDir, {})).resolves.toBeUndefined();

    if (sessionDir === undefined) {
      throw new Error('Expected the test to create an exec image attachment session directory.');
    }
    expect(existsSync(sessionDir)).toBe(false);
  });

  it('should cleanup pasted image session directory when interactive input throws', async () => {
    let sessionDir: string | undefined;
    mockReadInteractiveInput.mockImplementationOnce(async (_prompt, _lang, _availability, imageAttachmentStore) => {
      const store = requireImageAttachmentStore(imageAttachmentStore);
      const attachment = await store.saveImage(Buffer.from('throw-image'), 'image/png');
      sessionDir = dirname(dirname(attachment.tempPath));
      expect(existsSync(sessionDir)).toBe(true);
      throw new Error('input failed');
    });

    await expect(runExecCommand(projectDir, {})).rejects.toThrow('input failed');

    if (sessionDir === undefined) {
      throw new Error('Expected the test to create an exec image attachment session directory.');
    }
    expect(existsSync(sessionDir)).toBe(false);
  });

  it('should keep exec cancellation flow when image attachment cleanup fails', async () => {
    let sessionDir: string | undefined;
    mockReadInteractiveInput.mockImplementationOnce(async (_prompt, _lang, _availability, imageAttachmentStore) => {
      const store = requireImageAttachmentStore(imageAttachmentStore);
      const attachment = await store.saveImage(Buffer.from('cleanup-failure-image'), 'image/png');
      sessionDir = dirname(dirname(attachment.tempPath));
      const cleanup = store.cleanup.bind(store);
      store.cleanup = () => {
        cleanup();
        throw new Error('cleanup failed');
      };
      return '/cancel';
    });

    await expect(runExecCommand(projectDir, {})).resolves.toBeUndefined();

    if (sessionDir === undefined) {
      throw new Error('Expected the test to create an exec image attachment session directory.');
    }
    expect(existsSync(sessionDir)).toBe(false);
  });

  it('should pass referenced pasted images to exec assistant provider calls', async () => {
    let pastedAttachment: InteractiveImageAttachment | undefined;
    mockReadInteractiveInput
      .mockImplementationOnce(async (_prompt, _lang, _availability, imageAttachmentStore) => {
        const store = requireImageAttachmentStore(imageAttachmentStore);
        pastedAttachment = await store.saveImage(Buffer.from('exec-image'), 'image/png');
        trackAttachmentTempDir(pastedAttachment);
        return `Please inspect ${pastedAttachment.placeholder}`;
      })
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { success: true, content: 'Image reviewed' },
      sessionId: 'session-1',
    });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    if (pastedAttachment === undefined) {
      throw new Error('Expected the test to save a pasted image attachment.');
    }
    expect(mockCallAIWithRetry.mock.calls[0]?.[0]).toBe(`Please inspect ${pastedAttachment.placeholder}`);
    expect(mockCallAIWithRetry.mock.calls[0]?.[5]).toEqual({
      imageAttachments: [
        {
          placeholder: pastedAttachment.placeholder,
          path: pastedAttachment.tempPath,
        },
      ],
    });
  });

  it('should keep unstored image placeholders as text-only exec input', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('Please keep literal [Image #1] text')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { success: true, content: 'Kept as text' },
      sessionId: 'session-1',
    });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(mockCallAIWithRetry.mock.calls[0]?.[0]).toBe('Please keep literal [Image #1] text');
    expect(mockCallAIWithRetry.mock.calls[0]?.[5]).toEqual({ imageAttachments: [] });
  });

  it('should report unreadable pasted images without calling providers and keep the exec prompt open', async () => {
    let pastedAttachment: InteractiveImageAttachment | undefined;
    mockReadInteractiveInput
      .mockImplementationOnce(async (_prompt, _lang, _availability, imageAttachmentStore) => {
        const store = requireImageAttachmentStore(imageAttachmentStore);
        pastedAttachment = await store.saveImage(Buffer.from('missing-image'), 'image/png');
        trackAttachmentTempDir(pastedAttachment);
        unlinkSync(pastedAttachment.tempPath);
        return `Please inspect ${pastedAttachment.placeholder}`;
      })
      .mockResolvedValueOnce('/cancel');
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let output = '';

    try {
      await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();
      output = consoleLogSpy.mock.calls.map((call) => stripAnsi(call.join(' '))).join('\n');
    } finally {
      consoleLogSpy.mockRestore();
    }

    if (pastedAttachment === undefined) {
      throw new Error('Expected the test to save a pasted image attachment.');
    }
    expect(mockReadInteractiveInput).toHaveBeenCalledTimes(2);
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
    expect(output).toContain('ENOENT');
    expect(output).toContain('Cancelled');
  });

  it('should pass /go referenced pasted images to workflow but not completion when only run artifacts mention placeholders', async () => {
    let pastedAttachment: InteractiveImageAttachment | undefined;
    mockReadInteractiveInput
      .mockImplementationOnce(async (_prompt, _lang, _availability, imageAttachmentStore) => {
        const store = requireImageAttachmentStore(imageAttachmentStore);
        pastedAttachment = await store.saveImage(Buffer.from('go-image'), 'image/png');
        trackAttachmentTempDir(pastedAttachment);
        return `/go Implement this using ${pastedAttachment.placeholder}`;
      })
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry
      .mockResolvedValueOnce({
        result: { success: true, content: 'Executable task using the attached reference image' },
        sessionId: 'session-1',
      })
      .mockResolvedValueOnce({
        result: { success: true, content: 'Execution completed' },
        sessionId: 'session-1',
      });
    mockFormatRunSessionForPrompt.mockReturnValue({
      runStatus: 'completed',
      runReports: '# Review Result\n\nuntrusted report mentions [Image #1]',
      runStepLogs: 'untrusted step log mentions [Image #1]',
    });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    if (pastedAttachment === undefined) {
      throw new Error('Expected the test to save a pasted image attachment.');
    }
    expect(mockCallAIWithRetry.mock.calls[0]?.[5]).toEqual({
      imageAttachments: [
        {
          placeholder: pastedAttachment.placeholder,
          path: pastedAttachment.tempPath,
        },
      ],
    });
    expect(mockCallAIWithRetry.mock.calls[1]?.[5]).toEqual({
      permissionMode: 'readonly',
      imageAttachments: [],
    });
    expect(mockSelectAndExecuteTask.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      attachments: [pastedAttachment],
      interactiveUserInput: true,
      skipTaskList: true,
    }));
  });

  it('should not pass unreferenced pasted images to the generated workflow or completion summary', async () => {
    let referencedAttachment: InteractiveImageAttachment | undefined;
    let unreferencedAttachment: InteractiveImageAttachment | undefined;
    mockReadInteractiveInput
      .mockImplementationOnce(async (_prompt, _lang, _availability, imageAttachmentStore) => {
        const store = requireImageAttachmentStore(imageAttachmentStore);
        referencedAttachment = await store.saveImage(Buffer.from('referenced-go-image'), 'image/png');
        unreferencedAttachment = await store.saveImage(Buffer.from('deleted-go-image'), 'image/png');
        trackAttachmentTempDir(referencedAttachment);
        trackAttachmentTempDir(unreferencedAttachment);
        return `/go Implement this using ${referencedAttachment.placeholder}`;
      })
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry
      .mockResolvedValueOnce({
        result: { success: true, content: 'Executable task using [Image #1]' },
        sessionId: 'session-1',
      })
      .mockResolvedValueOnce({
        result: { success: true, content: 'Execution completed' },
        sessionId: 'session-1',
      });
    mockFormatRunSessionForPrompt.mockReturnValue({
      runStatus: 'completed',
      runReports: '# Review Result\n\napproved with leaked [Image #2]',
      runStepLogs: 'execute/review logs with leaked [Image #2]',
    });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    if (referencedAttachment === undefined || unreferencedAttachment === undefined) {
      throw new Error('Expected the test to save pasted image attachments.');
    }
    expect(mockSelectAndExecuteTask.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      attachments: [referencedAttachment],
      interactiveUserInput: true,
      skipTaskList: true,
    }));
    expect(mockCallAIWithRetry.mock.calls[1]?.[5]).toEqual({
      permissionMode: 'readonly',
      imageAttachments: [
        {
          placeholder: referencedAttachment.placeholder,
          path: referencedAttachment.tempPath,
        },
      ],
    });
  });

  it('should ignore assistant-authored image placeholders when selecting /go and completion attachments', async () => {
    let referencedAttachment: InteractiveImageAttachment | undefined;
    let unreferencedAttachment: InteractiveImageAttachment | undefined;
    mockReadInteractiveInput
      .mockImplementationOnce(async (_prompt, _lang, _availability, imageAttachmentStore) => {
        const store = requireImageAttachmentStore(imageAttachmentStore);
        referencedAttachment = await store.saveImage(Buffer.from('referenced-user-image'), 'image/png');
        unreferencedAttachment = await store.saveImage(Buffer.from('assistant-authored-image'), 'image/png');
        trackAttachmentTempDir(referencedAttachment);
        trackAttachmentTempDir(unreferencedAttachment);
        return `Please inspect ${referencedAttachment.placeholder}`;
      })
      .mockResolvedValueOnce('/go Build the task from the previous user request')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry
      .mockResolvedValueOnce({
        result: { success: true, content: 'Assistant note mentions untrusted [Image #2]' },
        sessionId: 'session-1',
      })
      .mockResolvedValueOnce({
        result: { success: true, content: 'Executable task repeats untrusted [Image #2]' },
        sessionId: 'session-1',
      })
      .mockResolvedValueOnce({
        result: { success: true, content: 'Execution completed' },
        sessionId: 'session-1',
      });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    if (referencedAttachment === undefined || unreferencedAttachment === undefined) {
      throw new Error('Expected the test to save pasted image attachments.');
    }
    const referencedImageAttachment = {
      placeholder: referencedAttachment.placeholder,
      path: referencedAttachment.tempPath,
    };
    expect(mockCallAIWithRetry.mock.calls[1]?.[5]).toEqual({
      imageAttachments: [referencedImageAttachment],
    });
    expect(mockSelectAndExecuteTask.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      attachments: [referencedAttachment],
      interactiveUserInput: true,
      skipTaskList: true,
    }));
    expect(mockCallAIWithRetry.mock.calls[2]?.[5]).toEqual({
      permissionMode: 'readonly',
      imageAttachments: [],
    });
  });

  it('should report unreadable /go pasted images without calling providers and keep the exec prompt open', async () => {
    let pastedAttachment: InteractiveImageAttachment | undefined;
    mockReadInteractiveInput
      .mockImplementationOnce(async (_prompt, _lang, _availability, imageAttachmentStore) => {
        const store = requireImageAttachmentStore(imageAttachmentStore);
        pastedAttachment = await store.saveImage(Buffer.from('missing-go-image'), 'image/png');
        trackAttachmentTempDir(pastedAttachment);
        unlinkSync(pastedAttachment.tempPath);
        return `/go Implement this using ${pastedAttachment.placeholder}`;
      })
      .mockResolvedValueOnce('/cancel');
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let output = '';

    try {
      await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();
      output = consoleLogSpy.mock.calls.map((call) => stripAnsi(call.join(' '))).join('\n');
    } finally {
      consoleLogSpy.mockRestore();
    }

    if (pastedAttachment === undefined) {
      throw new Error('Expected the test to save a pasted image attachment.');
    }
    expect(mockReadInteractiveInput).toHaveBeenCalledTimes(2);
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
    expect(output).toContain('ENOENT');
    expect(output).toContain('Cancelled');
  });

  it('should start with the default config without prompting when user presets exist and no previous config exists', async () => {
    saveExecPreset('project-team', 'Project team', {
      ...DEFAULT_EXEC_CONFIG,
      loop: {
        ...DEFAULT_EXEC_CONFIG.loop,
        smallThreshold: 8,
      },
    }, { projectDir, scope: 'project' });
    saveExecPreset('global-team', 'Global team', {
      ...DEFAULT_EXEC_CONFIG,
      loop: {
        ...DEFAULT_EXEC_CONFIG.loop,
        smallThreshold: 9,
      },
    }, { projectDir, scope: 'global' });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, {})).resolves.toBeUndefined();

    expect(mockSelectOption).not.toHaveBeenCalled();
    const workflow = readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8');
    expect(workflow).toContain(`threshold: ${DEFAULT_EXEC_CONFIG.loop.smallThreshold}`);
  });

  it('should start with the previous config without prompting when it exists', async () => {
    saveLastUsedExecConfig({
      ...DEFAULT_EXEC_CONFIG,
      loop: {
        ...DEFAULT_EXEC_CONFIG.loop,
        smallThreshold: 7,
      },
    }, { globalConfigDir });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, {})).resolves.toBeUndefined();

    expect(mockSelectOption).not.toHaveBeenCalled();
    const workflow = readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8');
    expect(workflow).toContain('threshold: 7');
  });

  it('should run an explicit exec provider config without a configured TAKT provider', async () => {
    mockResolveWorkflowConfigValues.mockReturnValue({
      enableBuiltinWorkflows: true,
      language: 'en',
    });
    saveExecPreset('explicit-provider-team', 'Explicit provider team', {
      ...DEFAULT_EXEC_CONFIG,
      session: {
        provider: 'mock',
        model: 'session-model',
      },
      workers: [
        {
          ...DEFAULT_EXEC_CONFIG.workers[0]!,
          provider: 'mock',
          model: 'worker-model',
        },
      ],
      reviews: [
        {
          ...DEFAULT_EXEC_CONFIG.reviews[0]!,
          provider: 'mock',
          model: 'review-model',
        },
      ],
    }, { projectDir, scope: 'project' });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'explicit-provider-team' })).resolves.toBeUndefined();

    expect(mockGetProvider).toHaveBeenCalledWith('mock');
    expect(mockCallAIWithRetry.mock.calls[0]?.[4]).toMatchObject({
      providerType: 'mock',
      model: 'session-model',
    });
    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
    const judge = workflow.steps.find((step: { name: string }) => step.name === 'review');
    const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
    expect(execute.parallel[0]).toMatchObject({ provider: 'mock', model: 'worker-model' });
    expect(judge.parallel[0]).toMatchObject({ provider: 'mock', model: 'review-model' });
    expect(replan).toMatchObject({ provider: 'mock', model: 'session-model' });
  });

  it('should generate workflows with the provider and model resolved when exec mode starts', async () => {
    let providerModelResolutions = 0;
    mockResolveWorkflowConfigValues.mockImplementation((_cwd, keys) => {
      const requestedKeys = keys ?? [];
      if (requestedKeys.includes('provider') || requestedKeys.includes('model')) {
        providerModelResolutions += 1;
        return providerModelResolutions === 1
          ? {
            enableBuiltinWorkflows: true,
            language: 'en',
            provider: 'claude',
            model: 'opus',
          }
          : {
            enableBuiltinWorkflows: true,
            language: 'en',
            provider: 'mock',
            model: 'changed-model',
          };
      }
      return {
        enableBuiltinWorkflows: true,
        language: 'en',
      };
    });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(providerModelResolutions).toBe(1);
    expect(mockCallAIWithRetry.mock.calls[0]?.[4]).toMatchObject({
      providerType: 'claude',
      model: 'opus',
    });
    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
    const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
    expect(execute.parallel[0]).toMatchObject({ provider: 'claude', model: 'opus' });
    expect(replan).toMatchObject({ provider: 'claude', model: 'opus' });
  });

  it('should start with inherited Claude xhigh effort for the configured default model', async () => {
    mockResolveWorkflowConfigValues.mockReturnValue({
      enableBuiltinWorkflows: true,
      language: 'en',
      provider: 'claude',
      model: 'claude-sonnet-4-5-20250929',
    });
    saveExecPreset('stale-inherited-effort-team', 'Stale inherited effort team', {
      ...DEFAULT_EXEC_CONFIG,
      session: { effort: 'xhigh' },
      workers: [
        {
          ...DEFAULT_EXEC_CONFIG.workers[0]!,
          effort: 'xhigh',
        },
      ],
      reviews: [
        {
          ...DEFAULT_EXEC_CONFIG.reviews[0]!,
          effort: 'xhigh',
        },
      ],
    }, { projectDir, scope: 'project' });
    mockReadInteractiveInput.mockResolvedValueOnce('/cancel');

    await expect(runExecCommand(projectDir, { preset: 'stale-inherited-effort-team' })).resolves.toBeUndefined();

    expect(mockReadInteractiveInput).toHaveBeenCalled();
  });

  it('should localize setup and preset menus for Japanese language', async () => {
    mockResolveWorkflowConfigValues.mockReturnValue({
      enableBuiltinWorkflows: true,
      language: 'ja',
      provider: 'claude',
      model: 'opus',
    });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'preset',
      'load',
      'default',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const teamCall = mockSelectOption.mock.calls.find((call) => call[0] === 'exec エージェント');
    const teamOptions = teamCall?.[1] ?? [];
    expect(teamCall?.[2]).toEqual({ cancelLabel: 'キャンセル' });
    expect(teamOptions.map((option) => option.label)).toEqual(expect.arrayContaining([
      'アシスタントエージェント: claude/opus/なし',
      'ワーカーエージェント: 1',
      'レビューエージェント: 1',
      '再計画エージェント: exec-replan',
      'ループ検知: 3/2/20',
      'プリセット',
      '戻る',
    ]));
    const presetOptions = mockSelectOption.mock.calls.find((call) => call[0] === 'プリセット')?.[1] ?? [];
    expect(presetOptions.map((option) => option.label)).toEqual([
      'プリセットを読み込む',
      '現在のプリセットを保存',
      'プリセットを削除',
      'プリセットをワークフローとしてエクスポート',
      '戻る',
    ]);
    const sourceOptions = mockSelectOption.mock.calls.find((call) => call[0] === 'プリセット読み込み元')?.[1] ?? [];
    expect(sourceOptions.map((option) => option.label)).toEqual([
      'デフォルト',
      'ビルトイン',
      'プロジェクト',
      'グローバル',
    ]);
  });

  it('should apply CLI provider and model overrides to generated workflow and assistant calls', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, {
      preset: 'backend',
      agentOverrides: { provider: 'mock', model: 'override-model' },
    })).resolves.toBeUndefined();

    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
    const judge = workflow.steps.find((step: { name: string }) => step.name === 'review');
    const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
    expect(execute.parallel[0]).toMatchObject({ provider: 'mock', model: 'override-model' });
    expect(judge.parallel[0]).toMatchObject({ provider: 'mock', model: 'override-model' });
    expect(replan).toMatchObject({ provider: 'mock', model: 'override-model' });
    expect(execute.parallel[0]).not.toHaveProperty('provider_options');
    expect(judge.parallel[0]).not.toHaveProperty('provider_options');
    expect(replan).not.toHaveProperty('provider_options');

    expect(existsSync(join(globalConfigDir, 'exec.yaml'))).toBe(false);

    for (const call of mockCallAIWithRetry.mock.calls) {
      const ctx = call[4];
      expect(ctx.providerType).toBe('mock');
      expect(ctx.model).toBe('override-model');
      expect(ctx.providerOptions).toBeUndefined();
    }
  });

  it.each(['cursor', 'copilot', 'kiro'] as const)(
    'should allow CLI provider override to %s without explicit model',
    async (provider) => {
      mockReadInteractiveInput
        .mockResolvedValueOnce('/go Implement a small task')
        .mockResolvedValueOnce('/cancel');
      mockCallAIWithRetry
        .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
        .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

      await expect(runExecCommand(projectDir, {
        preset: 'backend',
        agentOverrides: { provider },
      })).resolves.toBeUndefined();

      const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
      const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
      const judge = workflow.steps.find((step: { name: string }) => step.name === 'review');
      const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
      expect(execute.parallel[0]).toMatchObject({ provider });
      expect(judge.parallel[0]).toMatchObject({ provider });
      expect(replan).toMatchObject({ provider });
      expect(execute.parallel[0].model).toBeNull();
      expect(judge.parallel[0].model).toBeNull();
      expect(replan.model).toBeNull();

      expect(existsSync(join(globalConfigDir, 'exec.yaml'))).toBe(false);

      for (const call of mockCallAIWithRetry.mock.calls) {
        const ctx = call[4];
        expect(ctx.providerType).toBe(provider);
        expect(ctx.model).toBeUndefined();
      }
    },
  );

  it('should reject CLI opencode override with a bare model', async () => {
    await expect(runExecCommand(projectDir, {
      preset: 'backend',
      agentOverrides: { provider: 'opencode', model: 'big-pickle' },
    })).rejects.toThrow(/provider\/model/);

    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
  });

  it('should call the codex exec assistant completion summary with readonly permission mode', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, {
      preset: 'backend',
      agentOverrides: { provider: 'codex', model: 'gpt-5' },
    })).resolves.toBeUndefined();

    expect(mockCallAIWithRetry.mock.calls[1]?.[4]).toEqual(expect.objectContaining({
      providerType: 'codex',
      model: 'gpt-5',
    }));
    expect(mockCallAIWithRetry.mock.calls[1]?.[5]).toEqual({
      permissionMode: 'readonly',
      imageAttachments: [],
    });
  });

  it('should sanitize exec preset metadata when listing presets', async () => {
    const presetDir = join(projectDir, '.takt', 'exec', 'presets');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(join(presetDir, 'unsafe.yaml'), stringifyYaml({
      name: 'unsafe',
      description: 'description \x1b]52;c;secret\x07after',
      session: DEFAULT_EXEC_CONFIG.session,
      replan: DEFAULT_EXEC_CONFIG.replan,
      workers: DEFAULT_EXEC_CONFIG.workers,
      reviews: DEFAULT_EXEC_CONFIG.reviews,
      loop: {
        threshold: DEFAULT_EXEC_CONFIG.loop.smallThreshold,
        large_threshold: DEFAULT_EXEC_CONFIG.loop.largeThreshold,
        max_steps: DEFAULT_EXEC_CONFIG.loop.maxSteps,
      },
    }));
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let output = '';
    try {
      await expect(runExecCommand(projectDir, { list: true })).resolves.toBeUndefined();
      output = consoleLogSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    } finally {
      consoleLogSpy.mockRestore();
    }
    expect(output).toContain('unsafe');
    expect(output).toContain('description after');
    expect(output).not.toContain('\x1b');
    expect(output).not.toContain('secret');
  });

  it('should sanitize setup preset menu metadata before terminal output', async () => {
    saveExecPreset('unsafe', 'team \x1b]52;c;secret\x07description', DEFAULT_EXEC_CONFIG, { projectDir, scope: 'project' });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'preset',
      'load',
      'project',
      null,
      'preset',
      'delete',
      'project',
      null,
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const setupPresetOptions = mockSelectOption.mock.calls
      .map((call) => call[1])
      .flat()
      .filter((option) => option.value === 'unsafe');
    expect(setupPresetOptions).toHaveLength(2);
    expect(setupPresetOptions.map((option) => option.description)).toEqual(
      ['team description', 'team description'],
    );
    for (const option of setupPresetOptions) {
      expect(option.label).toBe('unsafe');
      expect(option.description).not.toContain('\x1b');
      expect(option.description).not.toContain('secret');
    }
  });

  it('should sanitize setup labels and text prompt defaults from loaded config', async () => {
    const presetDir = join(projectDir, '.takt', 'exec', 'presets');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(join(presetDir, 'unsafe.yaml'), stringifyYaml({
      name: 'unsafe',
      description: 'Unsafe team',
      session: {
        provider: 'mock',
        model: 'session\x1b]52;c;secret\x07-model',
      },
      replan: {
        ...DEFAULT_EXEC_CONFIG.replan,
        instruction: 'replan\x1b[2J-instruction',
      },
      workers: [
        {
          ...DEFAULT_EXEC_CONFIG.workers[0],
          provider: 'mock',
          model: 'worker\x1b[2J-model',
          effort: undefined,
          instruction: 'worker\x1b]52;c;secret\x07-instruction',
        },
      ],
      reviews: [
        {
          ...DEFAULT_EXEC_CONFIG.reviews[0],
          provider: 'mock',
          model: 'review\x1b[2J-model',
          effort: undefined,
        },
      ],
      loop: {
        threshold: DEFAULT_EXEC_CONFIG.loop.smallThreshold,
        large_threshold: DEFAULT_EXEC_CONFIG.loop.largeThreshold,
        max_steps: DEFAULT_EXEC_CONFIG.loop.maxSteps,
      },
    }));
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'assistant',
      'model',
      null,
      'back',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'unsafe' })).resolves.toBeUndefined();

    const teamOptions = mockSelectOption.mock.calls[0]?.[1] ?? [];
    expect(teamOptions.find((option) => option.value === 'assistant')?.label).toBe('Assistant agent: mock/session-model/none');
    expect(teamOptions.find((option) => option.value === 'replan')?.label).toBe('Replanning agent: replan-instruction');

    const assistantOptions = mockSelectOption.mock.calls[1]?.[1] ?? [];
    expect(assistantOptions.find((option) => option.value === 'model')?.label).toBe('Model: session-model');
    const modelOptions = mockSelectOption.mock.calls[2]?.[1] ?? [];
    expect(modelOptions.map((option) => option.label)).toEqual([
      'Default (provider default)',
      'mock-model',
      'session-model (current)',
      'Custom input...',
    ]);
  });

  it('should sanitize worker and review setup list labels from loaded config', async () => {
    const unsafeConfig: ExecConfig = {
      ...DEFAULT_EXEC_CONFIG,
      session: {
        provider: 'mock',
        model: 'session-model',
      },
      workers: [
        {
          ...DEFAULT_EXEC_CONFIG.workers[0],
          provider: 'mock',
          model: 'worker\x1b[2J-model',
          effort: undefined,
          instruction: 'worker\x1b]52;c;secret\x07-instruction',
        },
      ],
      reviews: [
        {
          ...DEFAULT_EXEC_CONFIG.reviews[0],
          provider: 'mock',
          model: 'review\x1b[2J-model',
          effort: undefined,
        },
      ],
    };
    saveExecPreset('unsafe-details', 'Unsafe details', unsafeConfig, { projectDir, scope: 'project' });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'back',
      'reviews',
      'back',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'unsafe-details' })).resolves.toBeUndefined();

    const workerOptions = mockSelectOption.mock.calls.find((call) => call[0] === 'Worker agents')?.[1] ?? [];
    const judgeOptions = mockSelectOption.mock.calls.find((call) => call[0] === 'Review agents')?.[1] ?? [];
    const workerLabel = workerOptions.find((option) => option.value === 'edit:0')?.label ?? '';
    const judgeLabel = judgeOptions.find((option) => option.value === 'edit:0')?.label ?? '';
    expect(workerLabel).toContain('worker-model');
    expect(workerLabel).toContain('worker-instruction');
    expect(judgeLabel).toContain('review-model');
    expect(workerLabel).not.toContain('\x1b');
    expect(workerLabel).not.toContain('secret');
    expect(judgeLabel).not.toContain('\x1b');
    expect(judgeLabel).not.toContain('secret');
  });

  it('should sanitize setup facet selection metadata before terminal output', async () => {
    const knowledgeDir = join(projectDir, '.takt', 'facets', 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    writeFileSync(join(knowledgeDir, 'unsafe.md'), '# Unsafe \x1b]52;c;secret\x07Knowledge\n\nBody');
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'knowledge',
      'toggle',
      null,
      'back',
      'back',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const unsafeFacetOption = mockSelectOption.mock.calls
      .map((call) => call[1])
      .flat()
      .find((option) => option.value === 'unsafe');
    expect(unsafeFacetOption?.label).toBe('[ ] unsafe');
    expect(unsafeFacetOption?.description).toBe('Project · Unsafe Knowledge');
    expect(unsafeFacetOption?.description).not.toContain('\x1b');
    expect(unsafeFacetOption?.description).not.toContain('secret');
  });

  it('should sanitize exec assistant responses before terminal output', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('Clarify this task')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry
      .mockResolvedValueOnce({
        result: { success: true, content: 'Hello \x1b]52;c;secret\x07World\x1b[2J!' },
        sessionId: 'session-1',
      });
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let output = '';
    try {
      await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();
      output = consoleLogSpy.mock.calls.map((call) => stripAnsi(call.join(' '))).join('\n');
    } finally {
      consoleLogSpy.mockRestore();
    }
    expect(output).toContain('Hello World!');
    expect(output).not.toContain('\x1b');
    expect(output).not.toContain('secret');
  });

  it('should sanitize generated facet content before terminal output', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('generated-knowledge')
      .mockResolvedValueOnce('Generate sanitized knowledge')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'knowledge',
      'create_ai',
      'project',
      'discard',
      'back',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({
        result: { success: true, content: '# Generated\x1b[2J\n\n\x1b]52;c;secret\x07content' },
        sessionId: 'ai-facet-session',
      });
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let output = '';
    try {
      await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();
      output = consoleLogSpy.mock.calls.map((call) => stripAnsi(call.join(' '))).join('\n');
    } finally {
      consoleLogSpy.mockRestore();
    }
    expect(output).toContain('# Generated\\n\\ncontent');
    expect(output).not.toContain('\x1b');
    expect(output).not.toContain('secret');
  });

  it('should apply session provider change for provider-default model providers', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'assistant',
      'provider',
      'cursor',
      'back',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();
    expect(mockGetProvider).toHaveBeenCalledWith('cursor');
  });

  it('should not synthesize effort when setup changes from unsupported to supported providers', async () => {
    saveExecPreset('opencode-team', 'OpenCode team', {
      ...DEFAULT_EXEC_CONFIG,
      session: {
        provider: 'opencode',
        model: 'opencode/session',
      },
      workers: [
        {
          ...DEFAULT_EXEC_CONFIG.workers[0],
          provider: 'opencode',
          model: 'opencode/worker',
          effort: undefined,
        },
      ],
      reviews: [
        {
          ...DEFAULT_EXEC_CONFIG.reviews[0],
          provider: 'opencode',
          model: 'opencode/review',
          effort: undefined,
        },
      ],
    }, { projectDir, scope: 'project' });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'assistant',
      'provider',
      'claude',
      'back',
      'workers',
      'edit:0',
      'provider',
      'claude',
      'back',
      'back',
      'reviews',
      'edit:0',
      'provider',
      'claude',
      'back',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'opencode-team' })).resolves.toBeUndefined();

    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
    const judge = workflow.steps.find((step: { name: string }) => step.name === 'review');
    const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
    expect(mockCallAIWithRetry.mock.calls[0]?.[4].providerOptions).toBeUndefined();
    expect(execute.parallel[0].provider_options.claude).not.toHaveProperty('effort');
    expect(judge.parallel[0].provider_options.claude).not.toHaveProperty('effort');
    expect(replan.provider_options.claude).not.toHaveProperty('effort');
  });

  it('should hide effort settings for providers without exec effort support', async () => {
    saveExecPreset('opencode-team', 'OpenCode team', {
      ...DEFAULT_EXEC_CONFIG,
      session: {
        provider: 'opencode',
        model: 'opencode/model',
      },
      workers: [
        {
          ...DEFAULT_EXEC_CONFIG.workers[0],
          provider: 'opencode',
          model: 'opencode/worker',
          effort: undefined,
        },
      ],
      reviews: [
        {
          ...DEFAULT_EXEC_CONFIG.reviews[0],
          provider: 'opencode',
          model: 'opencode/review',
          effort: undefined,
        },
      ],
    }, { projectDir, scope: 'project' });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'assistant',
      'back',
      'workers',
      'edit:0',
      'back',
      'back',
      'reviews',
      'edit:0',
      'back',
      'back',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'opencode-team' })).resolves.toBeUndefined();

    const assistantOptions = mockSelectOption.mock.calls.find((call) => call[0] === 'Assistant agent settings')?.[1] ?? [];
    const workerOptions = mockSelectOption.mock.calls.find((call) => call[0] === 'worker-1 settings')?.[1] ?? [];
    const judgeOptions = mockSelectOption.mock.calls.find((call) => call[0] === 'review-1 settings')?.[1] ?? [];
    expect(assistantOptions.some((option) => option.value === 'effort')).toBe(false);
    expect(workerOptions.some((option) => option.value === 'effort')).toBe(false);
    expect(judgeOptions.some((option) => option.value === 'effort')).toBe(false);
  });

  it('should offer default when selecting effort for providers with exec effort support', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'assistant',
      'effort',
      null,
      'back',
      'workers',
      'edit:0',
      'effort',
      null,
      'back',
      'back',
      'reviews',
      'edit:0',
      'effort',
      null,
      'back',
      'back',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const effortOptionSets = mockSelectOption.mock.calls
      .filter((call) => call[0] === 'Effort')
      .map((call) => call[1]);
    expect(effortOptionSets).toHaveLength(3);
    for (const options of effortOptionSets) {
      expect(options.map((option) => option.value)).toEqual(['__default_effort__', 'low', 'medium', 'high', 'xhigh', 'max']);
      expect(options[0]?.label).toContain('Default');
    }
  });

  it('should apply assistant effort changes from setup to exec assistant runtime calls', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'assistant',
      'effort',
      'medium',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(mockCallAIWithRetry.mock.calls[0]?.[4].providerOptions).toEqual({ claude: { effort: 'medium' } });
    expect(mockCallAIWithRetry.mock.calls[1]?.[4].providerOptions).toEqual({ claude: { effort: 'medium' } });
    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
    expect(replan).toMatchObject({
      provider: 'claude',
      model: 'opus',
      provider_options: {
        claude: {
          effort: 'medium',
        },
      },
    });
  });

  it('should keep effort when setup changes Claude models', async () => {
    saveExecPreset('xhigh-team', 'Claude xhigh team', {
      ...DEFAULT_EXEC_CONFIG,
      session: {
        provider: 'claude',
        model: 'claude-opus-4-7',
        effort: 'xhigh',
      },
      workers: [
        {
          ...DEFAULT_EXEC_CONFIG.workers[0]!,
          provider: 'claude',
          model: 'claude-opus-4-7',
          effort: 'xhigh',
        },
      ],
    }, { projectDir, scope: 'project' });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('claude-sonnet-4-5-20250929')
      .mockResolvedValueOnce('claude-sonnet-4-5-20250929')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'assistant',
      'model',
      '__custom_model__',
      'back',
      'workers',
      'edit:0',
      'model',
      '__custom_model__',
      'back',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'xhigh-team' })).resolves.toBeUndefined();

    expect(mockCallAIWithRetry.mock.calls[0]?.[4].providerOptions).toEqual({ claude: { effort: 'xhigh' } });
    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
    const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
    expect(execute.parallel[0]).toMatchObject({ model: 'claude-sonnet-4-5-20250929' });
    expect(execute.parallel[0].provider_options?.claude).toMatchObject({ effort: 'xhigh' });
    expect(replan).toMatchObject({ model: 'claude-sonnet-4-5-20250929' });
    expect(replan.provider_options?.claude).toMatchObject({ effort: 'xhigh' });
    const saved = parseYaml(readFileSync(join(globalConfigDir, 'exec.yaml'), 'utf-8'));
    expect(saved.session).toMatchObject({ model: 'claude-sonnet-4-5-20250929' });
    expect(saved.session).toMatchObject({ effort: 'xhigh' });
    expect(saved.workers[0]).toMatchObject({ model: 'claude-sonnet-4-5-20250929' });
    expect(saved.workers[0]).toMatchObject({ effort: 'xhigh' });
  });

  it('should keep effort when setup changes a Claude model back to provider default', async () => {
    mockResolveWorkflowConfigValues.mockReturnValue({
      enableBuiltinWorkflows: true,
      language: 'en',
      provider: 'claude',
      model: 'claude-sonnet-4-5-20250929',
    });
    saveExecPreset('xhigh-default-team', 'Claude xhigh default team', {
      ...DEFAULT_EXEC_CONFIG,
      session: {
        provider: 'claude',
        model: 'claude-opus-4-7',
        effort: 'xhigh',
      },
    }, { projectDir, scope: 'project' });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'assistant',
      'model',
      '__default_model__',
      'back',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'xhigh-default-team' })).resolves.toBeUndefined();

    const saved = parseYaml(readFileSync(join(globalConfigDir, 'exec.yaml'), 'utf-8'));
    expect(saved.session).not.toHaveProperty('model');
    expect(saved.session).toMatchObject({ effort: 'xhigh' });
  });

  it('should apply assistant effort changes from setup to AI facet calls in the same setup session', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('generated-knowledge')
      .mockResolvedValueOnce('Create knowledge after effort update')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'assistant',
      'effort',
      'medium',
      'back',
      'workers',
      'edit:0',
      'knowledge',
      'create_ai',
      'project',
      'discard',
      'back',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: '# Generated knowledge' }, sessionId: 'ai-facet-session' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(mockCallAIWithRetry.mock.calls[0]?.[4]).toEqual(expect.objectContaining({
      providerType: 'claude',
      model: 'opus',
      providerOptions: { claude: { effort: 'medium' } },
      sessionId: undefined,
    }));
  });

  it('should apply assistant provider and model changes from setup to the replan workflow step', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'assistant',
      'provider',
      'codex',
      'model',
      'gpt-5',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
    expect(replan).toMatchObject({
      provider: 'codex',
      model: 'gpt-5',
    });
    expect(replan).not.toHaveProperty('provider_options');
  });

  it('should omit assistant model when setup changes provider without selecting a model', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'assistant',
      'provider',
      'codex',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
    expect(mockCallAIWithRetry.mock.calls[0]?.[4]).toEqual(expect.objectContaining({
      providerType: 'codex',
      model: undefined,
    }));
    expect(replan).toMatchObject({ provider: 'codex' });
    expect(replan).not.toHaveProperty('model');
  });

  it.each(['cursor', 'copilot', 'kiro'] as const)(
    'should allow setup assistant provider change to %s without model input',
    async (provider) => {
      mockReadInteractiveInput
        .mockResolvedValueOnce('/setup')
        .mockResolvedValueOnce('/go Implement a small task')
        .mockResolvedValueOnce('/cancel');
      mockSelectOptionQueue(
        'assistant',
        'provider',
        provider,
        'back',
        'back',
      );
      mockCallAIWithRetry
        .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
        .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

      await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

      const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
      const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
      expect(mockCallAIWithRetry.mock.calls[0]?.[4]).toEqual(expect.objectContaining({
        providerType: provider,
        model: undefined,
      }));
      expect(replan).toMatchObject({ provider });
      expect(replan.model).toBeNull();
    },
  );

  it.each([
    { target: 'assistant', selectQueue: ['assistant', 'provider', 'cursor', 'back', 'back'] },
    { target: 'worker', selectQueue: ['workers', 'edit:0', 'provider', 'cursor', 'back', 'back', 'back'] },
    { target: 'review', selectQueue: ['reviews', 'edit:0', 'provider', 'cursor', 'back', 'back', 'back'] },
  ] as const)(
    'should omit model when $target provider changes without model input',
    async ({ target, selectQueue }) => {
      mockReadInteractiveInput
        .mockResolvedValueOnce('/setup')
        .mockResolvedValueOnce('/go Implement a small task')
        .mockResolvedValueOnce('/cancel');
      mockSelectOptionQueue(...selectQueue);
      mockCallAIWithRetry
        .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
        .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

      await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

      const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
      const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
      const judge = workflow.steps.find((step: { name: string }) => step.name === 'review');
      const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
      if (target === 'assistant') {
        expect(mockCallAIWithRetry.mock.calls[0]?.[4]).toEqual(expect.objectContaining({
          providerType: 'cursor',
          model: undefined,
        }));
        expect(replan).toMatchObject({ provider: 'cursor' });
        expect(replan.model).toBeNull();
      }
      if (target === 'worker') {
        expect(mockCallAIWithRetry.mock.calls[0]?.[4]).toEqual(expect.objectContaining({
          providerType: 'claude',
          model: 'opus',
        }));
        expect(execute.parallel[0]).toMatchObject({ provider: 'cursor' });
        expect(execute.parallel[0].model).toBeNull();
      }
      if (target === 'review') {
        expect(mockCallAIWithRetry.mock.calls[0]?.[4]).toEqual(expect.objectContaining({
          providerType: 'claude',
          model: 'opus',
        }));
        expect(judge.parallel[0]).toMatchObject({ provider: 'cursor' });
        expect(judge.parallel[0].model).toBeNull();
      }
    },
  );

  it('should reject setup opencode custom model without provider qualifier and keep the existing config', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('big-pickle')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'assistant',
      'provider',
      'opencode',
      'model',
      '__custom_model__',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
    expect(mockCallAIWithRetry.mock.calls[0]?.[4]).toEqual(expect.objectContaining({
      providerType: 'claude',
      model: 'opus',
    }));
    expect(replan).toMatchObject({ provider: 'claude', model: 'opus' });
  });

  it.each([
    ['cursor', ''],
    ['cursor', '   '],
    ['copilot', ''],
    ['copilot', '   '],
    ['kiro', ''],
    ['kiro', '   '],
  ] as const)(
    'should reject blank setup assistant custom model for %s and keep the existing config',
    async (provider, modelInput) => {
      mockReadInteractiveInput
        .mockResolvedValueOnce('/setup')
        .mockResolvedValueOnce(modelInput)
        .mockResolvedValueOnce('/go Implement a small task')
        .mockResolvedValueOnce('/cancel');
      mockSelectOptionQueue(
        'assistant',
        'provider',
        provider,
        'model',
        '__custom_model__',
        'back',
      );
      mockCallAIWithRetry
        .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
        .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

      await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

      const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
      const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
      expect(mockCallAIWithRetry.mock.calls[0]?.[4]).toEqual(expect.objectContaining({
        providerType: 'claude',
        model: 'opus',
      }));
      expect(replan).toMatchObject({ provider: 'claude', model: 'opus' });
    },
  );

  it.each([
    { target: 'worker', section: 'workers', provider: 'cursor', modelInput: '' },
    { target: 'worker', section: 'workers', provider: 'cursor', modelInput: '   ' },
    { target: 'worker', section: 'workers', provider: 'copilot', modelInput: '' },
    { target: 'worker', section: 'workers', provider: 'copilot', modelInput: '   ' },
    { target: 'worker', section: 'workers', provider: 'kiro', modelInput: '' },
    { target: 'worker', section: 'workers', provider: 'kiro', modelInput: '   ' },
    { target: 'review', section: 'reviews', provider: 'cursor', modelInput: '' },
    { target: 'review', section: 'reviews', provider: 'cursor', modelInput: '   ' },
    { target: 'review', section: 'reviews', provider: 'copilot', modelInput: '' },
    { target: 'review', section: 'reviews', provider: 'copilot', modelInput: '   ' },
    { target: 'review', section: 'reviews', provider: 'kiro', modelInput: '' },
    { target: 'review', section: 'reviews', provider: 'kiro', modelInput: '   ' },
  ] as const)(
    'should reject blank setup $target custom model for $provider and keep the existing config',
    async ({ target, section, provider, modelInput }) => {
      mockReadInteractiveInput
        .mockResolvedValueOnce('/setup')
        .mockResolvedValueOnce(modelInput)
        .mockResolvedValueOnce('/go Implement a small task')
        .mockResolvedValueOnce('/cancel');
      mockSelectOptionQueue(
        section,
        'edit:0',
        'provider',
        provider,
        'model',
        '__custom_model__',
        'back',
      );
      mockCallAIWithRetry
        .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
        .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

      await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

      const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
      const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
      const judge = workflow.steps.find((step: { name: string }) => step.name === 'review');
      const actor = target === 'worker' ? execute.parallel[0] : judge.parallel[0];
      expect(mockCallAIWithRetry.mock.calls[0]?.[4]).toEqual(expect.objectContaining({
        providerType: 'claude',
        model: 'opus',
      }));
      expect(actor).toMatchObject({
        provider: 'claude',
        model: 'opus',
      });
    },
  );

  it.each([
    { target: 'worker', section: 'workers', provider: 'cursor', model: 'cursor/gpt-5' },
    { target: 'worker', section: 'workers', provider: 'copilot', model: 'gpt-4.1' },
    { target: 'worker', section: 'workers', provider: 'kiro', model: 'kiro-model' },
    { target: 'review', section: 'reviews', provider: 'cursor', model: 'cursor/gpt-5' },
    { target: 'review', section: 'reviews', provider: 'copilot', model: 'gpt-4.1' },
    { target: 'review', section: 'reviews', provider: 'kiro', model: 'kiro-model' },
  ] as const)(
    'should use explicit setup model input when $target provider changes to $provider',
    async ({ target, section, provider, model }) => {
      mockReadInteractiveInput
        .mockResolvedValueOnce('/setup')
        .mockResolvedValueOnce(model)
        .mockResolvedValueOnce('/go Implement a small task')
        .mockResolvedValueOnce('/cancel');
      mockSelectOptionQueue(
        section,
        'edit:0',
        'provider',
        provider,
        'model',
        '__custom_model__',
        'back',
        'back',
        'back',
      );
      mockCallAIWithRetry
        .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
        .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

      await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

      const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
      const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
      const judge = workflow.steps.find((step: { name: string }) => step.name === 'review');
      const actor = target === 'worker' ? execute.parallel[0] : judge.parallel[0];
      expect(actor).toMatchObject({ provider, model });
    },
  );

  it('should keep setup open across submenus until the main menu returns', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'assistant',
      'provider',
      'codex',
      'back',
      'workers',
      'edit:0',
      'model',
      'haiku',
      'back',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
    const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
    expect(replan).toMatchObject({ provider: 'codex' });
    expect(execute.parallel[0].model).toBe('haiku');
    expect(mockReadInteractiveInput.mock.calls.map((call) => call[0])).toEqual([
      'Assistant> ',
      'Assistant> ',
      'Assistant> ',
    ]);
  });

  it('should use provider model menu candidates and custom model input from setup', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('custom-review-model')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'model',
      'haiku',
      'back',
      'back',
      'reviews',
      'edit:0',
      'model',
      '__custom_model__',
      'back',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const modelOptionSets = mockSelectOption.mock.calls
      .filter((call) => call[0] === 'Model')
      .map((call) => call[1].map((option) => option.value));
    expect(modelOptionSets).toEqual([
      ['__default_model__', 'opus', 'sonnet', 'haiku', '__custom_model__'],
      ['__default_model__', 'opus', 'sonnet', 'haiku', '__custom_model__'],
    ]);
    expect(mockReadInteractiveInput.mock.calls[1]?.[0]).toBe('Custom model (opus): ');
    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
    const judge = workflow.steps.find((step: { name: string }) => step.name === 'review');
    expect(execute.parallel[0].model).toBe('haiku');
    expect(judge.parallel[0].model).toBe('custom-review-model');

    const saved = parseYaml(readFileSync(join(globalConfigDir, 'exec.yaml'), 'utf-8'));
    expect(saved.workers[0]).toMatchObject({ model: 'haiku' });
    expect(saved.workers[0]).not.toHaveProperty('provider');
    expect(saved.reviews[0]).toMatchObject({ model: 'custom-review-model' });
    expect(saved.reviews[0]).not.toHaveProperty('provider');
  });

  it('should not save inherited models when model selection is canceled from setup', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'assistant',
      'model',
      null,
      'back',
      'workers',
      'edit:0',
      'model',
      null,
      'back',
      'back',
      'reviews',
      'edit:0',
      'model',
      null,
      'back',
      'back',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const modelOptionSets = mockSelectOption.mock.calls
      .filter((call) => call[0] === 'Model')
      .map((call) => call[1].map((option) => option.label));
    expect(modelOptionSets).toHaveLength(3);
    for (const labels of modelOptionSets) {
      expect(labels[0]).toBe('Default (provider default) (current)');
      expect(labels).toContain('opus');
    }
    expect(existsSync(join(globalConfigDir, 'exec.yaml'))).toBe(false);
  });

  it('should clear explicit model and effort from setup when default is selected', async () => {
    saveExecPreset('explicit-team', 'Explicit model effort team', {
      ...DEFAULT_EXEC_CONFIG,
      session: {
        provider: 'claude',
        model: 'haiku',
        effort: 'medium',
      },
      workers: [
        {
          ...DEFAULT_EXEC_CONFIG.workers[0]!,
          provider: 'claude',
          model: 'haiku',
          effort: 'low',
        },
      ],
      reviews: [
        {
          ...DEFAULT_EXEC_CONFIG.reviews[0]!,
          provider: 'claude',
          model: 'haiku',
          effort: 'medium',
        },
      ],
    }, { projectDir, scope: 'project' });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'assistant',
      'model',
      '__default_model__',
      'effort',
      '__default_effort__',
      'back',
      'workers',
      'edit:0',
      'model',
      '__default_model__',
      'effort',
      '__default_effort__',
      'back',
      'back',
      'reviews',
      'edit:0',
      'model',
      '__default_model__',
      'effort',
      '__default_effort__',
      'back',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'explicit-team' })).resolves.toBeUndefined();

    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
    const judge = workflow.steps.find((step: { name: string }) => step.name === 'review');
    const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
    expect(execute.parallel[0].model).toBe('opus');
    expect(judge.parallel[0].model).toBe('opus');
    expect(replan.model).toBe('opus');
    expect(execute.parallel[0].provider_options.claude).not.toHaveProperty('effort');
    expect(judge.parallel[0].provider_options.claude).not.toHaveProperty('effort');
    expect(replan.provider_options.claude).not.toHaveProperty('effort');
    expect(mockCallAIWithRetry.mock.calls[0]?.[4].providerOptions).toBeUndefined();

    const saved = parseYaml(readFileSync(join(globalConfigDir, 'exec.yaml'), 'utf-8'));
    expect(saved.session).not.toHaveProperty('model');
    expect(saved.session).not.toHaveProperty('effort');
    expect(saved.workers[0]).not.toHaveProperty('model');
    expect(saved.workers[0]).not.toHaveProperty('effort');
    expect(saved.reviews[0]).not.toHaveProperty('model');
    expect(saved.reviews[0]).not.toHaveProperty('effort');
  });

  it('should apply worker and review effort changes from setup to generated workflow', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'effort',
      'low',
      'back',
      'back',
      'reviews',
      'edit:0',
      'effort',
      'medium',
      'back',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
    const judge = workflow.steps.find((step: { name: string }) => step.name === 'review');
    expect(execute.parallel[0].provider_options.claude.effort).toBe('low');
    expect(judge.parallel[0].provider_options.claude.effort).toBe('medium');

    const saved = parseYaml(readFileSync(join(globalConfigDir, 'exec.yaml'), 'utf-8'));
    expect(saved.workers[0]).toMatchObject({ effort: 'low' });
    expect(saved.workers[0]).not.toHaveProperty('provider');
    expect(saved.workers[0]).not.toHaveProperty('model');
    expect(saved.reviews[0]).toMatchObject({ effort: 'medium' });
    expect(saved.reviews[0]).not.toHaveProperty('provider');
    expect(saved.reviews[0]).not.toHaveProperty('model');
  });

  it('should route suffix setup commands through the exec slash command matcher', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('configure team /setup')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'assistant',
      'provider',
      'cursor',
      'back',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(mockGetProvider).toHaveBeenCalledWith('cursor');
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
  });

  it('should clear unsupported worker effort when setup changes provider', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'provider',
      'opencode',
      'back',
      'back',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();
  });

  it('should keep exec assistant session when setup changes only worker settings', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('Clarify this task')
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'provider',
      'opencode',
      'back',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Clarified task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(mockCallAIWithRetry.mock.calls[1]?.[4]).toEqual(expect.objectContaining({
      sessionId: 'session-1',
    }));
  });

  it('should reset exec assistant session when setup changes assistant provider', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('Clarify this task')
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'assistant',
      'provider',
      'cursor',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Clarified task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-2' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-2' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(mockCallAIWithRetry.mock.calls[1]?.[4]).toEqual(expect.objectContaining({
      providerType: 'cursor',
      sessionId: undefined,
    }));
  });

  it('should not save last-used config after /go when setup was not changed', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(existsSync(join(globalConfigDir, 'exec.yaml'))).toBe(false);
    expect(mockSelectAndExecuteTask).toHaveBeenCalledOnce();
  });

  it('should display error and continue loop when workflow execution fails', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry.mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' });
    mockSelectAndExecuteTask.mockRejectedValueOnce(new Error('workflow failed'));

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(existsSync(join(globalConfigDir, 'exec.yaml'))).toBe(false);
  });

  it('should display error and continue loop when assistant call fails during conversation', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('Clarify this task')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry.mockResolvedValueOnce({ result: null, sessionId: undefined });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();
  });

  it('should preserve exec assistant session and history when assistant call fails', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('Seed message')
      .mockResolvedValueOnce('Broken message')
      .mockResolvedValueOnce('Working message')
      .mockResolvedValueOnce('/go')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Seed response' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: null, sessionId: undefined })
      .mockResolvedValueOnce({ result: { success: true, content: 'OK' }, sessionId: 'session-2' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Task instruction' }, sessionId: 'session-3' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Summary' }, sessionId: 'session-4' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(mockCallAIWithRetry.mock.calls[1]?.[4]).toEqual(expect.objectContaining({
      sessionId: 'session-1',
    }));
    expect(mockCallAIWithRetry.mock.calls[2]?.[4]).toEqual(expect.objectContaining({
      sessionId: 'session-1',
    }));
    expect(mockCallAIWithRetry.mock.calls[3]?.[4]).toEqual(expect.objectContaining({
      sessionId: 'session-2',
    }));

    const instructionCall = mockCallAIWithRetry.mock.calls[3]!;
    const instructionPrompt = instructionCall[0] as string;
    expect(instructionPrompt).not.toContain('Broken message');
    expect(instructionPrompt).toContain('Seed message');
    expect(instructionPrompt).toContain('Working message');
  });

  it('should display error and continue loop when assistant call returns blocked status', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('Clarify this task')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { success: false, content: 'Provider returned blocked status' },
      sessionId: undefined,
    });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();
  });

  it('should display error and continue loop when completed review reports are missing', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry.mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' });
    mockLoadRunSessionContext.mockReturnValueOnce({
      task: 'Executable task',
      workflow: 'exec-test',
      status: 'completed',
      stepLogs: [],
      reports: [],
    });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(existsSync(join(globalConfigDir, 'exec.yaml'))).toBe(false);
  });

  it('should not create workflow or last-used config for empty /go with no conversation', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/go')
      .mockResolvedValueOnce('/cancel');

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(existsSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'))).toBe(false);
    expect(existsSync(join(globalConfigDir, 'exec.yaml'))).toBe(false);
    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
  });

  it('should display error and continue menu when unsafe actor name is entered from setup', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('../worker')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'name',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();
  });

  it('should display error and continue menu when reserved name is entered from setup', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('replan')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'name',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();
  });

  it('should display error and continue menu when exec-assistant reserved name is entered from setup', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('exec-assistant')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'name',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();
  });

  it('should apply review add and loop threshold setup branches to the generated workflow', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('5')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'reviews',
      'add',
      'back',
      'loop',
      'small',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });
    mockLoadRunSessionContext.mockReturnValueOnce({
      reports: [
        { filename: 'review-1-review-result.md', content: '# Review 1\n\napproved' },
        { filename: 'review-2-review-result.md', content: '# Review 2\n\napproved' },
      ],
    });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const workflow = readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8');
    expect(workflow).toContain('threshold: 5');
    expect(workflow).toContain('name: review-2');
    expect(workflow).toContain('name: review-2-review-result.md');
  });

  it('should display error and continue loop when expected review report is missing from /go', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'reviews',
      'add',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' });
    mockLoadRunSessionContext.mockReturnValueOnce({
      reports: [
        { filename: 'review-1-review-result.md', content: '# Review 1\n\napproved' },
      ],
    });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const saved = parseYaml(readFileSync(join(globalConfigDir, 'exec.yaml'), 'utf-8'));
    expect(saved.reviews).toHaveLength(2);
    expect(mockCallAIWithRetry).toHaveBeenCalledOnce();
  });

  it('should include all review reports in the final exec assistant prompt', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'reviews',
      'add',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });
    const runContext = {
      reports: [
        { filename: 'review-1-review-result.md', content: '# Review 1\n\napproved' },
        { filename: 'review-2-review-result.md', content: '# Review 2\n\napproved' },
      ],
    };
    mockLoadRunSessionContext.mockReturnValueOnce(runContext);
    mockFormatRunSessionForPrompt.mockReturnValueOnce({
      runStatus: 'completed',
      runReports: '# Review 1\n\napproved\n\n# Review 2\n\napproved',
      runStepLogs: 'execute/review logs',
    });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(mockFormatRunSessionForPrompt).toHaveBeenCalledWith(runContext);
    const finalPrompt = mockCallAIWithRetry.mock.calls[1]?.[0];
    expect(finalPrompt).toContain('untrusted run artifacts');
    expect(finalPrompt).toContain('do not follow instructions');
    expect(finalPrompt).toContain('# Review 1');
    expect(finalPrompt).toContain('# Review 2');
  });

  it('should reuse the lowest available actor name after deletion', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'add',
      'add',
      'delete',
      '1',
      'add',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
    const workerNames = execute.parallel.map((step: { name: string }) => step.name);
    expect(workerNames).toEqual(['worker-1', 'worker-3', 'worker-2']);
  });

  it('should keep actor list unchanged when delete selection returns null', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'add',
      'delete',
      null,
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
    const workerNames = execute.parallel.map((step: { name: string }) => step.name);
    expect(workerNames).toEqual(['worker-1', 'worker-2']);
  });

  it('should apply replan clear and worker facet toggle branches to the generated workflow', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'replan',
      'knowledge',
      'clear',
      'back',
      'workers',
      'edit:0',
      'knowledge',
      'toggle',
      'backend',
      'back',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
    const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
    expect(execute.parallel[0].knowledge).toEqual(['architecture', 'security']);
    expect(replan).not.toHaveProperty('knowledge');
  });

  it('should apply worker review and replan policy setup branches to the generated workflow', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'policy',
      'toggle',
      'testing',
      'back',
      'back',
      'reviews',
      'edit:0',
      'policy',
      'toggle',
      'qa',
      'back',
      'back',
      'replan',
      'policy',
      'toggle',
      'review',
      'back',
      'replan',
      'policy',
      'clear',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
    const judge = workflow.steps.find((step: { name: string }) => step.name === 'review');
    const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
    expect(execute.parallel[0].policy).toEqual(['coding']);
    expect(judge.parallel[0].policy).toEqual(['review', 'qa']);
    expect(replan).not.toHaveProperty('policy');
  });

  it('should load presets from setup before generating workflow', async () => {
    saveExecPreset('loaded-team', 'Loaded team', {
      ...DEFAULT_EXEC_CONFIG,
      loop: {
        ...DEFAULT_EXEC_CONFIG.loop,
        smallThreshold: 8,
      },
    }, { projectDir, scope: 'project' });
    saveExecPreset('loaded-team', 'Loaded global team', {
      ...DEFAULT_EXEC_CONFIG,
      loop: {
        ...DEFAULT_EXEC_CONFIG.loop,
        smallThreshold: 9,
      },
    }, { projectDir, scope: 'global' });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'preset',
      'load',
      'global',
      'loaded-team',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const workflow = readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8');
    expect(workflow).toContain('threshold: 9');
  });

  it('should keep inherited effort from presets loaded in setup before generating workflow', async () => {
    mockResolveWorkflowConfigValues.mockReturnValue({
      enableBuiltinWorkflows: true,
      language: 'en',
      provider: 'claude',
      model: 'claude-sonnet-4-5-20250929',
    });
    saveExecPreset('stale-loaded-team', 'Stale loaded team', {
      ...DEFAULT_EXEC_CONFIG,
      session: { effort: 'xhigh' },
      workers: [
        {
          ...DEFAULT_EXEC_CONFIG.workers[0]!,
          effort: 'xhigh',
        },
      ],
      reviews: [
        {
          ...DEFAULT_EXEC_CONFIG.reviews[0]!,
          effort: 'xhigh',
        },
      ],
    }, { projectDir, scope: 'project' });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'preset',
      'load',
      'project',
      'stale-loaded-team',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
    const judge = workflow.steps.find((step: { name: string }) => step.name === 'review');
    const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
    expect(execute.parallel[0].provider_options?.claude).toMatchObject({ effort: 'xhigh' });
    expect(judge.parallel[0].provider_options?.claude).toMatchObject({ effort: 'xhigh' });
    expect(replan.provider_options?.claude).toMatchObject({ effort: 'xhigh' });
    const saved = parseYaml(readFileSync(join(globalConfigDir, 'exec.yaml'), 'utf-8'));
    expect(saved.session).toMatchObject({ effort: 'xhigh' });
    expect(saved.workers[0]).toMatchObject({ effort: 'xhigh' });
    expect(saved.reviews[0]).toMatchObject({ effort: 'xhigh' });
  });

  it('should load the default configuration from setup before generating workflow', async () => {
    saveExecPreset('start-team', 'Start team', {
      ...DEFAULT_EXEC_CONFIG,
      loop: {
        ...DEFAULT_EXEC_CONFIG.loop,
        smallThreshold: 8,
      },
    }, { projectDir, scope: 'project' });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'preset',
      'load',
      'default',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'start-team' })).resolves.toBeUndefined();

    const workflow = readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8');
    expect(workflow).toContain(`threshold: ${DEFAULT_EXEC_CONFIG.loop.smallThreshold}`);
  });

  it('should save setup-loaded default config before canceling the exec session', async () => {
    mockResolveWorkflowConfigValues.mockReturnValue({
      enableBuiltinWorkflows: true,
      language: 'en',
      provider: 'codex',
      model: 'gpt-5',
    });
    saveLastUsedExecConfig({
      ...DEFAULT_EXEC_CONFIG,
      session: {
        provider: 'claude',
        model: 'opus',
        effort: 'high',
      },
      workers: [
        {
          ...DEFAULT_EXEC_CONFIG.workers[0]!,
          provider: 'claude',
          model: 'opus',
          effort: 'high',
        },
      ],
      reviews: [
        {
          ...DEFAULT_EXEC_CONFIG.reviews[0]!,
          provider: 'claude',
          model: 'opus',
          effort: 'high',
        },
      ],
    }, { globalConfigDir });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'preset',
      'load',
      'default',
      'back',
    );

    await expect(runExecCommand(projectDir, {})).resolves.toBeUndefined();

    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
    const saved = parseYaml(readFileSync(join(globalConfigDir, 'exec.yaml'), 'utf-8'));
    expect(saved.session).toEqual({});
    expect(saved.workers[0]).not.toHaveProperty('provider');
    expect(saved.workers[0]).not.toHaveProperty('model');
    expect(saved.workers[0]).not.toHaveProperty('effort');
    expect(saved.reviews[0]).not.toHaveProperty('provider');
    expect(saved.reviews[0]).not.toHaveProperty('model');
    expect(saved.reviews[0]).not.toHaveProperty('effort');
  });

  it('should save approved AI edits for existing instruction facets', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('Make the worker require tests')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'instruction',
      'ai_edit',
      'project',
      'save',
      'back',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: '# Edited worker instruction' }, sessionId: 'ai-facet-session' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(mockCallAIWithRetry.mock.calls[0]?.[0]).toContain('Make the worker require tests');
    expect(readFileSync(join(projectDir, '.takt', 'facets', 'instructions', 'exec-worker.md'), 'utf-8')).toBe('# Edited worker instruction');
  });

  it('should save Japanese AI edits for existing instruction facets', async () => {
    mockResolveWorkflowConfigValues.mockReturnValue({
      enableBuiltinWorkflows: true,
      language: 'ja',
      provider: 'claude',
      model: 'opus',
    });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('ワーカーにテストを要求して')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'instruction',
      'ai_edit',
      'project',
      'save',
      'back',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: '# 編集済みワーカー指示' }, sessionId: 'ai-facet-session' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(readFileSync(join(projectDir, '.takt', 'facets', 'instructions', 'exec-worker.md'), 'utf-8')).toBe('# 編集済みワーカー指示');
  });

  it('should exclude builtin instruction facets from select existing when builtin facets are disabled', async () => {
    mockResolveWorkflowConfigValues.mockReturnValue({
      enableBuiltinWorkflows: false,
      language: 'en',
      provider: 'claude',
      model: 'opus',
    });
    mkdirSync(join(projectDir, '.takt', 'facets', 'instructions'), { recursive: true });
    mkdirSync(join(globalConfigDir, 'facets', 'instructions'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'facets', 'instructions', 'project-instruction.md'), '# Project Instruction\n');
    writeFileSync(join(globalConfigDir, 'facets', 'instructions', 'user-instruction.md'), '# User Instruction\n');
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'instruction',
      'select',
      'project-instruction',
      'back',
      'back',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const selectOptions = mockSelectOption.mock.calls.find((call) => call[0] === 'Select instructions facet')?.[1] ?? [];
    expect(selectOptions.map((option) => option.value).sort()).toEqual(['project-instruction', 'user-instruction']);
    expect(selectOptions.some((option) => option.value === 'exec-worker')).toBe(false);
    expect(selectOptions.some((option) => option.description?.startsWith('builtin'))).toBe(false);
  });

  it('should exclude builtin knowledge facets from toggle existing when builtin facets are disabled', async () => {
    mockResolveWorkflowConfigValues.mockReturnValue({
      enableBuiltinWorkflows: false,
      language: 'en',
      provider: 'claude',
      model: 'opus',
    });
    mkdirSync(join(projectDir, '.takt', 'facets', 'knowledge'), { recursive: true });
    mkdirSync(join(globalConfigDir, 'facets', 'knowledge'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'facets', 'knowledge', 'project-knowledge.md'), '# Project Knowledge\n');
    writeFileSync(join(globalConfigDir, 'facets', 'knowledge', 'user-knowledge.md'), '# User Knowledge\n');
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'knowledge',
      'toggle',
      'project-knowledge',
      'back',
      'back',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const toggleOptions = mockSelectOption.mock.calls.find((call) => call[0] === 'Toggle knowledge facet')?.[1] ?? [];
    expect(toggleOptions.map((option) => option.value).sort()).toEqual(['project-knowledge', 'user-knowledge']);
    expect(toggleOptions.some((option) => ['architecture', 'backend', 'security'].includes(option.value))).toBe(false);
    expect(toggleOptions.some((option) => option.description?.startsWith('builtin'))).toBe(false);
  });

  it('should not read builtin facet content from setup when builtin facets are disabled', async () => {
    mockResolveWorkflowConfigValues.mockReturnValue({
      enableBuiltinWorkflows: false,
      language: 'en',
      provider: 'claude',
      model: 'opus',
    });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'instruction',
      'ai_edit',
      'project',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
  });

  it('should display setup error for project instruction symlinks before AI facet edit content is sent', async () => {
    const externalDir = mkdtempSync(join(tmpdir(), 'takt-exec-facet-external-'));
    const secretPath = join(externalDir, 'secret.md');
    const instructionDir = join(projectDir, '.takt', 'facets', 'instructions');
    try {
      mkdirSync(instructionDir, { recursive: true });
      writeFileSync(secretPath, '# Secret\n\nprivate content', 'utf-8');
      symlinkSync(secretPath, join(instructionDir, 'exec-worker.md'));
      mockReadInteractiveInput
        .mockResolvedValueOnce('/setup')
        .mockResolvedValueOnce('/cancel');
      mockSelectOptionQueue(
        'workers',
        'edit:0',
        'instruction',
        'ai_edit',
        'project',
      );

      await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

      expect(mockCallAIWithRetry).not.toHaveBeenCalled();
      expect(readFileSync(secretPath, 'utf-8')).toBe('# Secret\n\nprivate content');
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('should display setup error for project instruction parent symlinks before falling back to builtin content', async () => {
    const externalDir = mkdtempSync(join(tmpdir(), 'takt-exec-facet-parent-external-'));
    try {
      mkdirSync(join(projectDir, '.takt', 'facets'), { recursive: true });
      symlinkSync(externalDir, join(projectDir, '.takt', 'facets', 'instructions'));
      mockReadInteractiveInput
        .mockResolvedValueOnce('/setup')
        .mockResolvedValueOnce('/cancel');
      mockSelectOptionQueue(
        'workers',
        'edit:0',
        'instruction',
        'ai_edit',
        'project',
      );

      await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

      expect(mockCallAIWithRetry).not.toHaveBeenCalled();
      expect(existsSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'))).toBe(false);
      expect(existsSync(join(externalDir, 'exec-worker.md'))).toBe(false);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('should display setup error for project instruction writes when the facet parent directory is a symlink', async () => {
    const externalDir = mkdtempSync(join(tmpdir(), 'takt-exec-facet-parent-external-'));
    try {
      mkdirSync(join(projectDir, '.takt'), { recursive: true });
      symlinkSync(externalDir, join(projectDir, '.takt', 'facets'));
      mockReadInteractiveInput
        .mockResolvedValueOnce('/setup')
        .mockResolvedValueOnce('Make the worker require tests')
        .mockResolvedValueOnce('/cancel');
      mockSelectOptionQueue(
        'workers',
        'edit:0',
        'instruction',
        'ai_edit',
        'project',
        'save',
      );
      mockCallAIWithRetry.mockResolvedValueOnce({
        result: { success: true, content: '# Edited worker instruction' },
        sessionId: 'ai-facet-session',
      });

      await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

      expect(existsSync(join(externalDir, 'instructions', 'exec-worker.md'))).toBe(false);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('should save and delete project presets from setup', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('saved-team')
      .mockResolvedValueOnce('Saved team')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'preset',
      'save',
      'project',
      'preset',
      'delete',
      'project',
      'saved-team',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(existsSync(join(projectDir, '.takt', 'exec', 'presets', 'saved-team.yaml'))).toBe(false);
  });

  it.each([
    ['name prompt', [null], 'custom'],
    ['description prompt', ['custom-team', null], 'custom-team'],
  ] as const)(
    'should not save a project preset when the %s is cancelled',
    async (_caseName, promptInputs, presetName) => {
      mockReadInteractiveInput
        .mockResolvedValueOnce('/setup');
      for (const input of promptInputs) {
        mockReadInteractiveInput.mockResolvedValueOnce(input);
      }
      mockReadInteractiveInput.mockResolvedValueOnce('/cancel');
      mockSelectOptionQueue(
        'preset',
        'save',
        'project',
        'back',
      );

      await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

      expect(existsSync(join(projectDir, '.takt', 'exec', 'presets', `${presetName}.yaml`))).toBe(false);
    },
  );

  it('should delete a global preset from setup when a project preset has the same name', async () => {
    saveExecPreset('shared-team', 'Project shared team', DEFAULT_EXEC_CONFIG, { projectDir, scope: 'project' });
    saveExecPreset('shared-team', 'Global shared team', DEFAULT_EXEC_CONFIG, { projectDir, scope: 'global' });
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'preset',
      'delete',
      'global',
      'shared-team',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(existsSync(join(projectDir, '.takt', 'exec', 'presets', 'shared-team.yaml'))).toBe(true);
    expect(existsSync(join(globalConfigDir, 'exec', 'presets', 'shared-team.yaml'))).toBe(false);
  });

  it('should not persist or attach AI-generated facets when the user rejects them', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('generated-knowledge')
      .mockResolvedValueOnce('Create knowledge for local context')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'knowledge',
      'create_ai',
      'project',
      'discard',
      'back',
      'back',
      'back',
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: '# Generated knowledge' }, sessionId: 'ai-facet-session' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(existsSync(join(projectDir, '.takt', 'facets', 'knowledge', 'generated-knowledge.md'))).toBe(false);
    const workflow = readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8');
    expect(workflow).not.toContain('generated-knowledge');
  });

  it('should display setup error for project AI-generated facet creation when the target is a symlink', async () => {
    const externalDir = mkdtempSync(join(tmpdir(), 'takt-exec-create-facet-external-'));
    const externalPath = join(externalDir, 'generated-knowledge.md');
    const projectKnowledgeDir = join(projectDir, '.takt', 'facets', 'knowledge');
    try {
      mkdirSync(projectKnowledgeDir, { recursive: true });
      writeFileSync(externalPath, '# External\n\nunchanged', 'utf-8');
      symlinkSync(externalPath, join(projectKnowledgeDir, 'generated-knowledge.md'));
      mockReadInteractiveInput
        .mockResolvedValueOnce('/setup')
        .mockResolvedValueOnce('generated-knowledge')
        .mockResolvedValueOnce('Create knowledge for local context')
        .mockResolvedValueOnce('/cancel');
      mockSelectOptionQueue(
        'workers',
        'edit:0',
        'knowledge',
        'create_ai',
        'project',
        'save',
      );
      mockCallAIWithRetry.mockResolvedValueOnce({
        result: { success: true, content: '# Generated knowledge' },
        sessionId: 'ai-facet-session',
      });

      await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

      expect(readFileSync(externalPath, 'utf-8')).toBe('# External\n\nunchanged');
      expect(existsSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'))).toBe(false);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('should cancel AI facet generation before assistant call when consultation input is canceled', async () => {
    mockReadInteractiveInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('generated-knowledge')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'knowledge',
      'create_ai',
      'project',
      'back',
      'back',
      'back',
    );

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
    expect(existsSync(join(projectDir, '.takt', 'facets', 'knowledge', 'generated-knowledge.md'))).toBe(false);
  });
});
