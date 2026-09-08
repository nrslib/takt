import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import type { TaskListItem } from '../infra/task/types.js';

const {
  mockRunTuiTaskConversation,
  mockCallPi,
  mockInitializeSession,
  mockLoadAssistantInitContext,
  mockMountInk,
  mockOpenLiveRunDirectory,
} = vi.hoisted(() => ({
  mockRunTuiTaskConversation: vi.fn(),
  mockCallPi: vi.fn(),
  mockInitializeSession: vi.fn(),
  mockLoadAssistantInitContext: vi.fn(),
  mockMountInk: vi.fn(),
  mockOpenLiveRunDirectory: vi.fn(),
}));

const reportOpenRace = vi.hoisted(() => ({
  targetPath: undefined as string | undefined,
  replace: undefined as (() => void) | undefined,
  replaced: false,
}));

const reportChildOpenRace = vi.hoisted(() => ({
  targetPath: undefined as string | undefined,
  replace: undefined as (() => void) | undefined,
  replaced: false,
}));

const reportListingRace = vi.hoisted(() => ({
  targetPath: undefined as string | undefined,
  replace: undefined as (() => void) | undefined,
  replaced: false,
}));

const reportReadRace = vi.hoisted(() => ({
  targetPath: undefined as string | undefined,
  replace: undefined as (() => void) | undefined,
  replaced: false,
  descriptor: undefined as number | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync(...args: Parameters<typeof actual.openSync>) {
      if (
        !reportChildOpenRace.replaced
        && reportChildOpenRace.targetPath !== undefined
        && String(args[0]) === reportChildOpenRace.targetPath
      ) {
        reportChildOpenRace.replaced = true;
        const replace = reportChildOpenRace.replace;
        reportChildOpenRace.replace = undefined;
        replace?.();
      }
      if (
        !reportOpenRace.replaced
        && reportOpenRace.targetPath !== undefined
        && String(args[0]) === reportOpenRace.targetPath
      ) {
        reportOpenRace.replaced = true;
        const replace = reportOpenRace.replace;
        reportOpenRace.replace = undefined;
        replace?.();
      }
      const descriptor = actual.openSync(...args);
      if (
        !reportReadRace.replaced
        && reportReadRace.targetPath !== undefined
        && String(args[0]) === reportReadRace.targetPath
      ) {
        reportReadRace.descriptor = descriptor;
      }
      return descriptor;
    },
    readFileSync(...args: Parameters<typeof actual.readFileSync>) {
      const content = actual.readFileSync(...args);
      if (
        !reportReadRace.replaced
        && typeof args[0] === 'number'
        && args[0] === reportReadRace.descriptor
      ) {
        reportReadRace.replaced = true;
        reportReadRace.targetPath = undefined;
        reportReadRace.descriptor = undefined;
        const replace = reportReadRace.replace;
        reportReadRace.replace = undefined;
        replace?.();
      }
      return content;
    },
    opendirSync(...args: Parameters<typeof actual.opendirSync>) {
      const directory = actual.opendirSync(...args);
      if (
        !reportListingRace.replaced
        && reportListingRace.targetPath !== undefined
        && String(args[0]) === reportListingRace.targetPath
      ) {
        reportListingRace.replaced = true;
        const replace = reportListingRace.replace;
        reportListingRace.replace = undefined;
        replace?.();
      }
      return directory;
    },
  };
});

vi.mock('../features/tui/runTuiTask.js', () => ({
  runTuiTaskConversation: mockRunTuiTaskConversation,
}));

vi.mock('../features/interactive/sessionInitialization.js', () => ({
  initializeSession: (...args: unknown[]) => mockInitializeSession(...args),
}));

vi.mock('../features/interactive/assistantInitFiles.js', () => ({
  loadAssistantInitContext: (...args: unknown[]) => mockLoadAssistantInitContext(...args),
}));

vi.mock('../features/tui/inkMount.js', () => ({
  mountInk: (...args: unknown[]) => mockMountInk(...args),
}));

vi.mock('../features/tasks/list/liveInterventionOpen.js', () => ({
  openLiveRunDirectory: (...args: unknown[]) => mockOpenLiveRunDirectory(...args),
}));

