import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { runAgent } from '../agents/runner.js';
import type { PermissionMode } from '../core/models/index.js';
import type { WorkflowStep } from '../core/models/types.js';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import type { McpAssignmentSection } from '../infra/config/runtime-provider/mcp-assignment.js';
import { callAIWithRetry } from '../features/interactive/aiCaller.js';
import { createAssistantConversationPlan } from '../features/interactive/conversationPlan.js';
import { extractRetrySelectionAgreement } from '../features/interactive/retrySelectionAgreement.js';
import { runTellCommand } from '../features/interactive/tellCommand.js';
import { CopilotProvider } from '../infra/providers/copilot.js';
import { CursorProvider } from '../infra/providers/cursor.js';
import type { Provider, ProviderType } from '../infra/providers/types.js';

const { mockSpawn, mockInspectTellableRunningTasks, mockIssueTellableRunningTask, mockSelectOption, mockConfirmWithCancel } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockInspectTellableRunningTasks: vi.fn(),
  mockIssueTellableRunningTask: vi.fn(),
  mockSelectOption: vi.fn(),
  mockConfirmWithCancel: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mockSpawn,
}));

vi.mock('../features/tasks/liveIntervention.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/tasks/liveIntervention.js')>()),
  inspectTellableRunningTasks: (...args: unknown[]) => mockInspectTellableRunningTasks(...args),
  issueTellableRunningTask: (...args: unknown[]) => mockIssueTellableRunningTask(...args),
}));

vi.mock('../shared/prompt/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/prompt/index.js')>()),
  selectOption: (...args: unknown[]) => mockSelectOption(...args),
  confirmWithCancel: (...args: unknown[]) => mockConfirmWithCancel(...args),
}));

const TAKT_READ_TOOLS = ['takt_get_goal', 'takt_get_run', 'takt_list_goals', 'takt_list_tasks'] as const;
const TAKT_COPILOT_ALLOWANCES = TAKT_READ_TOOLS.map((tool) => `takt(${tool})`);
const ISOLATED_CALLS = ['strict-readonly', 'retry-agreement', 'tell'] as const;
type IsolatedCall = typeof ISOLATED_CALLS[number];
type AssistantMode = 'assistant' | 'grill-me';

function replyFromSpawnedCli(stdout: string): void {
  mockSpawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(() => true),
    });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(stdout, 'utf-8'));
      child.emit('close', 0, null);
    });
    return child;
  });
}

/** Cursor puts the prompt after `--`; everything before it is a CLI option. */
function cursorOptions(args: readonly string[]): string[] {
  const separator = args.indexOf('--');
  return separator === -1 ? [...args] : args.slice(0, separator);
}

/** Copilot passes the prompt as the value of `-p`; every other argument is a CLI option. */
function copilotOptions(args: readonly string[]): string[] {
  const promptIndex = args.indexOf('-p') + 1;
  return args.filter((_arg, index) => index !== promptIndex);
}

function copilotAllowedTools(args: readonly string[]): string[] {
  return copilotOptions(args)
    .filter((arg) => arg.startsWith('--allow-tool='))
    .map((arg) => arg.slice('--allow-tool='.length))
    .sort();
}

function spawnedArgs(): string[] {
  expect(mockSpawn).toHaveBeenCalledTimes(1);
  return mockSpawn.mock.calls[0]![1] as string[];
}

