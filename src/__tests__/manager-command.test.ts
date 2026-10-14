import { beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({ manager: vi.fn(), assistant: vi.fn(), resolveConfigValue: vi.fn() }));
vi.mock('../features/manager/runManager.js', () => ({ runManager: doubles.manager }));
vi.mock('../app/cli/routing.js', () => ({ executeDefaultAction: doubles.assistant }));
vi.mock('../app/cli/updateCheck.js', () => ({ runUpdateCheck: vi.fn() }));
vi.mock('../app/cli/initialization.js', () => ({
  assertConfigDirsDoNotCollide: vi.fn(), initializeCliExecutionContext: vi.fn(),
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

async function parse(args: string[]) {
  const { program } = await import('../app/cli/program.js');
  await import('../app/cli/commands.js');
  program.configureOutput({ writeErr: vi.fn() });
  await program.parseAsync(['node', 'takt', ...args]);
}

describe('manager CLI entrypoint', () => {
  it.each(['ja', 'en'])('keeps manager out of command registration and help for %s', async (lang) => {
    doubles.resolveConfigValue.mockReturnValue(lang);
    const { program } = await import('../app/cli/program.js');
    await import('../app/cli/commands.js');

    expect(program.commands.map((command) => command.name())).not.toContain('manager');
    expect(program.helpInformation()).not.toMatch(/\bmanager\b/u);
    expect(doubles.manager).not.toHaveBeenCalled();
  });

  it('keeps the argument-free takt entrypoint on the existing assistant route', async () => {
    await parse([]);

    expect(doubles.assistant).toHaveBeenCalledTimes(1);
    expect(doubles.manager).not.toHaveBeenCalled();
  });
});
