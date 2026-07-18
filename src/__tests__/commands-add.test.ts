import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockOpts: Record<string, unknown> = {};
const mockAddTask = vi.fn();
const mockLogError = vi.fn();
const mockProcessExit = vi.fn();
const mockDeploySkillCodex = vi.fn();
const mockGetRoutingTelemetryStatus = vi.fn(() => ({ localRecordingEnabled: true }));
const mockEnableRoutingTelemetry = vi.fn(() => ({ localRecordingEnabled: true }));
const mockDisableRoutingTelemetry = vi.fn(() => ({ localRecordingEnabled: false }));

const { rootCommand, commandActions, commandMocks } = vi.hoisted(() => {
  const commandActions = new Map<string, (...args: unknown[]) => void>();
  const commandMocks = new Map<string, Record<string, unknown>>();

  function createCommandMock(actionKey: string): {
    description: ReturnType<typeof vi.fn>;
    argument: ReturnType<typeof vi.fn>;
    option: ReturnType<typeof vi.fn>;
    opts: ReturnType<typeof vi.fn>;
    action: (action: (...args: unknown[]) => void) => unknown;
    command: ReturnType<typeof vi.fn>;
  } {
    const command: Record<string, unknown> = {
      description: vi.fn().mockReturnThis(),
      argument: vi.fn().mockReturnThis(),
      option: vi.fn().mockReturnThis(),
      opts: vi.fn(() => mockOpts),
      optsWithGlobals: vi.fn(() => mockOpts),
    };
    commandMocks.set(actionKey, command);

    command.command = vi.fn((subName: string) => createCommandMock(`${actionKey}.${subName}`));
    command.action = vi.fn((action: (...args: unknown[]) => void) => {
      commandActions.set(actionKey, action);
      return command;
    });

    return command as {
      description: ReturnType<typeof vi.fn>;
      argument: ReturnType<typeof vi.fn>;
      option: ReturnType<typeof vi.fn>;
      opts: ReturnType<typeof vi.fn>;
      action: (action: (...args: unknown[]) => void) => unknown;
      command: ReturnType<typeof vi.fn>;
    };
  }

  return {
    rootCommand: createCommandMock('root'),
    commandActions,
    commandMocks,
  };
});

vi.mock('../app/cli/program.js', () => ({
  program: rootCommand,
}));

vi.mock('../app/cli/initialization.js', () => ({
  getCliExecutionContext: vi.fn(() => ({ cwd: '/test/cwd', pipelineMode: false })),
}));

vi.mock('../shared/ui/index.js', () => ({
  success: vi.fn(),
  info: vi.fn(),
  error: (...args: unknown[]) => mockLogError(...args),
}));

vi.mock('../features/tasks/add/index.js', () => ({
  addTask: (...args: unknown[]) => mockAddTask(...args),
}));

vi.mock('../features/config/deploySkillCodex.js', () => ({
  deploySkillCodex: (...args: unknown[]) => mockDeploySkillCodex(...args),
}));

vi.mock('../infra/config/global/globalConfigAccessors.js', () => ({
  getRoutingTelemetryStatus: (...args: unknown[]) => mockGetRoutingTelemetryStatus(...args),
  enableRoutingTelemetry: (...args: unknown[]) => mockEnableRoutingTelemetry(...args),
  disableRoutingTelemetry: (...args: unknown[]) => mockDisableRoutingTelemetry(...args),
}));

import '../app/cli/commands.js';
const sharedUi = await import('../shared/ui/index.js');

