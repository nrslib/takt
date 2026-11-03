import { beforeEach, describe, expect, it, vi } from 'vitest';
import { measureWidth } from '../shared/utils/grapheme.js';
import { stripAnsi } from '../shared/utils/text.js';

const doubles = vi.hoisted(() => ({
  manager: vi.fn(), director: vi.fn(), assistant: vi.fn(), list: vi.fn(), initialize: vi.fn(), resolveConfigValue: vi.fn(),
}));
const daemon = vi.hoisted(() => ({ run: vi.fn(), stop: vi.fn() }));
vi.mock('../features/daemon/runDaemon.js', () => ({ runDaemon: daemon.run }));
vi.mock('../features/daemon/lifecycle.js', () => ({ stopDaemon: daemon.stop }));
vi.mock('../features/manager/runManager.js', () => ({ runManager: doubles.manager }));
vi.mock('../features/director/runDirector.js', () => ({ runDirector: doubles.director }));
vi.mock('../features/tasks/list/index.js', () => ({ listTasks: doubles.list }));
vi.mock('../app/cli/routing.js', () => ({ executeDefaultAction: doubles.assistant }));
vi.mock('../app/cli/updateCheck.js', () => ({ runUpdateCheck: vi.fn() }));
vi.mock('../app/cli/initialization.js', () => ({
  assertConfigDirsDoNotCollide: vi.fn(), initializeCliExecutionContext: doubles.initialize,
  getCliExecutionContext: () => ({ cwd: '/test/manager-repository', pipelineMode: false }),
}));
vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveConfigValue: doubles.resolveConfigValue,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  doubles.resolveConfigValue.mockReturnValue('en');
});

describe('director CLI entrypoint', () => {
  it.each([
    { lang: 'ja', experimental: /実験的/u, costs: /provider.*費用/iu },
    { lang: 'en', experimental: /experimental/iu, costs: /provider.*cost/iu },
  ])('shows experimental and provider cost notices in director --help for $lang at 80 columns without starting AI', async ({ lang, experimental, costs }) => {
    doubles.resolveConfigValue.mockReturnValue(lang);
    const { program } = await import('../app/cli/program.js');
    await import('../app/cli/commands.js');
    const command = program.commands.find((candidate) => candidate.name() === 'director');
    expect(command).toBeDefined();
    command!.configureHelp({ helpWidth: 80 });
    const writeOut = vi.fn();
    program.configureOutput({ writeOut, writeErr: vi.fn() });

    await expect(program.parseAsync(['node', 'takt', 'director', '--help']))
      .rejects.toMatchObject({ code: 'commander.helpDisplayed', exitCode: 0 });

    const output = stripAnsi(writeOut.mock.calls.map(([message]) => message).join(''));
    const text = output.replace(/\s+/gu, ' ');
    expect(text).toContain('Usage: takt director');
    expect(text).toMatch(experimental);
    expect(text).toMatch(costs);
    for (const line of output.split('\n')) expect(measureWidth(line)).toBeLessThanOrEqual(80);
    expect(doubles.director).not.toHaveBeenCalled();
    expect(doubles.manager).not.toHaveBeenCalled();
    expect(doubles.assistant).not.toHaveBeenCalled();
    expect(daemon.run).not.toHaveBeenCalled();
    expect(doubles.initialize).not.toHaveBeenCalled();
  });

  it('starts the director TUI through common initialization with CLI provider and model overrides', async () => {
    await parse(['--provider', 'mock', '--model', 'director-test-model', 'director']);

    const { program, cliVersion } = await import('../app/cli/program.js');
    expect(doubles.initialize).toHaveBeenCalledExactlyOnceWith(program, cliVersion, true);
    expect(doubles.director).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      cwd: '/test/manager-repository',
      agentOverrides: expect.objectContaining({ provider: 'mock', model: 'director-test-model' }),
    }));
    expect(doubles.manager).not.toHaveBeenCalled();
    expect(doubles.assistant).not.toHaveBeenCalled();
  });

  it('waits for common initialization before starting the director', async () => {
    let complete!: () => void;
    doubles.initialize.mockReturnValueOnce(new Promise<void>((resolve) => { complete = resolve; }));

    const running = parse(['director']);
    try {
      await vi.waitFor(() => expect(doubles.initialize).toHaveBeenCalledOnce());
      expect(doubles.director).not.toHaveBeenCalled();
    } finally {
      complete();
      await running;
    }
    expect(doubles.director).toHaveBeenCalledOnce();
  });
});

async function parse(args: string[]) {
  const { program } = await import('../app/cli/program.js');
  await import('../app/cli/commands.js');
  program.configureOutput({ writeErr: vi.fn() });
  await program.parseAsync(['node', 'takt', ...args]);
}

