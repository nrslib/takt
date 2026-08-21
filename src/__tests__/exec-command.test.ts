import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveNonWorkflowProviderOptions,
  resolveWorkflowConfigValues,
} from '../infra/config/index.js';
import { getProvider } from '../infra/providers/index.js';
import { readMultilineInput } from '../features/interactive/lineEditor.js';
import type { ImageAttachmentStore, InteractiveImageAttachment } from '../features/interactive/imageAttachments.js';
import { callAIWithRetry } from '../features/interactive/aiCaller.js';
import { formatRunSessionForPrompt, loadRunSessionContext } from '../features/interactive/runSessionReader.js';
import { selectAndExecuteTask } from '../features/tasks/index.js';
import { runExecCommand } from '../features/exec/index.js';
import { createExecSessionContext, type ExecSessionContext } from '../features/exec/assistantSession.js';
import { DEFAULT_EXEC_CONFIG } from '../features/exec/defaults.js';
import { saveExecPreset, saveLastUsedExecConfig } from '../features/exec/presetStore.js';
import type { ExecActorConfig, ExecConfig, ResolvedExecConfig } from '../features/exec/types.js';
import { selectMultipleOptions, selectOption, type SelectOptionItem } from '../shared/prompt/index.js';
import { stripAnsi } from '../shared/utils/text.js';

const execAttachmentStores = vi.hoisted(() => ({ stores: [] as ImageAttachmentStore[] }));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(() => ({ setup: vi.fn() })),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValue: vi.fn(() => 'en'),
  resolveWorkflowConfigValues: vi.fn(() => ({
    enableBuiltinWorkflows: true,
    language: 'en',
  })),
  resolveNonWorkflowProviderOptions: vi.fn((_cwd: string, options?: unknown) => options),
}));

// exec resolves its provider/model default through the shared compiled provider environment
// (issue #1136). This suite controls the exec default provider/model via the mocked
// resolveWorkflowConfigValues, so delegate the compiled-environment stub to it to preserve behavior.
vi.mock('../infra/config/runtime-provider/provider-environment.js', () => ({
  resolveAuxiliaryProviderEnvironment: vi.fn((cwd: string) => {
    const config = resolveWorkflowConfigValues(cwd, ['provider', 'model']) as {
      provider?: unknown;
      model?: unknown;
    };
    return { provider: config.provider, model: config.model };
  }),
}));

vi.mock('../features/interactive/lineEditor.js', () => ({
  readMultilineInput: vi.fn(),
}));

// The exec run owns its image attachment store now that the input line no
// longer carries one, so the tests reach it the same way the run does.
vi.mock('../features/interactive/imageAttachments.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../features/interactive/imageAttachments.js')>();
  return {
    ...actual,
    createSessionImageAttachmentStore: (
      ...args: Parameters<typeof actual.createSessionImageAttachmentStore>
    ) => {
      const store = actual.createSessionImageAttachmentStore(...args);
      execAttachmentStores.stores.push(store);
      return store;
    },
  };
});

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
  selectMultipleOptions: vi.fn(),
}));

const mockReadMultilineInput = vi.mocked(readMultilineInput);
const mockSelectOption = vi.mocked(selectOption);
const mockSelectMultipleOptions = vi.mocked(selectMultipleOptions);
const mockResolveWorkflowConfigValues = vi.mocked(resolveWorkflowConfigValues);
const mockResolveNonWorkflowProviderOptions = vi.mocked(resolveNonWorkflowProviderOptions);
const mockGetProvider = vi.mocked(getProvider);
const mockCallAIWithRetry = vi.mocked(callAIWithRetry);
const mockSelectAndExecuteTask = vi.mocked(selectAndExecuteTask);
const mockLoadRunSessionContext = vi.mocked(loadRunSessionContext);
const mockFormatRunSessionForPrompt = vi.mocked(formatRunSessionForPrompt);
const execAttachmentTempDirs = new Set<string>();
const defaultExecSkillProviderOptions = {
  codex: { skills: { repo: true, user: true } },
} as const;

/** The store the running exec session created for this run's pasted images. */
function requireExecAttachmentStore(): ImageAttachmentStore {
  const store = execAttachmentStores.stores.at(-1);
  if (store === undefined) {
    throw new Error('Expected the exec run to create an image attachment store.');
  }
  return store;
}

function trackAttachmentTempDir(attachment: InteractiveImageAttachment): void {
  execAttachmentTempDirs.add(dirname(dirname(attachment.tempPath)));
}

/**
 * The suite controls a handful of config values; exec reads no others, so the
 * stubs stay small rather than reproducing a whole loaded config.
 */
type LoadedConfigValues = ReturnType<typeof resolveWorkflowConfigValues>;
type RunSessionContextStub = ReturnType<typeof loadRunSessionContext>;
type RunSessionPromptStub = ReturnType<typeof formatRunSessionForPrompt>;

function setWorkflowConfigValues(values: unknown): void {
  mockResolveWorkflowConfigValues.mockReturnValue(values as LoadedConfigValues);
}

function setWorkflowConfigValuesImplementation(
  implementation: (cwd: string, keys: readonly string[]) => unknown,
): void {
  mockResolveWorkflowConfigValues.mockImplementation(
    ((cwd: string, keys: readonly string[]) =>
      implementation(cwd, keys) as LoadedConfigValues) as typeof resolveWorkflowConfigValues,
  );
}

/** Only the fields exec reads; the rest of a run session is not consulted. */
function runSessionContext(context: unknown): RunSessionContextStub {
  return context as RunSessionContextStub;
}

function runSessionPrompt(prompt: unknown): RunSessionPromptStub {
  return prompt as RunSessionPromptStub;
}

function setRunSessionContext(context: unknown): void {
  mockLoadRunSessionContext.mockReturnValue(runSessionContext(context));
}

function setRunSessionPrompt(prompt: unknown): void {
  mockFormatRunSessionForPrompt.mockReturnValue(runSessionPrompt(prompt));
}

/** Exec only calls `setup` on the provider in these tests. */
function stubProvider(): ReturnType<typeof getProvider> {
  return { setup: vi.fn() } as unknown as ReturnType<typeof getProvider>;
}