describe('CLI add command', () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockLogError.mockClear();
    mockProcessExit.mockClear();
    mockDeploySkillCodex.mockClear();
    mockGetRoutingTelemetryStatus.mockClear();
    mockEnableRoutingTelemetry.mockClear();
    mockDisableRoutingTelemetry.mockClear();
    vi.mocked(sharedUi.info).mockClear();
    vi.mocked(sharedUi.success).mockClear();
    for (const key of Object.keys(mockOpts)) {
      delete mockOpts[key];
    }
    vi.spyOn(process, 'exit').mockImplementation(mockProcessExit as never);
  });

  describe('when --pr option is provided', () => {
    it('should pass program.opts().pr to addTask as prNumber', async () => {
      const prNumber = 374;
      mockOpts.pr = prNumber;

      const addAction = commandActions.get('root.add');
      expect(addAction).toBeTypeOf('function');

      await addAction?.();
      expect(mockAddTask).toHaveBeenCalledWith('/test/cwd', undefined, { prNumber });
    });
  });

  describe('when --pr option is omitted', () => {
    it('should keep existing addTask call signature', async () => {
      const addAction = commandActions.get('root.add');
      expect(addAction).toBeTypeOf('function');

      await addAction?.('Regular task');

      expect(mockAddTask).toHaveBeenCalledWith('/test/cwd', 'Regular task', undefined);
    });

    it('should resolve canonical --workflow via command optsWithGlobals()', async () => {
      mockOpts.workflow = 'canonical-flow';
      const addAction = commandActions.get('root.add');
      const addCommand = commandMocks.get('root.add');

      expect(addAction).toBeTypeOf('function');
      expect(addCommand).toBeTruthy();

      await addAction?.('Regular task', addCommand as never);

      expect(mockAddTask).toHaveBeenCalledWith('/test/cwd', 'Regular task', { workflow: 'canonical-flow' });
      expect(addCommand?.optsWithGlobals).toHaveBeenCalled();
    });
  });

  it('should not register switch command', () => {
    const calledCommandNames = rootCommand.command.mock.calls
      .map((call: unknown[]) => call[0] as string);

    expect(calledCommandNames).not.toContain('switch');
  });

  it('should register export-codex command', () => {
    const calledCommandNames = rootCommand.command.mock.calls
      .map((call: unknown[]) => call[0] as string);

    expect(calledCommandNames).toContain('export-codex');
  });

  it('should invoke deploySkillCodex for export-codex command', async () => {
    const exportCodexAction = commandActions.get('root.export-codex');
    expect(exportCodexAction).toBeTypeOf('function');

    await exportCodexAction?.();
    expect(mockDeploySkillCodex).toHaveBeenCalledTimes(1);
  });

  it('should describe prompt workflow argument as defaulting to "default"', () => {
    const promptCommand = commandMocks.get('root.prompt');
    expect(promptCommand).toBeTruthy();
    expect(promptCommand?.description).toHaveBeenCalledWith('Preview assembled prompts for each step and phase');
    expect(promptCommand?.argument).toHaveBeenCalledWith(
      '[workflow]',
      'Workflow name or path (defaults to "default")',
    );
  });

  it('should describe eject with workflow terminology', () => {
    const ejectCommand = commandMocks.get('root.eject');
    expect(ejectCommand).toBeTruthy();
    expect(ejectCommand?.description).toHaveBeenCalledWith(
      'Copy builtin workflow or facet for customization (default: project .takt/)',
    );
    expect(ejectCommand?.argument).toHaveBeenNthCalledWith(
      1,
      '[typeOrName]',
      'Workflow name, or facet type (persona, policy, knowledge, instruction, output-contract)',
    );
  });

  it('should use workflow terminology for relevant command descriptions', () => {
    expect(commandMocks.get('root.reset.categories')?.description)
      .toHaveBeenCalledWith('Reset workflow categories to builtin defaults');
    expect(commandMocks.get('root.export-cc')?.description)
      .toHaveBeenCalledWith('Export takt workflows/agents as Claude Code Skill (~/.claude/)');
    expect(commandMocks.get('root.export-codex')?.description)
      .toHaveBeenCalledWith('Export takt workflows/agents as Codex Skill (~/.agents/)');
  });

  it('should register telemetry subcommands and wire them to config operations', async () => {
    const statusAction = commandActions.get('root.telemetry.status');
    const enableAction = commandActions.get('root.telemetry.enable');
    const disableAction = commandActions.get('root.telemetry.disable');
    const telemetryCommand = commandMocks.get('root.telemetry');
    const enableCommand = commandMocks.get('root.telemetry.enable');
    const disableCommand = commandMocks.get('root.telemetry.disable');

    expect(statusAction).toBeTypeOf('function');
    expect(enableAction).toBeTypeOf('function');
    expect(disableAction).toBeTypeOf('function');
    expect(telemetryCommand?.description).toHaveBeenCalledWith('Manage TAKT local routing event recording');
    expect(enableCommand?.description).toHaveBeenCalledWith('Enable local routing event recording');
    expect(disableCommand?.description).toHaveBeenCalledWith('Disable local routing event recording');

    await statusAction?.();
    await enableAction?.();
    await disableAction?.();

    expect(mockGetRoutingTelemetryStatus).toHaveBeenCalledWith('/test/cwd');
    expect(mockEnableRoutingTelemetry).toHaveBeenCalledWith('/test/cwd');
    expect(mockDisableRoutingTelemetry).toHaveBeenCalledWith('/test/cwd');
    const messages = [
      ...vi.mocked(sharedUi.info).mock.calls.map((call) => String(call[0])),
      ...vi.mocked(sharedUi.success).mock.calls.map((call) => String(call[0])),
    ];
    expect(messages).toHaveLength(3);
    const [statusMessage, enableMessage, disableMessage] = messages;
    expect(statusMessage).toContain('Local recording: enabled');
    expect(enableMessage).toContain('Local recording: enabled');
    expect(disableMessage).toContain('Local recording: disabled');
    const externalSendingTerms = ['up' + 'load', 'to' + 'ken', 're' + 'voke', 'end' + 'point'];
    for (const message of [statusMessage, enableMessage, disableMessage]) {
      expect(message).toContain('Routing decision recording is local only and writes to .takt/events');
      expect(message).not.toMatch(new RegExp(externalSendingTerms.join('|'), 'i'));
    }
  });
});
