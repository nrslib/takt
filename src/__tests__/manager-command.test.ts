import { beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({ manager: vi.fn(), assistant: vi.fn() }));
vi.mock('../features/manager/runManager.js', () => ({ runManager: doubles.manager }));
vi.mock('../app/cli/routing.js', () => ({ executeDefaultAction: doubles.assistant }));
vi.mock('../app/cli/updateCheck.js', () => ({ runUpdateCheck: vi.fn() }));
vi.mock('../app/cli/initialization.js', () => ({
  assertConfigDirsDoNotCollide: vi.fn(), initializeCliExecutionContext: vi.fn(),
  getCliExecutionContext: () => ({ cwd: '/test/manager-repository', pipelineMode: false }),
}));
vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveConfigValue: () => 'en',
}));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

async function parse(args: string[]) {
  const { program } = await import('../app/cli/program.js');
  await import('../app/cli/commands.js');
  program.configureOutput({ writeErr: vi.fn() });
  await program.parseAsync(['node', 'takt', ...args]);
}

describe('manager CLI entrypoint', () => {
  it('starts the manager TUI with the target repository and CLI provider/model overrides', async () => {
    await parse(['--provider', 'mock', '--model', 'manager-test-model', 'manager']);

    expect(doubles.manager).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/test/manager-repository',
      agentOverrides: expect.objectContaining({ provider: 'mock', model: 'manager-test-model' }),
    }));
    expect(doubles.assistant).not.toHaveBeenCalled();
  });

  it('keeps the argument-free takt entrypoint on the existing assistant route', async () => {
    await parse([]);

    expect(doubles.assistant).toHaveBeenCalledTimes(1);
    expect(doubles.manager).not.toHaveBeenCalled();
  });
});