vi.mock('../infra/pi/index.js', () => ({
  callPi: (...args: unknown[]) => mockCallPi(...args),
}));

import { runLiveInterventionMode } from '../features/tasks/list/liveInterventionMode.js';
import { writeReportFile } from '../core/workflow/report-writer.js';
import { LiveInterventionFileStore } from '../infra/workflow/live-intervention-store.js';
import { PiProvider } from '../infra/providers/pi.js';

const RUN_SLUG = 'live-run';

function createLiveTask(
  projectCwd: string,
  cloneStatus: 'running' | 'completed' | 'aborted' | 'failed' = 'running',
): TaskListItem {
  const worktreePath = join(projectCwd, '.takt', 'worktrees', 'live-task');
  const runRoot = join(worktreePath, '.takt', 'runs', RUN_SLUG);
  mkdirSync(join(runRoot, 'logs'), { recursive: true });
  mkdirSync(join(runRoot, 'reports'), { recursive: true });
  writeFileSync(join(runRoot, 'logs', 'session.jsonl'), JSON.stringify({
    type: 'workflow_start',
    task: 'running task',
    workflowName: 'default',
    startTime: '2026-09-03T00:00:00.000Z',
  }) + '\n', 'utf8');
  writeFileSync(join(runRoot, 'meta.json'), JSON.stringify({
    task: 'running task',
    workflow: 'default',
    runSlug: RUN_SLUG,
    runRoot: `.takt/runs/${RUN_SLUG}`,
    reportDirectory: `.takt/runs/${RUN_SLUG}/reports`,
    contextDirectory: `.takt/runs/${RUN_SLUG}/context`,
    logsDirectory: `.takt/runs/${RUN_SLUG}/logs`,
    status: cloneStatus,
    startTime: '2026-09-03T00:00:00.000Z',
    currentStep: 'initial',
    phase: 1,
  }), 'utf8');

  return {
    kind: 'running',
    name: 'live-task',
    createdAt: '2026-09-03T00:00:00.000Z',
    filePath: join(projectCwd, '.takt', 'tasks.yaml'),
    content: 'running task',
    runSlug: RUN_SLUG,
    worktreePath,
    data: {
      task: 'running task',
      workflow: 'default',
      worktree: true,
    },
  };
}

