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