describe('assistant MCP tool permissions in Cursor and Copilot CLI arguments', () => {
  let projectCwd: string | undefined;
  let savedStdinIsTTY: boolean | undefined;
  let savedStdoutIsTTY: boolean | undefined;
  let savedNoTty: string | undefined;

  function writeRuntime(assignedToAssistant: readonly string[] | undefined): string {
    projectCwd = mkdtempSync(join(process.env.TAKT_CONFIG_DIR!, 'assistant-cli-args-'));
    mkdirSync(join(projectCwd, '.takt'));
    writeFileSync(join(projectCwd, '.takt', 'runtime.yaml'), stringify({
      version: 1,
      mcp: {
        servers: { backlog: { type: 'stdio', command: 'backlog-fixture' } },
        ...(assignedToAssistant === undefined
          ? {}
          : { targets: { personas: { assistant: { servers: [...assignedToAssistant] } } } }),
      },
    }));
    return projectCwd;
  }

  function createPlan(
    cwd: string,
    provider: Provider,
    providerType: ProviderType,
    options: { assistantMode?: AssistantMode; permissionMode?: PermissionMode; workflowMaker?: boolean } = {},
  ) {
    return createAssistantConversationPlan(cwd, {
      assistantMode: options.assistantMode ?? 'assistant',
      ...(options.workflowMaker === true ? { includeAssistantMcpServers: false } : {}),
      formalSpec: false,
      formalSpecComments: true,
      modelCheckTimeoutSeconds: 300,
      resolvedSessionContext: {
        provider,
        providerType,
        model: `${providerType}-model`,
        lang: 'en',
        personaName: 'interactive',
        sessionId: undefined,
        ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
      },
    });
  }

  async function runConversationTurn(plan: ReturnType<typeof createPlan>, cwd: string): Promise<string[]> {
    const outcome = await callAIWithRetry('read and register issues', plan.strategy.systemPrompt, plan.strategy.allowedTools,
      cwd, plan.ctx, { outputMode: 'silent', persistSession: false });
    expect(outcome.error).toBeUndefined();
    expect(outcome.result?.success).toBe(true);
    return spawnedArgs();
  }

  async function runIsolatedCall(call: IsolatedCall, plan: ReturnType<typeof createPlan>, cwd: string): Promise<string[]> {
    if (call === 'strict-readonly') {
      const outcome = await callAIWithRetry('summarize', plan.strategy.systemPrompt, [], cwd, plan.ctx, {
        outputMode: 'silent', persistSession: false, permissionMode: 'readonly', internalAgentIsolation: 'strict-readonly',
      });
      expect(outcome.result?.success).toBe(true);
    } else if (call === 'retry-agreement') {
      await expect(extractRetrySelectionAgreement({
        cwd, lang: 'en', sessionContext: plan.ctx, history: [{ role: 'user', content: 'retry the task' }],
      })).resolves.toBe('assistant reply');
    } else {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      process.env.TAKT_NO_TTY = '0';
      const notice = await runTellCommand({
        cwd, lang: 'en', inlineText: 'tell the running task', history: [], sessionContext: plan.ctx,
      });
      expect(notice).toContain('Additional instruction sent to running-task');
      expect(mockIssueTellableRunningTask).toHaveBeenCalledWith(cwd, 'running-run', 'assistant reply');
    }
    return spawnedArgs();
  }

  beforeEach(() => {
    vi.resetAllMocks();
    savedStdinIsTTY = process.stdin.isTTY;
    savedStdoutIsTTY = process.stdout.isTTY;
    savedNoTty = process.env.TAKT_NO_TTY;
    const target = {
      task: { name: 'running-task', summary: 'a running task', content: 'content', data: { workflow: 'default', worktree: true } },
      runSlug: 'running-run',
      worktreePath: '/worktree',
      meta: { workflow: 'default', currentStep: 'implement', status: 'running', runSlug: 'running-run' },
    };
    mockInspectTellableRunningTasks.mockReturnValue({ tasks: [target], excluded: [] });
    mockSelectOption.mockResolvedValue('running-run');
    mockConfirmWithCancel.mockResolvedValue({ kind: 'value', value: true });
    mockIssueTellableRunningTask.mockResolvedValue({ instructionId: 1, target });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: savedStdinIsTTY, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: savedStdoutIsTTY, configurable: true });
    if (savedNoTty === undefined) {
      delete process.env.TAKT_NO_TTY;
    } else {
      process.env.TAKT_NO_TTY = savedNoTty;
    }
    if (projectCwd !== undefined) {
      rmSync(projectCwd, { recursive: true, force: true });
      projectCwd = undefined;
    }
  });

  describe('Cursor', () => {
    beforeEach(() => replyFromSpawnedCli(JSON.stringify({ content: 'assistant reply' })));

    it.each(['assistant', 'grill-me'] as const)(
      'approves MCP servers and keeps readonly without --force in a readonly %s conversation with an assigned user server',
      async (assistantMode) => {
        const cwd = writeRuntime(['backlog']);
        const plan = createPlan(cwd, new CursorProvider(), 'cursor', { assistantMode, permissionMode: 'readonly' });

        const options = cursorOptions(await runConversationTurn(plan, cwd));

        expect(options).toContain('--approve-mcps');
        expect(options).toContain('--mode=ask');
        expect(options.filter((arg) => arg.startsWith('--force'))).toEqual([]);
      },
    );

    it('keeps --force from the full permission mode next to --approve-mcps', async () => {
      const cwd = writeRuntime(['backlog']);
      const plan = createPlan(cwd, new CursorProvider(), 'cursor', { permissionMode: 'full' });

      const options = cursorOptions(await runConversationTurn(plan, cwd));

      expect(options).toContain('--force');
      expect(options).toContain('--approve-mcps');
    });

    it.each([
      { name: 'a readonly conversation', permissionMode: 'readonly' as const },
      { name: 'a conversation without a permission mode', permissionMode: undefined },
    ])('does not approve MCP servers in $name when no user server is assigned', async ({ permissionMode }) => {
      const cwd = writeRuntime(undefined);
      const plan = createPlan(cwd, new CursorProvider(), 'cursor', { ...(permissionMode === undefined ? {} : { permissionMode }) });

      const options = cursorOptions(await runConversationTurn(plan, cwd));

      expect(options.filter((arg) => arg.startsWith('--approve-mcps'))).toEqual([]);
    });

    it('does not approve MCP servers in a Workflow Maker conversation although a user server is assigned', async () => {
      const cwd = writeRuntime(['backlog']);
      const plan = createPlan(cwd, new CursorProvider(), 'cursor', { permissionMode: 'readonly', workflowMaker: true });

      const options = cursorOptions(await runConversationTurn(plan, cwd));

      expect(options.filter((arg) => arg.startsWith('--approve-mcps'))).toEqual([]);
    });

    it.each(ISOLATED_CALLS)('does not approve MCP servers in the %s call although a user server is assigned', async (call) => {
      const cwd = writeRuntime(['backlog']);
      const plan = createPlan(cwd, new CursorProvider(), 'cursor', { permissionMode: 'readonly' });

      const options = cursorOptions(await runIsolatedCall(call, plan, cwd));

      expect(options.filter((arg) => arg.startsWith('--approve-mcps'))).toEqual([]);
    });
  });

  describe('Copilot', () => {
    beforeEach(() => replyFromSpawnedCli('assistant reply'));

    it.each(['assistant', 'grill-me'] as const)(
      'allows the assigned server as a whole and each built-in takt tool one by one while keeping the readonly denials in a readonly %s conversation',
      async (assistantMode) => {
        const cwd = writeRuntime(['backlog']);
        const plan = createPlan(cwd, new CopilotProvider(), 'copilot', { assistantMode, permissionMode: 'readonly' });

        const args = await runConversationTurn(plan, cwd);
        const options = copilotOptions(args);

        expect(copilotAllowedTools(args)).toEqual(['backlog', 'read', ...TAKT_COPILOT_ALLOWANCES].sort());
        expect(options).toContain('--deny-tool=write');
        expect(options).toContain('--deny-tool=shell');
        expect(options).not.toContain('--allow-all-tools');
        expect(options).not.toContain('--yolo');
      },
    );

    it('allows the assigned server and the built-in takt tools in a conversation without a permission mode', async () => {
      const cwd = writeRuntime(['backlog']);
      const plan = createPlan(cwd, new CopilotProvider(), 'copilot');

      const args = await runConversationTurn(plan, cwd);

      expect(copilotAllowedTools(args)).toEqual(['backlog', ...TAKT_COPILOT_ALLOWANCES].sort());
      expect(copilotOptions(args)).not.toContain('--yolo');
      expect(copilotOptions(args)).not.toContain('--allow-all-tools');
    });

    it('allows only the built-in takt tools in a Workflow Maker conversation although a user server is assigned', async () => {
      const cwd = writeRuntime(['backlog']);
      const plan = createPlan(cwd, new CopilotProvider(), 'copilot', { permissionMode: 'readonly', workflowMaker: true });

      const args = await runConversationTurn(plan, cwd);

      expect(copilotAllowedTools(args)).toEqual(['read', ...TAKT_COPILOT_ALLOWANCES].sort());
    });

    it.each([
      { permissionMode: 'edit' as const, modeFlag: '--allow-all-tools' },
      { permissionMode: 'full' as const, modeFlag: '--yolo' },
    ])('adds no MCP tool permission in the $permissionMode permission mode', async ({ permissionMode, modeFlag }) => {
      const cwd = writeRuntime(['backlog']);
      const plan = createPlan(cwd, new CopilotProvider(), 'copilot', { permissionMode });

      const args = await runConversationTurn(plan, cwd);

      expect(copilotOptions(args)).toContain(modeFlag);
      expect(copilotAllowedTools(args)).toEqual([]);
    });

    it.each(ISOLATED_CALLS)('adds no MCP tool permission and no MCP config in the %s call although a user server is assigned', async (call) => {
      const cwd = writeRuntime(['backlog']);
      const plan = createPlan(cwd, new CopilotProvider(), 'copilot', { permissionMode: 'readonly' });

      const options = copilotOptions(await runIsolatedCall(call, plan, cwd));

      expect(options.filter((arg) => arg.startsWith('--allow-tool=') && arg !== '--allow-tool=read')).toEqual([]);
      expect(options.filter((arg) => arg.startsWith('--additional-mcp-config'))).toEqual([]);
    });
  });

  describe('workflow step', () => {
    const workflowStepOf = (requiredPermissionMode: PermissionMode): WorkflowStep => ({
      name: 'implement', personaDisplayName: 'coder', instruction: 'task', passPreviousResponse: false,
      rules: [normalizeRule({ condition: 'approved', next: 'COMPLETE' })],
      requiredPermissionMode,
    });
    const mcpAssignment: McpAssignmentSection = {
      servers: { backlog: { type: 'stdio', command: 'backlog-fixture' } },
      defaults: { servers: ['backlog'] },
    };

    function workflowStepOptions(provider: 'cursor' | 'copilot', requiredPermissionMode: PermissionMode) {
      const cwd = writeRuntime(undefined);
      const options = new OptionsBuilder(
        { projectCwd: cwd, provider, model: `${provider}-model`, mcpAssignment },
        () => cwd, () => cwd, () => undefined, () => join(cwd, 'reports'), () => 'en', () => 'workflow',
      ).buildAgentOptions(workflowStepOf(requiredPermissionMode));
      return { cwd, options };
    }

    async function runWorkflowStep(provider: 'cursor' | 'copilot', requiredPermissionMode: PermissionMode): Promise<{ cwd: string; args: string[] }> {
      const { cwd, options } = workflowStepOptions(provider, requiredPermissionMode);
      const response = await runAgent(undefined, 'task', options);
      expect(response.status).toBe('done');
      return { cwd, args: spawnedArgs() };
    }

    it('keeps the Cursor arguments of a full-mode step with an assigned server free of MCP approval', async () => {
      replyFromSpawnedCli(JSON.stringify({ content: 'step reply' }));

      const { cwd, args } = await runWorkflowStep('cursor', 'full');
      const options = cursorOptions(args);

      expect(options[options.indexOf('--workspace') + 1]).not.toBe(cwd);
      expect(options).toContain('--force');
      expect(options.filter((arg) => arg.startsWith('--approve-mcps'))).toEqual([]);
    });

    it.each([
      { permissionMode: 'edit' as const, modeFlag: '--allow-all-tools' },
      { permissionMode: 'full' as const, modeFlag: '--yolo' },
    ])('keeps the Copilot arguments of a $permissionMode-mode step with an assigned server free of MCP tool permissions', async ({ permissionMode, modeFlag }) => {
      replyFromSpawnedCli('step reply');

      const { args } = await runWorkflowStep('copilot', permissionMode);
      const options = copilotOptions(args);

      expect(options.filter((arg) => arg.startsWith('--additional-mcp-config'))).toHaveLength(1);
      expect(options).toContain(modeFlag);
      expect(copilotAllowedTools(args)).toEqual([]);
    });

    it('still rejects a readonly Copilot step with an assigned server before any process is spawned', async () => {
      replyFromSpawnedCli('step reply');
      // A step is only readonly on Copilot when the project profile says so; the built-in default is higher.
      const { cwd, options } = workflowStepOptions('copilot', 'readonly');
      writeFileSync(join(cwd, '.takt', 'config.yaml'), stringify({
        provider_profiles: { copilot: { default_permission_mode: 'readonly' } },
      }));

      await expect(runAgent(undefined, 'task', options)).rejects.toThrow(/readonly permission mode/);

      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('adds neither MCP tool permissions nor permission-mode flags to a Copilot step that has no permission mode', async () => {
      replyFromSpawnedCli('step reply');
      const { options } = workflowStepOptions('copilot', 'edit');

      const response = await runAgent(undefined, 'task', { ...options, permissionMode: undefined, permissionResolution: undefined });
      const args = spawnedArgs();
      const flags = copilotOptions(args);

      expect(response.status).toBe('done');
      expect(flags.filter((arg) => arg.startsWith('--additional-mcp-config'))).toHaveLength(1);
      expect(copilotAllowedTools(args)).toEqual([]);
      expect(flags.filter((arg) => arg === '--yolo' || arg === '--allow-all-tools' || arg.startsWith('--deny-tool='))).toEqual([]);
    });
  });
});
