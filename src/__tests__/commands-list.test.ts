import { beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({ listTasks: vi.fn() }));

vi.mock('../app/cli/initialization.js', () => ({
  assertConfigDirsDoNotCollide: vi.fn(),
  initializeCliExecutionContext: vi.fn(async () => undefined),
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
