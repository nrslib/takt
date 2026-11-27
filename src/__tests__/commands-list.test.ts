import { beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({ listTasks: vi.fn(), initialize: vi.fn(async () => undefined) }));

vi.mock('../app/cli/initialization.js', () => ({
  assertConfigDirsDoNotCollide: vi.fn(),
  initializeCliExecutionContext: doubles.initialize,
  getCliExecutionContext: () => ({ cwd: '/project', pipelineMode: false }),
}));
vi.mock('../app/cli/updateCheck.js', () => ({ runUpdateCheck: vi.fn(async () => undefined) }));
vi.mock('../features/tasks/list/index.js', () => ({ listTasks: doubles.listTasks }));

async function parseList(args: string[]): Promise<void> {
  const { program } = await import('../app/cli/program.js');
  await import('../app/cli/commands.js');
  program.exitOverride();
  program.configureOutput({ writeErr: vi.fn() });
  await program.parseAsync(['node', 'takt', 'list', '--non-interactive', ...args]);
}

async function expectStatusOptionRegistered(): Promise<void> {
  const { program } = await import('../app/cli/program.js');
  await import('../app/cli/commands.js');
  const list = program.commands.find((command) => command.name() === 'list');
  expect(list?.options.some((option) => option.long === '--status')).toBe(true);
}

describe('CLI list deletion filters', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('routes list to the task list', async () => {
    await parseList([]);
    expect(doubles.listTasks).toHaveBeenCalledExactlyOnceWith('/project', undefined,
      expect.objectContaining({ enabled: true }));
  });

  it('passes all five deletion statuses and the goal through the real argument parser', async () => {
    const statuses = ['pending', 'completed', 'failed', 'exceeded', 'pr_failed'];
    const goalId = '550e8400-e29b-41d4-a716-446655440000';

    await parseList(['--action', 'delete', '--status', ...statuses,
      '--goal', goalId, '--branch', 'feature/cleanup', '--yes', '--format', 'json']);

    expect(doubles.listTasks).toHaveBeenCalledExactlyOnceWith('/project', undefined, {
      enabled: true,
      action: 'delete',
      status: statuses,
      goal: goalId,
      branch: 'feature/cleanup',
      yes: true,
      format: 'json',
    });
  });

  it('allows goal-only preview without a branch or confirmation', async () => {
    await parseList(['--action', 'delete', '--goal', '550e8400-e29b-41d4-a716-446655440000']);

    expect(doubles.listTasks).toHaveBeenCalledWith('/project', undefined,
      expect.objectContaining({ enabled: true, action: 'delete',
        goal: '550e8400-e29b-41d4-a716-446655440000', yes: false }));
  });

  it.each(['running', 'unknown'])('rejects %s as an invalid status before entering listTasks', async (status) => {
    await expectStatusOptionRegistered();
    await expect(parseList(['--action', 'delete', '--status', status, '--yes']))
      .rejects.toThrow();
    expect(doubles.listTasks).not.toHaveBeenCalled();
  });

  it('rejects running even when another supplied status is allowed', async () => {
    await expectStatusOptionRegistered();
    await expect(parseList(['--action', 'delete', '--status', 'failed', 'running']))
      .rejects.toThrow();
    expect(doubles.listTasks).not.toHaveBeenCalled();
  });
});

describe('CLI worker commands', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function commands() {
    const { program } = await import('../app/cli/program.js');
    await import('../app/cli/commands.js');
    program.exitOverride();
    program.configureOutput({ writeErr: vi.fn() });
    const worker = program.commands.find((command) => command.name() === 'worker');
    expect(worker, 'worker must be reachable from the CLI').toBeDefined();
    return { program, worker: worker! };
  }

  it('prints worker startup options and all management commands with descriptions in help', async () => {
    const { program, worker } = await commands();
    const output: string[] = [];
    program.configureOutput({ writeOut: (text) => { output.push(text); }, writeErr: vi.fn() });

    await expect(program.parseAsync(['node', 'takt', 'worker', '--help']))
      .rejects.toMatchObject({ code: 'commander.helpDisplayed', exitCode: 0 });

    const help = output.join('');
    expect(help).toContain('--url');
    expect(help).toContain('--token');
    for (const name of ['add', 'list', 'remove']) {
      const child = worker.commands.find((command) => command.name() === name);
      expect(child, name).toBeDefined();
      expect(child!.description().trim().length).toBeGreaterThan(0);
      expect(help.replace(/\s+/g, ' ')).toContain(child!.description().replace(/\s+/g, ' '));
    }
    for (const flag of ['--url', '--token']) {
      const option = worker.options.find((candidate) => candidate.long === flag);
      expect(option, flag).toBeDefined();
      expect(option!.description.trim().length).toBeGreaterThan(0);
    }
    expect(doubles.initialize).not.toHaveBeenCalled();
  });

  it('parses worker startup with only URL and token without initializing a project', async () => {
    const { program, worker } = await commands();
    const start = vi.fn();
    worker.action(start);

    await program.parseAsync(['node', 'takt', 'worker', '--url', 'http://localhost:43210',
      '--token', 'parser-test-token']);

    expect(start).toHaveBeenCalledOnce();
    expect(worker.opts()).toMatchObject({ url: 'http://localhost:43210', token: 'parser-test-token' });
    expect(doubles.initialize).not.toHaveBeenCalled();
  });

  it('parses the worker name and concurrency for registration', async () => {
    const { program, worker } = await commands();
    const add = worker.commands.find((command) => command.name() === 'add');
    expect(add).toBeDefined();
    const register = vi.fn();
    add!.action(register);

    await program.parseAsync(['node', 'takt', 'worker', 'add', 'w1', '--concurrency', '2']);

    expect(register).toHaveBeenCalledOnce();
    expect(register.mock.calls[0]![0]).toBe('w1');
    expect(Number(add!.opts().concurrency)).toBe(2);
  });

  it.each(['list', 'remove'])('reaches the worker %s action through the argument parser', async (name) => {
    const { program, worker } = await commands();
    const command = worker.commands.find((candidate) => candidate.name() === name);
    expect(command).toBeDefined();
    const action = vi.fn();
    command!.action(action);

    await program.parseAsync(['node', 'takt', 'worker', name, ...(name === 'remove' ? ['w1'] : [])]);

    expect(action).toHaveBeenCalledOnce();
    if (name === 'remove') expect(action.mock.calls[0]![0]).toBe('w1');
  });
});