describe('manager CLI entrypoint', () => {
  it('routes the internal daemon invocation and its public stop command', async () => {
    await parse(['daemon']);
    expect(daemon.run).toHaveBeenCalledOnce();
    expect(daemon.stop).not.toHaveBeenCalled();
    await parse(['daemon', 'stop']);
    expect(daemon.stop).toHaveBeenCalledOnce();
    const initialization = await import('../app/cli/initialization.js');
    expect(initialization.initializeCliExecutionContext).not.toHaveBeenCalled();
    expect(doubles.manager).not.toHaveBeenCalled();
    expect(doubles.assistant).not.toHaveBeenCalled();
  });

  it('advertises stop in help without an internal start subcommand', async () => {
    const { program } = await import('../app/cli/program.js');
    await import('../app/cli/commands.js');
    const command = program.commands.find((candidate) => candidate.name() === 'daemon')!;
    expect(command.helpInformation()).toContain('stop');
    expect(command.commands.map((candidate) => candidate.name())).toEqual(['stop']);
  });
  it.each([
    { lang: 'ja', description: /実験的.*会話 TUI/u, changes: /動作・設定・保存するデータの形式.*予告なく/u, costs: /自動でタスクを投入・実行.*provider の API の費用/u },
    { lang: 'en', description: /experimental.*conversation TUI/iu, changes: /behavior, settings, and saved data formats.*without notice/iu, costs: /automatically queues and runs tasks.*provider API costs/iu },
  ])('shows experimental and cost notices in manager --help for $lang without starting the manager', async ({ lang, description, changes, costs }) => {
    doubles.resolveConfigValue.mockReturnValue(lang);
    const { program } = await import('../app/cli/program.js');
    await import('../app/cli/commands.js');
    const writeOut = vi.fn();
    program.configureOutput({ writeOut });

    await expect(program.parseAsync(['node', 'takt', 'manager', '--help']))
      .rejects.toMatchObject({ code: 'commander.helpDisplayed', exitCode: 0 });

    const help = writeOut.mock.calls.map(([message]) => message).join('').replace(/\s+/gu, ' ');
    expect(help).toContain('Usage: takt manager');
    expect(help).toMatch(description);
    expect(help).toMatch(changes);
    expect(help).toMatch(costs);
    expect(doubles.resolveConfigValue).toHaveBeenCalledWith(process.cwd(), 'language');
    expect(doubles.manager).not.toHaveBeenCalled();
    expect(doubles.assistant).not.toHaveBeenCalled();
  });

  it('starts the manager TUI with the target repository and CLI provider/model overrides', async () => {
    await parse(['--provider', 'mock', '--model', 'manager-test-model', 'manager']);

    const { program, cliVersion } = await import('../app/cli/program.js');
    expect(doubles.initialize).toHaveBeenCalledExactlyOnceWith(program, cliVersion, true);
    expect(doubles.manager).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/test/manager-repository',
      agentOverrides: expect.objectContaining({ provider: 'mock', model: 'manager-test-model' }),
    }));
    expect(doubles.assistant).not.toHaveBeenCalled();
  });

  it('waits for common initialization before starting the manager', async () => {
    let complete!: () => void;
    doubles.initialize.mockReturnValueOnce(new Promise<void>((resolve) => { complete = resolve; }));

    const running = parse(['manager']);
    try {
      await vi.waitFor(() => expect(doubles.initialize).toHaveBeenCalledOnce());
      expect(doubles.manager).not.toHaveBeenCalled();
    } finally {
      complete();
      await running;
    }
    expect(doubles.manager).toHaveBeenCalledOnce();
  });

  it.each([
    { args: ['list'], target: 'list' as const },
    { args: ['--model', 'manager', 'list'], target: 'list' as const },
    { args: ['--model=manager', 'list'], target: 'list' as const },
    { args: ['--model', 'manager'], target: 'assistant' as const },
  ])('keeps console logging enabled for $args', async ({ args, target }) => {
    await parse(args);

    expect(doubles.initialize).toHaveBeenCalledOnce();
    expect(doubles.initialize.mock.calls[0]?.[2] === true).toBe(false);
    expect(doubles[target]).toHaveBeenCalledOnce();
    expect(doubles.manager).not.toHaveBeenCalled();
  });

  it('keeps the argument-free takt entrypoint on the existing assistant route', async () => {
    await parse([]);

    expect(doubles.assistant).toHaveBeenCalledTimes(1);
    expect(doubles.manager).not.toHaveBeenCalled();
  });
});