/** The default config as the run resolves it, with provider and model filled in. */
function resolvedDefaultExecConfig(): ResolvedExecConfig {
  return {
    ...DEFAULT_EXEC_CONFIG,
    session: { ...DEFAULT_EXEC_CONFIG.session, provider: 'claude', model: 'opus' },
  } as ResolvedExecConfig;
}

/** `noUncheckedIndexedAccess` makes a bare index optional; the defaults are not. */
function defaultActor(actors: readonly ExecActorConfig[], index: number): ExecActorConfig {
  const actor = actors[index];
  if (actor === undefined) {
    throw new Error(`Expected a default exec actor at index ${index}.`);
  }
  return actor;
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

function mockSelectMultipleOptionsQueue(...values: Array<string[] | null>): void {
  const queue = [...values];
  mockSelectMultipleOptions.mockImplementation(<T extends string>(
    message: string,
    options: SelectOptionItem<T>[],
  ): Promise<T[] | null> => {
    const value = queue.shift();
    if (value === undefined) {
      throw new Error(`No queued selectMultipleOptions value for "${message}"`);
    }
    if (options.length === 0 && value !== null) {
      throw new Error(`Queued selectMultipleOptions must be null when "${message}" has no options`);
    }
    if (value === null) {
      return Promise.resolve(null);
    }
    const optionValues = options.map((option) => option.value);
    for (const selected of value) {
      if (!optionValues.includes(selected as T)) {
        throw new Error(`Queued selectMultipleOptions value "${selected}" is not available for "${message}"`);
      }
    }
    return Promise.resolve(value as T[]);
  });
}

describe('exec command setup', () => {
  let projectDir: string;
  let globalConfigDir: string;
  const originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;
  const originalTaktNoTty = process.env.TAKT_NO_TTY;
  const originalTaktNotifyWebhook = process.env.TAKT_NOTIFY_WEBHOOK;
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
    // The line-reading loop is what this suite drives; with both streams on a
    // terminal exec would mount the TUI instead.
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false,
    });
    delete process.env.TAKT_NO_TTY;
    delete process.env.TAKT_NOTIFY_WEBHOOK;
    projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-command-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-exec-command-global-'));
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    execAttachmentStores.stores.length = 0;
    mockReadMultilineInput.mockReset();
    mockSelectOption.mockReset();
    mockSelectMultipleOptions.mockReset();
    mockResolveWorkflowConfigValues.mockReset();
    mockResolveNonWorkflowProviderOptions.mockReset();
    mockGetProvider.mockReset();
    mockCallAIWithRetry.mockReset();
    mockSelectAndExecuteTask.mockReset();
    mockLoadRunSessionContext.mockReset();
    mockFormatRunSessionForPrompt.mockReset();
    setWorkflowConfigValues({
      enableBuiltinWorkflows: true,
      language: 'en',
      provider: 'claude',
      model: 'opus',
    });
    mockResolveNonWorkflowProviderOptions.mockImplementation((_cwd, options) => options);
    mockGetProvider.mockReturnValue(stubProvider());
    mockSelectAndExecuteTask.mockResolvedValue(undefined);
    setRunSessionContext({
      reports: [
        {
          filename: 'review-1-review-result.md',
          content: '# Review Result\n\napproved',
        },
      ],
    });
    setRunSessionPrompt({
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
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: originalStdoutIsTTY,
    });
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalConfigDir, { recursive: true, force: true });
    for (const tempDir of execAttachmentTempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    execAttachmentTempDirs.clear();
  });

  it('should pass configured Codex Skill inheritance to the exec assistant session', () => {
    mockResolveNonWorkflowProviderOptions.mockReturnValue({
      codex: { skills: { repo: true, user: false } },
    });

    const ctx = createExecSessionContext(projectDir, resolvedDefaultExecConfig());

    expect(ctx.providerOptions).toEqual({
      codex: { skills: { repo: true, user: false } },
    });
    expect(ctx.codexSkillInheritance).toEqual({ repo: true, user: false });
    expect(mockResolveNonWorkflowProviderOptions).toHaveBeenCalledWith(
      projectDir,
      undefined,
      defaultExecSkillProviderOptions.codex.skills,
    );
  });

  it('should keep explicitly configured Skill inheritance in assistant and generated workflow', async () => {
    const configuredSkillOptions = {
      codex: { skills: { repo: false, user: true } },
    } as const;
    mockResolveNonWorkflowProviderOptions.mockImplementation((_cwd, options, defaults) => (
      defaults === undefined ? options : configuredSkillOptions
    ));
    mockReadMultilineInput
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    for (const call of mockCallAIWithRetry.mock.calls) {
      expect(call[4].providerOptions).toEqual(configuredSkillOptions);
      expect((call[4] as ExecSessionContext).codexSkillInheritance).toEqual({ repo: false, user: true });
    }
    const workflow = parseYaml(
      readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'),
    );
    expect(workflow).not.toHaveProperty('workflow_config');
  });

  it('should pass explicit assistant effort as provider options for exec assistant calls', async () => {
    saveExecPreset('effort-team', 'Explicit effort team', {
      ...DEFAULT_EXEC_CONFIG,
      session: {
        effort: 'high',
      },
    }, { projectDir, scope: 'project' });
    mockReadMultilineInput
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'effort-team' })).resolves.toBeUndefined();

    expect(mockCallAIWithRetry.mock.calls[0]?.[4]).toEqual(expect.objectContaining({
      providerOptions: {
        ...defaultExecSkillProviderOptions,
        claude: { effort: 'high' },
      },
    }));
    expect(mockCallAIWithRetry.mock.calls[1]?.[4]).toEqual(expect.objectContaining({
      providerOptions: {
        ...defaultExecSkillProviderOptions,
        claude: { effort: 'high' },
      },
    }));
  });

  it('should start with the default config without prompting when only builtin presets exist', async () => {
    mockReadMultilineInput.mockResolvedValueOnce('/cancel');

    await expect(runExecCommand(projectDir, {})).resolves.toBeUndefined();

    expect(mockSelectOption).not.toHaveBeenCalled();
    expect(mockReadMultilineInput).toHaveBeenCalledWith('Assistant> ');
  });

  it('should cleanup pasted image session directory when exec is cancelled', async () => {
    let sessionDir: string | undefined;
    mockReadMultilineInput.mockImplementationOnce(async () => {
      const store = requireExecAttachmentStore();
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
    mockReadMultilineInput.mockImplementationOnce(async () => {
      const store = requireExecAttachmentStore();
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
    mockReadMultilineInput.mockImplementationOnce(async () => {
      const store = requireExecAttachmentStore();
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

  it('should leave nothing behind when a paste lands after exec ended', async () => {
    // The line editor can resolve the input before a capture it started
    // finishes, so the save runs once the store is already gone.
    let store: ImageAttachmentStore | undefined;
    let sessionDir: string | undefined;
    mockReadMultilineInput.mockImplementationOnce(async () => {
      store = requireExecAttachmentStore();
      const attachment = await store.saveImage(Buffer.from('late-image'), 'image/png');
      sessionDir = dirname(dirname(attachment.tempPath));
      return '/cancel';
    });

    await expect(runExecCommand(projectDir, {})).resolves.toBeUndefined();

    if (store === undefined || sessionDir === undefined) {
      throw new Error('Expected the test to create an exec image attachment session directory.');
    }
    expect(existsSync(sessionDir)).toBe(false);

    // The late save is refused, so the deleted directory is not recreated and
    // no new attachment joins the list the run already closed over.
    const savedBefore = store.listAttachments().length;
    await expect(store.saveImage(Buffer.from('after-exit'), 'image/png')).rejects.toThrow();
    expect(existsSync(sessionDir)).toBe(false);
    expect(store.listAttachments()).toHaveLength(savedBefore);
  });

  it('should keep exec cancellation flow when image attachment cleanup fails', async () => {
    let sessionDir: string | undefined;
    mockReadMultilineInput.mockImplementationOnce(async () => {
      const store = requireExecAttachmentStore();
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
    mockReadMultilineInput
      .mockImplementationOnce(async () => {
        const store = requireExecAttachmentStore();
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
    const plainText = 'literal image marker';
    mockReadMultilineInput
      .mockResolvedValueOnce(plainText)
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { success: true, content: 'Kept as text' },
      sessionId: 'session-1',
    });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(mockCallAIWithRetry.mock.calls[0]?.[0]).toBe(plainText);
    expect(mockCallAIWithRetry.mock.calls[0]?.[5]).toEqual({ imageAttachments: [] });
  });

  it('should report unreadable pasted images without calling providers and keep the exec prompt open', async () => {
    let pastedAttachment: InteractiveImageAttachment | undefined;
    mockReadMultilineInput
      .mockImplementationOnce(async () => {
        const store = requireExecAttachmentStore();
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
    expect(mockReadMultilineInput).toHaveBeenCalledTimes(2);
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
    expect(output).toContain('ENOENT');
    expect(output).not.toContain(pastedAttachment.placeholder);
  });

  it('should pass /go referenced pasted images to workflow but not completion when only run artifacts mention placeholders', async () => {
    let pastedAttachment: InteractiveImageAttachment | undefined;
    mockReadMultilineInput
      .mockImplementationOnce(async () => {
        const store = requireExecAttachmentStore();
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
    setRunSessionPrompt({
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
    mockReadMultilineInput
      .mockImplementationOnce(async () => {
        const store = requireExecAttachmentStore();
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
    setRunSessionPrompt({
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
    mockReadMultilineInput
      .mockImplementationOnce(async () => {
        const store = requireExecAttachmentStore();
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
    mockReadMultilineInput
      .mockImplementationOnce(async () => {
        const store = requireExecAttachmentStore();
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
    expect(mockReadMultilineInput).toHaveBeenCalledTimes(2);
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
    expect(output).toContain('ENOENT');
    expect(output).not.toContain(pastedAttachment.placeholder);
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
    mockReadMultilineInput
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
    mockReadMultilineInput
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
    setWorkflowConfigValues({
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
    mockReadMultilineInput
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
    expect(execute.parallel[0]).not.toHaveProperty('provider');
    expect(execute.parallel[0]).not.toHaveProperty('model');
    expect(judge.parallel[0]).not.toHaveProperty('provider');
    expect(judge.parallel[0]).not.toHaveProperty('model');
    expect(replan).not.toHaveProperty('provider');
    expect(replan).not.toHaveProperty('model');
  });

  it('should generate workflows with the provider and model resolved when exec mode starts', async () => {
    let providerModelResolutions = 0;
    setWorkflowConfigValuesImplementation((_cwd, keys) => {
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
    mockReadMultilineInput
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
    expect(execute.parallel[0]).not.toHaveProperty('provider');
    expect(execute.parallel[0]).not.toHaveProperty('model');
    expect(replan).not.toHaveProperty('provider');
    expect(replan).not.toHaveProperty('model');
  });

  it('should start with inherited Claude xhigh effort for the configured default model', async () => {
    setWorkflowConfigValues({
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
    mockReadMultilineInput.mockResolvedValueOnce('/cancel');

    await expect(runExecCommand(projectDir, { preset: 'stale-inherited-effort-team' })).resolves.toBeUndefined();

    expect(mockReadMultilineInput).toHaveBeenCalled();
  });

  it('should apply CLI provider and model overrides to generated workflow and assistant calls', async () => {
    mockReadMultilineInput
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
    expect(execute.parallel[0]).not.toHaveProperty('provider');
    expect(execute.parallel[0]).not.toHaveProperty('model');
    expect(judge.parallel[0]).not.toHaveProperty('provider');
    expect(judge.parallel[0]).not.toHaveProperty('model');
    expect(replan).not.toHaveProperty('provider');
    expect(replan).not.toHaveProperty('model');
    expect(execute.parallel[0]).not.toHaveProperty('provider_options');
    expect(judge.parallel[0]).not.toHaveProperty('provider_options');
    expect(replan).not.toHaveProperty('provider_options');
    expect(workflow).not.toHaveProperty('workflow_config');

    expect(existsSync(join(globalConfigDir, 'exec.yaml'))).toBe(false);

    for (const call of mockCallAIWithRetry.mock.calls) {
      const ctx = call[4];
      expect(ctx.providerType).toBe('mock');
      expect(ctx.model).toBe('override-model');
      expect(ctx.providerOptions).toEqual(defaultExecSkillProviderOptions);
    }
  });

  it.each(['cursor', 'copilot', 'kiro', 'pi', 'deepseek-harness'] as const)(
    'should allow CLI provider override to %s without explicit model',
    async (provider) => {
      mockReadMultilineInput
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
      expect(execute.parallel[0]).not.toHaveProperty('provider');
      expect(execute.parallel[0]).not.toHaveProperty('model');
      expect(judge.parallel[0]).not.toHaveProperty('provider');
      expect(judge.parallel[0]).not.toHaveProperty('model');
      expect(replan).not.toHaveProperty('provider');
      expect(replan).not.toHaveProperty('model');

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
    mockReadMultilineInput
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
    mockReadMultilineInput
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
          ...defaultActor(DEFAULT_EXEC_CONFIG.workers, 0),
          provider: 'mock',
          model: 'worker\x1b[2J-model',
          effort: undefined,
          instruction: 'worker\x1b]52;c;secret\x07-instruction',
        },
      ],
      reviews: [
        {
          ...defaultActor(DEFAULT_EXEC_CONFIG.reviews, 0),
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
    mockReadMultilineInput
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
    expect(teamOptions.find((option) => option.value === 'assistant')?.label).toEqual(expect.stringContaining('session-model'));
    expect(teamOptions.find((option) => option.value === 'replan')?.label).toEqual(expect.stringContaining('replan-instruction'));
    expect(teamOptions.every((option) => !/[\u0000-\u001f\u007f]/.test(option.label))).toBe(true);

    const assistantOptions = mockSelectOption.mock.calls[1]?.[1] ?? [];
    expect(assistantOptions.find((option) => option.value === 'model')?.label).toEqual(expect.stringContaining('session-model'));
    const modelOptions = mockSelectOption.mock.calls[2]?.[1] ?? [];
    expect(modelOptions.some((option) => option.label.includes('session-model'))).toBe(true);
    expect(modelOptions.every((option) => !/[\u0000-\u001f\u007f]/.test(option.label))).toBe(true);
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
          ...defaultActor(DEFAULT_EXEC_CONFIG.workers, 0),
          provider: 'mock',
          model: 'worker\x1b[2J-model',
          effort: undefined,
          instruction: 'worker\x1b]52;c;secret\x07-instruction',
        },
      ],
      reviews: [
        {
          ...defaultActor(DEFAULT_EXEC_CONFIG.reviews, 0),
          provider: 'mock',
          model: 'review\x1b[2J-model',
          effort: undefined,
        },
      ],
    };
    saveExecPreset('unsafe-details', 'Unsafe details', unsafeConfig, { projectDir, scope: 'project' });
    mockReadMultilineInput
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

    const actorListOptions = mockSelectOption.mock.calls
      .filter((call) => call[1].some((option) => option.value === 'edit:0'))
      .map((call) => call[1]);
    const workerOptions = actorListOptions[0] ?? [];
    const judgeOptions = actorListOptions[1] ?? [];
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
    mockReadMultilineInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'knowledge',
      'toggle',
      'back',
      'back',
      'back',
    );
    mockSelectMultipleOptionsQueue(null);

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const unsafeFacetOption = mockSelectMultipleOptions.mock.calls
      .map((call) => call[1])
      .flat()
      .find((option) => option.value === 'unsafe');
    expect(unsafeFacetOption?.label).toBe('unsafe');
    expect(unsafeFacetOption?.description).toEqual(expect.stringContaining('Unsafe'));
    expect(unsafeFacetOption?.description).not.toContain('\x1b');
    expect(unsafeFacetOption?.description).not.toContain('secret');
  });

  it('should sanitize exec assistant responses before terminal output', async () => {
    mockReadMultilineInput
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
    mockReadMultilineInput
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
    expect(output).not.toContain('\x1b');
    expect(output).not.toContain('secret');
  });

  it('should apply session provider change for provider-default model providers', async () => {
    mockReadMultilineInput
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
          ...defaultActor(DEFAULT_EXEC_CONFIG.workers, 0),
          provider: 'opencode',
          model: 'opencode/worker',
          effort: undefined,
        },
      ],
      reviews: [
        {
          ...defaultActor(DEFAULT_EXEC_CONFIG.reviews, 0),
          provider: 'opencode',
          model: 'opencode/review',
          effort: undefined,
        },
      ],
    }, { projectDir, scope: 'project' });
    mockReadMultilineInput
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
    expect(mockCallAIWithRetry.mock.calls[0]?.[4].providerOptions).toEqual(defaultExecSkillProviderOptions);
    expect(execute.parallel[0]).not.toHaveProperty('provider_options');
    expect(judge.parallel[0]).not.toHaveProperty('provider_options');
    expect(replan).not.toHaveProperty('provider_options');
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
          ...defaultActor(DEFAULT_EXEC_CONFIG.workers, 0),
          provider: 'opencode',
          model: 'opencode/worker',
          effort: undefined,
        },
      ],
      reviews: [
        {
          ...defaultActor(DEFAULT_EXEC_CONFIG.reviews, 0),
          provider: 'opencode',
          model: 'opencode/review',
          effort: undefined,
        },
      ],
    }, { projectDir, scope: 'project' });
    mockReadMultilineInput
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

    const actorOptionSets = mockSelectOption.mock.calls
      .map((call) => call[1])
      .filter((options) => options.some((option) => option.value === 'provider' && options.some((item) => item.value === 'model')));
    expect(actorOptionSets).toHaveLength(3);
    for (const options of actorOptionSets) {
      expect(options.some((option) => option.value === 'effort')).toBe(false);
    }
  });

  it('should offer default when selecting effort for providers with exec effort support', async () => {
    mockReadMultilineInput
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
      .map((call) => call[1])
      .filter((options) => options.some((option) => option.value === '__default_effort__'));
    expect(effortOptionSets).toHaveLength(3);
    for (const options of effortOptionSets) {
      expect(options.map((option) => option.value)).toEqual(['__default_effort__', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    }
  });

  it('should apply assistant effort changes from setup to exec assistant runtime calls', async () => {
    mockReadMultilineInput
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

    expect(mockCallAIWithRetry.mock.calls[0]?.[4].providerOptions).toEqual({
      ...defaultExecSkillProviderOptions,
      claude: { effort: 'medium' },
    });
    expect(mockCallAIWithRetry.mock.calls[1]?.[4].providerOptions).toEqual({
      ...defaultExecSkillProviderOptions,
      claude: { effort: 'medium' },
    });
    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
    expect(replan).not.toHaveProperty('provider');
    expect(replan).not.toHaveProperty('model');
    expect(replan).not.toHaveProperty('provider_options');
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
    mockReadMultilineInput
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

    expect(mockCallAIWithRetry.mock.calls[0]?.[4].providerOptions).toEqual({
      ...defaultExecSkillProviderOptions,
      claude: { effort: 'xhigh' },
    });
    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
    const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
    expect(execute.parallel[0]).not.toHaveProperty('provider');
    expect(execute.parallel[0]).not.toHaveProperty('model');
    expect(execute.parallel[0]).not.toHaveProperty('provider_options');
    expect(replan).not.toHaveProperty('provider');
    expect(replan).not.toHaveProperty('model');
    expect(replan).not.toHaveProperty('provider_options');
    const saved = parseYaml(readFileSync(join(globalConfigDir, 'exec.yaml'), 'utf-8'));
    expect(saved.session).toMatchObject({ model: 'claude-sonnet-4-5-20250929' });
    expect(saved.session).toMatchObject({ effort: 'xhigh' });
    expect(saved.workers[0]).toMatchObject({ model: 'claude-sonnet-4-5-20250929' });
    expect(saved.workers[0]).toMatchObject({ effort: 'xhigh' });
  });

  it('should keep effort when setup changes a Claude model back to provider default', async () => {
    setWorkflowConfigValues({
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
    mockReadMultilineInput
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
    mockReadMultilineInput
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
      providerOptions: {
        ...defaultExecSkillProviderOptions,
        claude: { effort: 'medium' },
      },
      sessionId: undefined,
    }));
  });

  it('should apply assistant provider and model changes from setup to the replan workflow step', async () => {
    mockReadMultilineInput
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
    expect(replan).not.toHaveProperty('provider');
    expect(replan).not.toHaveProperty('model');
    expect(replan).not.toHaveProperty('provider_options');
  });

  it('should omit assistant model when setup changes provider without selecting a model', async () => {
    mockReadMultilineInput
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
    expect(replan).not.toHaveProperty('provider');
    expect(replan).not.toHaveProperty('model');
  });

  it.each(['cursor', 'copilot', 'kiro', 'pi', 'deepseek-harness'] as const)(
    'should allow setup assistant provider change to %s without model input',
    async (provider) => {
      mockReadMultilineInput
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
      expect(replan).not.toHaveProperty('provider');
      expect(replan).not.toHaveProperty('model');
    },
  );

  it.each([
    { target: 'assistant', selectQueue: ['assistant', 'provider', 'cursor', 'back', 'back'] },
    { target: 'worker', selectQueue: ['workers', 'edit:0', 'provider', 'cursor', 'back', 'back', 'back'] },
    { target: 'review', selectQueue: ['reviews', 'edit:0', 'provider', 'cursor', 'back', 'back', 'back'] },
  ] as const)(
    'should omit model when $target provider changes without model input',
    async ({ target, selectQueue }) => {
      mockReadMultilineInput
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
        expect(replan).not.toHaveProperty('provider');
        expect(replan).not.toHaveProperty('model');
      }
      if (target === 'worker') {
        expect(mockCallAIWithRetry.mock.calls[0]?.[4]).toEqual(expect.objectContaining({
          providerType: 'claude',
          model: 'opus',
        }));
        expect(execute.parallel[0]).not.toHaveProperty('provider');
        expect(execute.parallel[0]).not.toHaveProperty('model');
      }
      if (target === 'review') {
        expect(mockCallAIWithRetry.mock.calls[0]?.[4]).toEqual(expect.objectContaining({
          providerType: 'claude',
          model: 'opus',
        }));
        expect(judge.parallel[0]).not.toHaveProperty('provider');
        expect(judge.parallel[0]).not.toHaveProperty('model');
      }
    },
  );

  it('should reject setup opencode custom model without provider qualifier and keep the existing config', async () => {
    mockReadMultilineInput
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
    expect(replan).not.toHaveProperty('provider');
    expect(replan).not.toHaveProperty('model');
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
      mockReadMultilineInput
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
      expect(replan).not.toHaveProperty('provider');
      expect(replan).not.toHaveProperty('model');
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
      mockReadMultilineInput
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
      expect(actor).not.toHaveProperty('provider');
      expect(actor).not.toHaveProperty('model');
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
      mockReadMultilineInput
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
      expect(actor).not.toHaveProperty('provider');
      expect(actor).not.toHaveProperty('model');
    },
  );

  it('should keep setup open across submenus until the main menu returns', async () => {
    mockReadMultilineInput
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
    expect(replan).not.toHaveProperty('provider');
    expect(execute.parallel[0]).not.toHaveProperty('model');
    expect(mockReadMultilineInput.mock.calls.map((call) => call[0])).toEqual([
      'Assistant> ',
      'Assistant> ',
      'Assistant> ',
    ]);
  });

  it('should use provider model menu candidates and custom model input from setup', async () => {
    mockReadMultilineInput
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
      .filter((call) => call[1].some((option) => option.value === '__default_model__'))
      .map((call) => call[1].map((option) => option.value));
    expect(modelOptionSets).toEqual([
      ['__default_model__', 'opus', 'sonnet', 'haiku', '__custom_model__'],
      ['__default_model__', 'opus', 'sonnet', 'haiku', '__custom_model__'],
    ]);
    expect(mockReadMultilineInput.mock.calls[1]?.[0]).toBeTypeOf('string');
    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
    const judge = workflow.steps.find((step: { name: string }) => step.name === 'review');
    expect(execute.parallel[0]).not.toHaveProperty('model');
    expect(judge.parallel[0]).not.toHaveProperty('model');

    const saved = parseYaml(readFileSync(join(globalConfigDir, 'exec.yaml'), 'utf-8'));
    expect(saved.workers[0]).toMatchObject({ model: 'haiku' });
    expect(saved.workers[0]).not.toHaveProperty('provider');
    expect(saved.reviews[0]).toMatchObject({ model: 'custom-review-model' });
    expect(saved.reviews[0]).not.toHaveProperty('provider');
  });

  it('should not save inherited models when model selection is canceled from setup', async () => {
    mockReadMultilineInput
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
      .filter((call) => call[1].some((option) => option.value === '__default_model__'))
      .map((call) => call[1].map((option) => option.label));
    expect(modelOptionSets).toHaveLength(3);
    for (const labels of modelOptionSets) {
      expect(labels.some((label) => label.includes('opus'))).toBe(true);
      expect(labels.every((label) => !/[\u0000-\u001f\u007f]/.test(label))).toBe(true);
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
    mockReadMultilineInput
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
    expect(execute.parallel[0]).not.toHaveProperty('provider');
    expect(execute.parallel[0]).not.toHaveProperty('model');
    expect(judge.parallel[0]).not.toHaveProperty('provider');
    expect(judge.parallel[0]).not.toHaveProperty('model');
    expect(replan).not.toHaveProperty('provider');
    expect(replan).not.toHaveProperty('model');
    expect(execute.parallel[0]).not.toHaveProperty('provider_options');
    expect(judge.parallel[0]).not.toHaveProperty('provider_options');
    expect(replan).not.toHaveProperty('provider_options');
    expect(mockCallAIWithRetry.mock.calls[0]?.[4].providerOptions).toEqual(defaultExecSkillProviderOptions);

    const saved = parseYaml(readFileSync(join(globalConfigDir, 'exec.yaml'), 'utf-8'));
    expect(saved.session).not.toHaveProperty('model');
    expect(saved.session).not.toHaveProperty('effort');
    expect(saved.workers[0]).not.toHaveProperty('model');
    expect(saved.workers[0]).not.toHaveProperty('effort');
    expect(saved.reviews[0]).not.toHaveProperty('model');
    expect(saved.reviews[0]).not.toHaveProperty('effort');
  });

  it('should apply worker and review effort changes from setup to generated workflow', async () => {
    mockReadMultilineInput
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
    expect(execute.parallel[0]).not.toHaveProperty('provider_options');
    expect(judge.parallel[0]).not.toHaveProperty('provider_options');

    const saved = parseYaml(readFileSync(join(globalConfigDir, 'exec.yaml'), 'utf-8'));
    expect(saved.workers[0]).toMatchObject({ effort: 'low' });
    expect(saved.workers[0]).not.toHaveProperty('provider');
    expect(saved.workers[0]).not.toHaveProperty('model');
    expect(saved.reviews[0]).toMatchObject({ effort: 'medium' });
    expect(saved.reviews[0]).not.toHaveProperty('provider');
    expect(saved.reviews[0]).not.toHaveProperty('model');
  });

  it('should route suffix setup commands through the exec slash command matcher', async () => {
    mockReadMultilineInput
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
    mockReadMultilineInput
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
    mockReadMultilineInput
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
    mockReadMultilineInput
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
    mockReadMultilineInput
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
    mockReadMultilineInput
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry.mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' });
    mockSelectAndExecuteTask.mockRejectedValueOnce(new Error('workflow failed'));

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(existsSync(join(globalConfigDir, 'exec.yaml'))).toBe(false);
  });

  it('should display error and continue loop when assistant call fails during conversation', async () => {
    mockReadMultilineInput
      .mockResolvedValueOnce('Clarify this task')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry.mockResolvedValueOnce({ result: null, sessionId: undefined });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();
  });

  it('should preserve exec assistant session and history when assistant call fails', async () => {
    mockReadMultilineInput
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
    mockReadMultilineInput
      .mockResolvedValueOnce('Clarify this task')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { success: false, content: 'Provider returned blocked status' },
      sessionId: undefined,
    });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();
  });

  it('should summarize a completed workflow when review reports are missing', async () => {
    mockReadMultilineInput
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });
    mockLoadRunSessionContext.mockReturnValueOnce(runSessionContext({
      task: 'Executable task',
      workflow: 'exec-test',
      status: 'completed',
      stepLogs: [],
      reports: [],
    }));
    mockFormatRunSessionForPrompt.mockReturnValueOnce(runSessionPrompt({
      runStatus: 'completed',
      runReports: '',
      runStepLogs: '',
    }));

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(existsSync(join(globalConfigDir, 'exec.yaml'))).toBe(false);
    expect(mockFormatRunSessionForPrompt).toHaveBeenCalledWith(expect.objectContaining({ reports: [] }));
    expect(mockCallAIWithRetry).toHaveBeenCalledTimes(2);
  });

  it('should not create workflow or last-used config for empty /go with no conversation', async () => {
    mockReadMultilineInput
      .mockResolvedValueOnce('/go')
      .mockResolvedValueOnce('/cancel');

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(existsSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'))).toBe(false);
    expect(existsSync(join(globalConfigDir, 'exec.yaml'))).toBe(false);
    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
  });

  it('should display error and continue menu when unsafe actor name is entered from setup', async () => {
    mockReadMultilineInput
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
    mockReadMultilineInput
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
    mockReadMultilineInput
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
    mockReadMultilineInput
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
    mockLoadRunSessionContext.mockReturnValueOnce(runSessionContext({
      reports: [
        { filename: 'review-1-review-result.md', content: '# Review 1\n\napproved' },
        { filename: 'review-2-review-result.md', content: '# Review 2\n\napproved' },
      ],
    }));

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const workflow = readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8');
    expect(workflow).toContain('threshold: 5');
    expect(workflow).toContain('name: review-2');
    expect(workflow).toContain('name: review-2-review-result.md');
  });

  it('should summarize available review reports when an expected report is missing from /go', async () => {
    mockReadMultilineInput
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
    mockLoadRunSessionContext.mockReturnValueOnce(runSessionContext({
      reports: [
        { filename: 'review-1-review-result.md', content: '# Review 1\n\napproved' },
      ],
    }));

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const saved = parseYaml(readFileSync(join(globalConfigDir, 'exec.yaml'), 'utf-8'));
    expect(saved.reviews).toHaveLength(2);
    expect(mockFormatRunSessionForPrompt).toHaveBeenCalledWith(expect.objectContaining({
      reports: [{ filename: 'review-1-review-result.md', content: '# Review 1\n\napproved' }],
    }));
    expect(mockCallAIWithRetry).toHaveBeenCalledTimes(2);
  });

  it('should include all review reports in the final exec assistant prompt', async () => {
    mockReadMultilineInput
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
    mockLoadRunSessionContext.mockReturnValueOnce(runSessionContext(runContext));
    mockFormatRunSessionForPrompt.mockReturnValueOnce(runSessionPrompt({
      runStatus: 'completed',
      runReports: '# Review 1\n\napproved\n\n# Review 2\n\napproved',
      runStepLogs: 'execute/review logs',
    }));

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(mockFormatRunSessionForPrompt).toHaveBeenCalledWith(runContext);
    const finalPrompt = mockCallAIWithRetry.mock.calls[1]?.[0];
    expect(finalPrompt).toContain('approved');
  });

  it('should reuse the lowest available actor name after deletion', async () => {
    mockReadMultilineInput
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
    mockReadMultilineInput
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
    mockReadMultilineInput
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
      'back',
      'back',
      'back',
    );
    mockSelectMultipleOptionsQueue(['architecture', 'security']);
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
    mockReadMultilineInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'policy',
      'toggle',
      'back',
      'back',
      'reviews',
      'edit:0',
      'policy',
      'toggle',
      'back',
      'back',
      'replan',
      'policy',
      'toggle',
      'back',
      'replan',
      'policy',
      'clear',
      'back',
      'back',
    );
    mockSelectMultipleOptionsQueue(
      ['coding'],
      ['review', 'testing'],
      ['review'],
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
    expect(judge.parallel[0].policy).toEqual(['review', 'testing']);
    expect(replan).not.toHaveProperty('policy');
  });

  it('should apply multiple knowledge and policy selections to separate worker workflow fields', async () => {
    mockReadMultilineInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'knowledge',
      'toggle',
      'policy',
      'toggle',
      'back',
      'back',
      'back',
    );
    mockSelectMultipleOptionsQueue(
      ['architecture', 'security', 'backend'],
      ['coding', 'testing'],
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
    expect(execute.parallel[0].knowledge).toEqual(['architecture', 'security', 'backend']);
    expect(execute.parallel[0].policy).toEqual(['coding', 'testing']);
  });

  it('should retain resolvable facet refs and exclude missing resource refs from selection', async () => {
    const knowledgeRef = '@example/facets/shared-knowledge';
    const policyRef = '@example/facets/shared-policy';
    const knowledgeResourcePath = join(projectDir, 'README.md');
    const policyResourcePath = join(projectDir, 'CONTRIBUTING.md');
    const missingKnowledgeResourcePath = join(projectDir, 'missing-knowledge.md');
    const missingPolicyResourcePath = join(projectDir, 'missing-policy.md');
    const repertoireFacetDir = join(globalConfigDir, 'repertoire', '@example', 'facets', 'facets');
    mkdirSync(join(repertoireFacetDir, 'knowledge'), { recursive: true });
    mkdirSync(join(repertoireFacetDir, 'policies'), { recursive: true });
    writeFileSync(join(repertoireFacetDir, 'knowledge', 'shared-knowledge.md'), '# Shared knowledge\n');
    writeFileSync(join(repertoireFacetDir, 'policies', 'shared-policy.md'), '# Shared policy\n');
    writeFileSync(knowledgeResourcePath, '# Resource knowledge\n');
    writeFileSync(policyResourcePath, '# Resource policy\n');
    saveExecPreset('repertoire-team', 'Repertoire team', {
      ...DEFAULT_EXEC_CONFIG,
      workers: [{ ...DEFAULT_EXEC_CONFIG.workers[0]!, knowledge: [knowledgeRef, knowledgeResourcePath, missingKnowledgeResourcePath], policy: [policyRef, policyResourcePath, missingPolicyResourcePath] }],
      reviews: [{ ...DEFAULT_EXEC_CONFIG.reviews[0]!, knowledge: [knowledgeRef, knowledgeResourcePath, missingKnowledgeResourcePath], policy: [policyRef, policyResourcePath, missingPolicyResourcePath] }],
      replan: { ...DEFAULT_EXEC_CONFIG.replan, knowledge: [knowledgeRef, knowledgeResourcePath, missingKnowledgeResourcePath], policy: [policyRef, policyResourcePath, missingPolicyResourcePath] },
    }, { projectDir, scope: 'project' });
    mockReadMultilineInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers', 'edit:0', 'knowledge', 'toggle', 'policy', 'toggle', 'back', 'back',
      'reviews', 'edit:0', 'knowledge', 'toggle', 'policy', 'toggle', 'back', 'back',
      'replan', 'knowledge', 'toggle', 'policy', 'toggle', 'back', 'back',
    );
    mockSelectMultipleOptionsQueue(
      [knowledgeRef, knowledgeResourcePath, 'architecture'], [policyRef, policyResourcePath],
      [knowledgeRef, knowledgeResourcePath], [policyRef, policyResourcePath],
      [knowledgeRef, knowledgeResourcePath], [policyRef, policyResourcePath],
    );
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'repertoire-team' })).resolves.toBeUndefined();

    for (const call of mockSelectMultipleOptions.mock.calls) {
      expect(call[1]?.map((option) => option.value)).toContain(call[2]?.[0]);
      const options = call[1] ?? [];
      const resourcePath = call[2]?.find((value) => value.endsWith('.md'));
      if (resourcePath) {
        expect(options.find((option) => option.value === resourcePath)?.description).toBeUndefined();
      }
      const missingResourcePath = call[2]?.find((value) => value.includes('missing-'));
      if (missingResourcePath) {
        expect(options.find((option) => option.value === missingResourcePath)).toBeUndefined();
      }
    }
    const saved = parseYaml(readFileSync(join(globalConfigDir, 'exec.yaml'), 'utf-8'));
    expect(saved.workers[0]).toMatchObject({ knowledge: [knowledgeRef, knowledgeResourcePath, 'architecture'], policy: [policyRef, policyResourcePath] });
    expect(saved.reviews[0]).toMatchObject({ knowledge: [knowledgeRef, knowledgeResourcePath], policy: [policyRef, policyResourcePath] });
    expect(saved.replan).toMatchObject({ knowledge: [knowledgeRef, knowledgeResourcePath], policy: [policyRef, policyResourcePath] });
    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
    const review = workflow.steps.find((step: { name: string }) => step.name === 'review');
    const replan = workflow.steps.find((step: { name: string }) => step.name === 'replan');
    expect(execute.parallel[0]).toMatchObject({ knowledge: [knowledgeRef, knowledgeResourcePath, 'architecture'], policy: [policyRef, policyResourcePath] });
    expect(review.parallel[0]).toMatchObject({ knowledge: [knowledgeRef, knowledgeResourcePath], policy: [policyRef, policyResourcePath] });
    expect(replan).toMatchObject({ knowledge: [knowledgeRef, knowledgeResourcePath], policy: [policyRef, policyResourcePath] });
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
    mockReadMultilineInput
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
    setWorkflowConfigValues({
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
    mockReadMultilineInput
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
    expect(execute.parallel[0]).not.toHaveProperty('provider_options');
    expect(judge.parallel[0]).not.toHaveProperty('provider_options');
    expect(replan).not.toHaveProperty('provider_options');
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
    mockReadMultilineInput
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
    setWorkflowConfigValues({
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
    mockReadMultilineInput
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
    const editedContent = 'edited worker instruction';
    mockReadMultilineInput
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
      .mockResolvedValueOnce({ result: { success: true, content: editedContent }, sessionId: 'ai-facet-session' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(mockCallAIWithRetry.mock.calls[0]?.[0]).toContain('Make the worker require tests');
    expect(readFileSync(join(projectDir, '.takt', 'facets', 'instructions', 'exec-worker.md'), 'utf-8')).toBe(editedContent);
  });

  it('should save Japanese AI edits for existing instruction facets', async () => {
    const editedContent = 'localized worker instruction';
    setWorkflowConfigValues({
      enableBuiltinWorkflows: true,
      language: 'ja',
      provider: 'claude',
      model: 'opus',
    });
    mockReadMultilineInput
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
      .mockResolvedValueOnce({ result: { success: true, content: editedContent }, sessionId: 'ai-facet-session' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    expect(readFileSync(join(projectDir, '.takt', 'facets', 'instructions', 'exec-worker.md'), 'utf-8')).toBe(editedContent);
  });

  it('should exclude builtin instruction facets from select existing when builtin facets are disabled', async () => {
    setWorkflowConfigValues({
      enableBuiltinWorkflows: false,
      language: 'en',
      provider: 'claude',
      model: 'opus',
    });
    mkdirSync(join(projectDir, '.takt', 'facets', 'instructions'), { recursive: true });
    mkdirSync(join(globalConfigDir, 'facets', 'instructions'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'facets', 'instructions', 'project-instruction.md'), '# Project Instruction\n');
    writeFileSync(join(globalConfigDir, 'facets', 'instructions', 'user-instruction.md'), '# User Instruction\n');
    mockReadMultilineInput
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

    const selectOptions = mockSelectOption.mock.calls
      .find((call) => call[1].some((option) => option.value === 'project-instruction'))?.[1] ?? [];
    expect(selectOptions.map((option) => option.value).sort()).toEqual(['project-instruction', 'user-instruction']);
    expect(selectOptions.some((option) => option.value === 'exec-worker')).toBe(false);
  });

  it('should exclude builtin knowledge facets from toggle existing when builtin facets are disabled', async () => {
    setWorkflowConfigValues({
      enableBuiltinWorkflows: false,
      language: 'en',
      provider: 'claude',
      model: 'opus',
    });
    mkdirSync(join(projectDir, '.takt', 'facets', 'knowledge'), { recursive: true });
    mkdirSync(join(globalConfigDir, 'facets', 'knowledge'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'facets', 'knowledge', 'project-knowledge.md'), '# Project Knowledge\n');
    writeFileSync(join(globalConfigDir, 'facets', 'knowledge', 'user-knowledge.md'), '# User Knowledge\n');
    mockReadMultilineInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'knowledge',
      'toggle',
      'back',
      'back',
      'back',
    );
    mockSelectMultipleOptionsQueue(['project-knowledge']);

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const toggleCall = mockSelectMultipleOptions.mock.calls
      .find((call) => call[2]?.includes('architecture'));
    const toggleOptions = toggleCall?.[1] ?? [];
    expect(toggleOptions.map((option) => option.value).sort()).toEqual(['project-knowledge', 'user-knowledge']);
    expect(toggleOptions.some((option) => ['architecture', 'backend', 'security'].includes(option.value))).toBe(false);
    expect(toggleCall?.[2]).toEqual(['architecture', 'backend', 'security']);
  });

  it('should preserve current knowledge when no facets can be selected', async () => {
    setWorkflowConfigValues({
      enableBuiltinWorkflows: false,
      language: 'en',
      provider: 'claude',
      model: 'opus',
    });
    mockReadMultilineInput
      .mockResolvedValueOnce('/setup')
      .mockResolvedValueOnce('/go Implement a small task')
      .mockResolvedValueOnce('/cancel');
    mockSelectOptionQueue(
      'workers',
      'edit:0',
      'knowledge',
      'toggle',
      'back',
      'back',
      'back',
    );
    mockSelectMultipleOptionsQueue(null);
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'Executable task' }, sessionId: 'session-1' })
      .mockResolvedValueOnce({ result: { success: true, content: 'Execution completed' }, sessionId: 'session-1' });

    await expect(runExecCommand(projectDir, { preset: 'backend' })).resolves.toBeUndefined();

    const workflow = parseYaml(readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8'));
    const execute = workflow.steps.find((step: { name: string }) => step.name === 'execute');
    expect(execute.parallel[0].knowledge).toEqual(['architecture', 'backend', 'security']);
  });

  it('should not read builtin facet content from setup when builtin facets are disabled', async () => {
    setWorkflowConfigValues({
      enableBuiltinWorkflows: false,
      language: 'en',
      provider: 'claude',
      model: 'opus',
    });
    mockReadMultilineInput
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
      mockReadMultilineInput
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
      mockReadMultilineInput
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
      mockReadMultilineInput
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
    mockReadMultilineInput
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
      mockReadMultilineInput
        .mockResolvedValueOnce('/setup');
      for (const input of promptInputs) {
        mockReadMultilineInput.mockResolvedValueOnce(input);
      }
      mockReadMultilineInput.mockResolvedValueOnce('/cancel');
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
    mockReadMultilineInput
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
    mockReadMultilineInput
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
      mockReadMultilineInput
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
    mockReadMultilineInput
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