describe('live intervention mode', () => {
  let projectCwd: string;

  beforeEach(() => {
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-live-mode-'));
    vi.resetAllMocks();
    reportOpenRace.targetPath = undefined;
    reportOpenRace.replace = undefined;
    reportOpenRace.replaced = false;
    reportChildOpenRace.targetPath = undefined;
    reportChildOpenRace.replace = undefined;
    reportChildOpenRace.replaced = false;
    reportListingRace.targetPath = undefined;
    reportListingRace.replace = undefined;
    reportListingRace.replaced = false;
    reportReadRace.targetPath = undefined;
    reportReadRace.replace = undefined;
    reportReadRace.replaced = false;
    reportReadRace.descriptor = undefined;
    mockInitializeSession.mockReturnValue({
      provider: {
        marker: 'live-provider',
        getRuntimeInstructions: () => null,
        setup: vi.fn(),
      },
      providerType: 'mock',
      model: 'live-provider-marker',
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    });
    mockLoadAssistantInitContext.mockReturnValue(undefined);
  });

  afterEach(() => {
    rmSync(projectCwd, { recursive: true, force: true });
  });

  it('does not append an intervention when the conversation is cancelled', async () => {
    const task = createLiveTask(projectCwd);
    mockRunTuiTaskConversation.mockResolvedValue({ action: 'cancel', task: '' });

    await runLiveInterventionMode(projectCwd, task);

    expect(mockRunTuiTaskConversation).toHaveBeenCalledTimes(1);
    expect(existsSync(join(projectCwd, '.takt', 'runs', RUN_SLUG, 'interventions.jsonl'))).toBe(false);
  });

  it('starts the assistant with read-only tools and the live command allowlist', async () => {
    const task = createLiveTask(projectCwd);
    mockRunTuiTaskConversation.mockImplementation(async (options: {
      readonly cwd: string;
      readonly plan: {
        readonly ctx: {
          readonly provider: {
            readonly marker?: string;
          };
          readonly providerType: string;
          readonly model?: string;
        };
        readonly strategy: {
          readonly systemPrompt: string;
          readonly allowedTools: readonly string[];
          readonly permissionMode?: string;
          readonly enabledCommands?: readonly string[];
        };
      };
    }) => {
      expect(options.cwd).toBe(task.worktreePath);
      expect(options.plan.ctx.provider.marker).toBe('live-provider');
      expect(options.plan.ctx.providerType).toBe('mock');
      expect(options.plan.ctx.model).toBe('live-provider-marker');
      expect(options.plan.strategy.systemPrompt).toContain('initial');
      expect(options.plan.strategy.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
      expect(options.plan.strategy.permissionMode).toBe('readonly');
      expect(new Set(options.plan.strategy.enabledCommands)).toEqual(
        new Set(['/go', '/cancel', '/open']),
      );
      return { action: 'cancel', task: '' };
    });

    await runLiveInterventionMode(projectCwd, task);

    expect(mockRunTuiTaskConversation).toHaveBeenCalledTimes(1);
  });

  it('resolves live settings and init context from the project while keeping the clone as cwd', async () => {
    const task = createLiveTask(projectCwd);
    mockInitializeSession.mockReturnValue({
      provider: { getRuntimeInstructions: () => null, setup: vi.fn() },
      providerType: 'pi',
      model: 'project-pi-model',
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
      providerOptions: {
        pi: {
          extensions: ['./untrusted-extension.ts'],
          noExtensions: false,
          thinkingLevel: 'high',
        },
      },
    });
    mockLoadAssistantInitContext.mockReturnValue('trusted project init context');
    mockRunTuiTaskConversation.mockImplementation(async (options: {
      readonly cwd: string;
      readonly plan: {
        readonly ctx: {
          readonly providerType: string;
          readonly model?: string;
          readonly providerOptions?: Record<string, unknown>;
        };
        readonly strategy: {
          readonly initialPromptContext?: string;
        };
      };
    }) => {
      expect(options.cwd).toBe(task.worktreePath);
      expect(options.plan.ctx.providerType).toBe('pi');
      expect(options.plan.ctx.model).toBe('project-pi-model');
      expect(options.plan.strategy.initialPromptContext).toBe('trusted project init context');
      expect(options.plan.ctx.providerOptions).toEqual({
        pi: {
          extensions: [],
          noExtensions: true,
          noContextFiles: true,
          thinkingLevel: 'high',
        },
      });
      return { action: 'cancel', task: '' };
    });

    await runLiveInterventionMode(projectCwd, task);

    expect(mockInitializeSession).toHaveBeenCalledWith(projectCwd, 'interactive');
    expect(mockLoadAssistantInitContext).toHaveBeenCalledWith(projectCwd);
  });

  it('does not add Pi restrictions to non-Pi provider options', async () => {
    const task = createLiveTask(projectCwd);
    const providerOptions = {
      opencode: {
        variant: 'project-variant',
        networkAccess: false,
      },
    };
    mockInitializeSession.mockReturnValue({
      provider: { getRuntimeInstructions: () => null, setup: vi.fn() },
      providerType: 'mock',
      model: 'mock-model',
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
      providerOptions,
    });
    mockRunTuiTaskConversation.mockImplementation(async (options: {
      readonly plan: {
        readonly ctx: {
          readonly providerOptions?: Record<string, unknown>;
        };
      };
    }) => {
      expect(options.plan.ctx.providerOptions).toEqual(providerOptions);
      expect(options.plan.ctx.providerOptions).not.toHaveProperty('pi');
      return { action: 'cancel', task: '' };
    });

    await runLiveInterventionMode(projectCwd, task);
  });

  it('rejects a provider without permission controls before starting live TUI', async () => {
    const task = createLiveTask(projectCwd);
    mockInitializeSession.mockReturnValue({
      provider: {
        getRuntimeInstructions: () => null,
        setup: vi.fn(),
      },
      providerType: 'deepseek-harness',
      model: 'deepseek-live-model',
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    });

    await expect(runLiveInterventionMode(projectCwd, task)).rejects.toThrow(
      'Provider "deepseek-harness" does not support live intervention permission controls',
    );

    expect(mockRunTuiTaskConversation).not.toHaveBeenCalled();
    expect(existsSync(join(projectCwd, '.takt', 'runs', RUN_SLUG, 'interventions.jsonl'))).toBe(false);
  });

  it('appends exactly the confirmed /go result to the project-side canonical file', async () => {
    const task = createLiveTask(projectCwd);
    mockRunTuiTaskConversation.mockImplementation(async (options: {
      readonly dispatch?: (result: {
        readonly action: 'execute';
        readonly task: string;
        readonly source: 'go';
      }) => Promise<string | null>;
    }) => {
      await options.dispatch?.({
        action: 'execute',
        task: 'apply this to future work',
        source: 'go',
      });
      return { action: 'cancel', task: '' };
    });

    await runLiveInterventionMode(projectCwd, task);

    const store = new LiveInterventionFileStore(projectCwd, RUN_SLUG);
    expect(store.read()).toMatchObject({
      issuedTotal: 1,
      pending: 1,
      instructions: [expect.objectContaining({
        instructionId: 1,
        content: 'apply this to future work',
        state: 'pending',
      })],
    });
    expect(readFileSync(store.getFilePath(), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('does not treat a result from another command path as a live issue', async () => {
    const task = createLiveTask(projectCwd);
    mockRunTuiTaskConversation.mockResolvedValue({
      action: 'execute',
      task: 'must not be issued by accept',
      source: 'accept',
    });

    await runLiveInterventionMode(projectCwd, task);

    expect(existsSync(join(projectCwd, '.takt', 'runs', RUN_SLUG, 'interventions.jsonl'))).toBe(false);
  });

  it.each(['completed', 'aborted', 'failed'] as const)(
    'does not start when the clone metadata is %s',
    async (status) => {
      const task = createLiveTask(projectCwd, status);

      await expect(runLiveInterventionMode(projectCwd, task)).rejects.toThrow(/running clone run/);

      expect(mockRunTuiTaskConversation).not.toHaveBeenCalled();
      expect(existsSync(join(projectCwd, '.takt', 'runs', RUN_SLUG, 'interventions.jsonl'))).toBe(false);
    },
  );

  it('rechecks clone status before dispatching an issue from /go', async () => {
    const task = createLiveTask(projectCwd);
    const metaPath = join(task.worktreePath!, '.takt', 'runs', RUN_SLUG, 'meta.json');
    mockRunTuiTaskConversation.mockImplementation(async (options: {
      readonly dispatch?: (result: {
        readonly action: 'execute';
        readonly task: string;
        readonly source: 'go';
      }) => Promise<string | null>;
    }) => {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(metaPath, JSON.stringify({ ...meta, status: 'completed' }), 'utf8');
      await expect(options.dispatch?.({
        action: 'execute',
        task: 'must not reach a terminal clone',
        source: 'go',
      })).rejects.toThrow(/running clone run/);
      return { action: 'cancel', task: '' };
    });

    await runLiveInterventionMode(projectCwd, task);

    expect(existsSync(join(projectCwd, '.takt', 'runs', RUN_SLUG, 'interventions.jsonl'))).toBe(false);
  });

  it.each([
    { lang: 'ja' as const, notice: '実行中タスクのディレクトリを開く' },
    { lang: 'en' as const, notice: 'Open the running task directory' },
  ])('hands /open to the opener with the session language (%s)', async ({ lang, notice }) => {
    const task = createLiveTask(projectCwd);
    mockOpenLiveRunDirectory.mockResolvedValue(undefined);
    mockInitializeSession.mockReturnValue({
      provider: { getRuntimeInstructions: () => null, setup: vi.fn() },
      providerType: 'mock',
      model: 'mock-model',
      lang,
      personaName: 'interactive',
      sessionId: undefined,
    });
    let mountCount = 0;
    let handoffNotice: string | undefined;
    mockMountInk.mockImplementation(async (
      buildTree: (handlers: {
        settle: (value: unknown) => void;
        fail: (error: unknown) => void;
      }) => ReactElement,
    ) => new Promise((resolve, reject) => {
      const element = buildTree({ settle: resolve, fail: reject });
      const props = element.props as {
        readonly conversation: {
          readonly resolveLocalCommand: (text: string) => {
            readonly kind: string;
            readonly id?: string;
            readonly text?: string;
          } | null;
        };
        readonly onExit: (exit: unknown, carried: unknown) => void;
        readonly initialEntries: readonly { readonly content: string }[];
      };
      mountCount += 1;
      if (mountCount === 1) {
        const command = props.conversation.resolveLocalCommand('/open');
        expect(command).toMatchObject({ kind: 'handoff', id: 'open' });
        if (command?.kind !== 'handoff' || command.id !== 'open') {
          reject(new Error('live /open command was not parsed as a handoff'));
          return;
        }
        props.onExit({
          kind: 'handoff',
          id: command.id,
          ...(command.text === undefined ? {} : { text: command.text }),
        }, { history: [], queue: [] });
        return;
      }
      handoffNotice = props.initialEntries[0]?.content;
      props.onExit(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        { history: [], queue: [] },
      );
    }));
    mockRunTuiTaskConversation.mockImplementation(async (options) => {
      const actual = await vi.importActual<typeof import('../features/tui/runTuiTask.js')>(
        '../features/tui/runTuiTask.js',
      );
      return actual.runTuiTaskConversation(options);
    });

    await runLiveInterventionMode(projectCwd, task);

    expect(mockOpenLiveRunDirectory).toHaveBeenCalledOnce();
    expect(mockOpenLiveRunDirectory).toHaveBeenCalledWith({
      directory: join(task.worktreePath!, '.takt', 'runs', RUN_SLUG),
    });
    expect(handoffNotice).toBe(notice);
  });

  it('rejects /open when the validated run directory becomes a symlink', async () => {
    const task = createLiveTask(projectCwd);
    const runDirectory = join(task.worktreePath!, '.takt', 'runs', RUN_SLUG);
    const outsideDirectory = mkdtempSync(join(tmpdir(), 'takt-live-open-outside-'));
    mockRunTuiTaskConversation.mockImplementation(async (options: {
      readonly onHandoff?: (id: 'open', text: string) => Promise<{ readonly kind: string }>;
    }) => {
      rmSync(runDirectory, { recursive: true, force: true });
      symlinkSync(outsideDirectory, runDirectory, 'dir');
      await expect(options.onHandoff?.('open', '')).rejects.toThrow(/symlink/);
      return { action: 'cancel', task: '' };
    });

    try {
      await runLiveInterventionMode(projectCwd, task);
      expect(mockOpenLiveRunDirectory).not.toHaveBeenCalled();
    } finally {
      rmSync(outsideDirectory, { recursive: true, force: true });
    }
  });

  it('does not pass report content outside the worktree when the report is replaced before opening', async () => {
    const task = createLiveTask(projectCwd);
    const reportPath = join(
      task.worktreePath!,
      '.takt',
      'runs',
      RUN_SLUG,
      'reports',
      'latest.md',
    );
    writeFileSync(reportPath, 'safe report', 'utf8');
    const outsideDirectory = mkdtempSync(join(tmpdir(), 'takt-live-report-race-outside-'));
    const outsideReportPath = join(outsideDirectory, 'outside.md');
    writeFileSync(outsideReportPath, 'outside report must not be observed', 'utf8');
    reportOpenRace.targetPath = reportPath;
    reportOpenRace.replace = () => {
      rmSync(reportPath, { force: true });
      symlinkSync(outsideReportPath, reportPath);
    };

    try {
      await expect(runLiveInterventionMode(projectCwd, task)).rejects.toThrow(/symbolic link|identity/);
      expect(reportOpenRace.replaced).toBe(true);
      expect(mockRunTuiTaskConversation).not.toHaveBeenCalled();
      expect(mockCallPi).not.toHaveBeenCalled();
    } finally {
      rmSync(outsideDirectory, { recursive: true, force: true });
    }
  });

  it('does not pass report content outside the worktree when a report parent is replaced before opening', async () => {
    const task = createLiveTask(projectCwd);
    const reportsDirectory = join(
      task.worktreePath!,
      '.takt',
      'runs',
      RUN_SLUG,
      'reports',
    );
    const reportPath = join(reportsDirectory, 'latest.md');
    writeFileSync(reportPath, 'safe report', 'utf8');
    const outsideDirectory = mkdtempSync(join(tmpdir(), 'takt-live-report-parent-race-outside-'));
    writeFileSync(join(outsideDirectory, 'latest.md'), 'outside report must not be observed', 'utf8');
    reportOpenRace.targetPath = reportPath;
    reportOpenRace.replace = () => {
      rmSync(reportsDirectory, { recursive: true, force: true });
      symlinkSync(outsideDirectory, reportsDirectory, 'dir');
    };

    try {
      await expect(runLiveInterventionMode(projectCwd, task)).rejects.toThrow(/symbolic link|identity/);
      expect(reportOpenRace.replaced).toBe(true);
      expect(mockRunTuiTaskConversation).not.toHaveBeenCalled();
      expect(mockCallPi).not.toHaveBeenCalled();
    } finally {
      rmSync(outsideDirectory, { recursive: true, force: true });
    }
  });

  it('does not pass a nested report replacement before child open to the provider', async () => {
    const task = createLiveTask(projectCwd);
    const reportsDirectory = join(
      task.worktreePath!,
      '.takt',
      'runs',
      RUN_SLUG,
      'reports',
    );
    const nestedDirectory = join(reportsDirectory, 'subworkflows');
    mkdirSync(nestedDirectory, { recursive: true });
    writeFileSync(join(nestedDirectory, 'safe.md'), 'safe report', 'utf8');
    const replacementReportPath = join(nestedDirectory, 'replacement.md');
    reportChildOpenRace.targetPath = nestedDirectory;
    reportChildOpenRace.replace = () => {
      rmSync(nestedDirectory, { recursive: true, force: true });
      mkdirSync(nestedDirectory, { recursive: true });
      writeFileSync(replacementReportPath, 'EXTERNAL_MARKER', 'utf8');
    };

    try {
      await expect(runLiveInterventionMode(projectCwd, task)).rejects.toThrow(
        /Report parent identity changed while opening/,
      );
      expect(reportChildOpenRace.replaced).toBe(true);
      expect(mockRunTuiTaskConversation).not.toHaveBeenCalled();
      expect(mockCallPi).not.toHaveBeenCalled();
      expect(mockCallPi.mock.calls.some((call) => (
        call.some((argument) => String(argument).includes('EXTERNAL_MARKER'))
      ))).toBe(false);
    } finally {
      reportChildOpenRace.targetPath = undefined;
      reportChildOpenRace.replace = undefined;
      rmSync(nestedDirectory, { recursive: true, force: true });
    }
  });

  it('does not pass a nested report replacement after the parent stream opens to the provider', async () => {
    const task = createLiveTask(projectCwd);
    const reportsDirectory = join(
      task.worktreePath!,
      '.takt',
      'runs',
      RUN_SLUG,
      'reports',
    );
    const nestedDirectory = join(reportsDirectory, 'subworkflows');
    mkdirSync(nestedDirectory, { recursive: true });
    writeFileSync(join(nestedDirectory, 'safe.md'), 'safe report', 'utf8');
    const replacementReportPath = join(nestedDirectory, 'replacement.md');
    reportListingRace.targetPath = reportsDirectory;
    reportListingRace.replace = () => {
      rmSync(nestedDirectory, { recursive: true, force: true });
      mkdirSync(nestedDirectory, { recursive: true });
      writeFileSync(replacementReportPath, 'EXTERNAL_MARKER', 'utf8');
    };

    try {
      await expect(runLiveInterventionMode(projectCwd, task)).rejects.toThrow(
        /Reports directory identity changed while reading/,
      );
      expect(reportListingRace.replaced).toBe(true);
      expect(mockRunTuiTaskConversation).not.toHaveBeenCalled();
      expect(mockCallPi).not.toHaveBeenCalled();
      expect(mockCallPi.mock.calls.some((call) => (
        call.some((argument) => String(argument).includes('EXTERNAL_MARKER'))
      ))).toBe(false);
    } finally {
      reportListingRace.targetPath = undefined;
      reportListingRace.replace = undefined;
      rmSync(nestedDirectory, { recursive: true, force: true });
    }
  });

  it('uses the last stable reports during publication and adopts them on the next refresh', async () => {
    const task = createLiveTask(projectCwd);
    const reportsDirectory = join(
      task.worktreePath!,
      '.takt',
      'runs',
      RUN_SLUG,
      'reports',
    );
    writeReportFile(reportsDirectory, 'stable.md', 'STABLE_REPORT');

    mockRunTuiTaskConversation.mockImplementation(async (options: {
      readonly plan: {
        readonly strategy: {
          readonly systemPrompt: string;
          readonly resolveCurrentPromptConfiguration?: () => Promise<{
            readonly systemPrompt: string;
          }>;
        };
      };
    }) => {
      expect(options.plan.strategy.systemPrompt).toContain('STABLE_REPORT');
      const refresh = options.plan.strategy.resolveCurrentPromptConfiguration;
      expect(refresh).toBeDefined();
      reportListingRace.targetPath = reportsDirectory;
      reportListingRace.replace = () => {
        writeReportFile(reportsDirectory, 'published.md', 'PUBLISHED_REPORT');
      };
      const duringPublication = await refresh!();
      expect(duringPublication.systemPrompt).toContain('STABLE_REPORT');
      expect(duringPublication.systemPrompt).not.toContain('PUBLISHED_REPORT');

      const afterPublication = await refresh!();
      expect(afterPublication.systemPrompt).toContain('PUBLISHED_REPORT');
      return { action: 'cancel', task: '' };
    });

    await runLiveInterventionMode(projectCwd, task);

    expect(reportListingRace.replaced).toBe(true);
    expect(mockRunTuiTaskConversation).toHaveBeenCalledTimes(1);
  });

  it('uses the last stable reports when an existing report is published during refresh', async () => {
    const task = createLiveTask(projectCwd);
    const reportsDirectory = join(
      task.worktreePath!,
      '.takt',
      'runs',
      RUN_SLUG,
      'reports',
    );
    const stableReportPath = writeReportFile(reportsDirectory, 'stable.md', 'STABLE_REPORT');

    mockRunTuiTaskConversation.mockImplementation(async (options: {
      readonly plan: {
        readonly strategy: {
          readonly systemPrompt: string;
          readonly resolveCurrentPromptConfiguration?: () => Promise<{
            readonly systemPrompt: string;
          }>;
        };
      };
    }) => {
      expect(options.plan.strategy.systemPrompt).toContain('STABLE_REPORT');
      const refresh = options.plan.strategy.resolveCurrentPromptConfiguration;
      expect(refresh).toBeDefined();
      reportReadRace.targetPath = stableReportPath;
      reportReadRace.replace = () => {
        writeReportFile(reportsDirectory, 'stable.md', 'PUBLISHED_REPORT');
      };
      const duringPublication = await refresh!();
      expect(duringPublication.systemPrompt).toContain('STABLE_REPORT');
      expect(duringPublication.systemPrompt).not.toContain('PUBLISHED_REPORT');

      const afterPublication = await refresh!();
      expect(afterPublication.systemPrompt).toContain('PUBLISHED_REPORT');
      return { action: 'cancel', task: '' };
    });

    await runLiveInterventionMode(projectCwd, task);

    expect(reportReadRace.replaced).toBe(true);
    expect(mockRunTuiTaskConversation).toHaveBeenCalledTimes(1);
  });

  it('refreshes live context before every turn and dispatches /go through the resident conversation', async () => {
    const task = createLiveTask(projectCwd);
    const reportPath = join(
      task.worktreePath!,
      '.takt',
      'runs',
      RUN_SLUG,
      'reports',
      'latest.md',
    );
    writeFileSync(reportPath, 'initial report', 'utf8');
    mockInitializeSession.mockReturnValue({
      provider: new PiProvider(),
      providerType: 'pi',
      model: 'project-pi-model',
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
      providerOptions: {
        pi: {
          extensions: ['./untrusted-extension.ts'],
          noExtensions: false,
          noContextFiles: false,
          thinkingLevel: 'high',
        },
      },
    });
    mockCallPi.mockImplementation(async (
      _agentType: string,
      _prompt: string,
      options: { readonly sessionId?: string },
    ) => ({
      persona: 'interactive',
      status: 'done' as const,
      content: 'generated live task',
      sessionId: options.sessionId ?? 'conversation-session',
      timestamp: new Date(),
    }));

    let mountCount = 0;
    let residentConversation: {
      readonly submit: (input: {
        readonly text: string;
        readonly abortSignal: AbortSignal;
        readonly onAssistantChunk: (chunk: string) => void;
      }) => Promise<{ readonly kind: string; readonly content?: string; readonly task?: string }>;
      readonly resolveLocalCommand: (text: string) => unknown;
    } | undefined;
    mockMountInk.mockImplementation(async (
      buildTree: (handlers: {
        settle: (value: unknown) => void;
        fail: (error: unknown) => void;
      }) => ReactElement,
    ) => new Promise((resolve, reject) => {
      const element = buildTree({ settle: resolve, fail: reject });
      const props = element.props as {
        readonly conversation: typeof residentConversation;
        readonly onExit: (exit: unknown, carried: unknown) => void;
      };
      const conversation = props.conversation;
      if (conversation === undefined) {
        reject(new Error('conversation was not mounted'));
        return;
      }
      const submit = (text: string) => conversation.submit({
        text,
        abortSignal: new AbortController().signal,
        onAssistantChunk: () => undefined,
      });
      void (async () => {
        try {
          mountCount += 1;
          if (mountCount === 1) {
            residentConversation = conversation;
            await submit('first live question');
            expect(conversation.resolveLocalCommand('/go')).toBeNull();
            writeFileSync(join(task.worktreePath!, '.takt', 'runs', RUN_SLUG, 'meta.json'), JSON.stringify({
              task: 'running task',
              workflow: 'default',
              runSlug: RUN_SLUG,
              runRoot: `.takt/runs/${RUN_SLUG}`,
              reportDirectory: `.takt/runs/${RUN_SLUG}/reports`,
              contextDirectory: `.takt/runs/${RUN_SLUG}/context`,
              logsDirectory: `.takt/runs/${RUN_SLUG}/logs`,
              status: 'running',
              startTime: '2026-09-03T00:00:00.000Z',
              currentStep: 'updated',
              phase: 2,
            }), 'utf8');
            writeFileSync(reportPath, 'updated report evidence', 'utf8');
            await new LiveInterventionFileStore(projectCwd, RUN_SLUG).issue('updated intervention history');
            await submit('second live question');
            const summary = await submit('/go');
            expect(summary.kind).toBe('task_instruction');
            props.onExit(
              { kind: 'choose_action', task: summary.task, origin: 'go' },
              { history: [], queue: [] },
            );
            return;
          }
          expect(conversation).toBe(residentConversation);
          await submit('question after dispatch');
          props.onExit(
            { kind: 'result', result: { action: 'cancel', task: '' } },
            { history: [], queue: [] },
          );
        } catch (error) {
          reject(error);
        }
      })();
    }));

    mockRunTuiTaskConversation.mockImplementation(async (options) => {
      const actual = await vi.importActual<typeof import('../features/tui/runTuiTask.js')>(
        '../features/tui/runTuiTask.js',
      );
      return actual.runTuiTaskConversation(options);
    });

    await runLiveInterventionMode(projectCwd, task);

    const systemPrompts = mockCallPi.mock.calls.map((call) => String(call[2]?.systemPrompt));
    expect(systemPrompts).toHaveLength(4);
    expect(systemPrompts[0]).toContain('initial');
    expect(systemPrompts[1]).toContain('updated');
    expect(systemPrompts[1]).toContain('updated report evidence');
    expect(systemPrompts[1]).toContain('updated intervention history');
    expect(systemPrompts[2]).toContain('updated');
    expect(systemPrompts[3]).toContain('updated');
    expect(mockCallPi.mock.calls[0]?.[2]).toMatchObject({
      cwd: task.worktreePath,
      permissionMode: 'readonly',
      allowedTools: ['Read', 'Glob', 'Grep'],
      providerOptions: {
        extensions: [],
        noExtensions: true,
        noContextFiles: true,
        thinkingLevel: 'high',
      },
    });

    const store = new LiveInterventionFileStore(projectCwd, RUN_SLUG);
    expect(store.read()).toMatchObject({
      issuedTotal: 2,
      pending: 2,
      instructions: [
        expect.objectContaining({ content: 'updated intervention history', state: 'pending' }),
        expect.objectContaining({ content: 'generated live task', state: 'pending' }),
      ],
    });
    expect(readFileSync(store.getFilePath(), 'utf8').trim().split('\n')).toHaveLength(2);
  });
});
