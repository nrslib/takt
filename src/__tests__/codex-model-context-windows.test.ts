import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('../shared/utils/executable-path.js', () => ({
  resolveWindowsPowerShellExecutablePath: () => 'powershell.exe',
}));

import { readCodexModelContextWindow } from '../infra/codex/model-context-window.js';

const temporaryDirectories: string[] = [];
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
  mocks.execFile.mockReset();
});

describe('Codex Windows system context configuration', () => {
  it('uses CommonApplicationData instead of the ProgramData environment variable', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    const root = mkdtempSync(join(tmpdir(), 'takt-codex-windows-context-'));
    temporaryDirectories.push(root);
    const system = join(root, '共有データ');
    const home = join(root, 'home');
    const configDirectory = join(system, 'OpenAI', 'Codex');
    mkdirSync(configDirectory, { recursive: true });
    mkdirSync(home);
    writeFileSync(join(configDirectory, 'config.toml'), 'model_context_window = 600_000\n');
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'synthetic-model', context_window: 272_000, max_context_window: 872_000 }],
    }));
    mocks.execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, { stdout: `${system}\n`, stderr: '' });
    });

    const result = await readCodexModelContextWindow('synthetic-model', {
      CODEX_HOME: home, ProgramData: join(root, 'wrong-system'),
    }, join(root, 'project'));
    expect(result).toEqual({ default: 600_000, maximum: 872_000 });
    expect(mocks.execFile).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining([expect.stringContaining('[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)')]),
      expect.objectContaining({ timeout: 5_000 }),
      expect.any(Function),
    );
    expect(mocks.execFile.mock.calls[0]?.[1]?.at(-1)).toContain('[Console]::OutputEncoding');
  });

  it('leaves auto selection unknown if the Windows system path cannot be resolved', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    const home = mkdtempSync(join(tmpdir(), 'takt-codex-windows-unknown-'));
    temporaryDirectories.push(home);
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'synthetic-model', context_window: 272_000, max_context_window: 872_000 }],
    }));
    mocks.execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(new Error('PowerShell unavailable'));
    });
    expect(await readCodexModelContextWindow('synthetic-model', { CODEX_HOME: home }, join(home, 'project')))
      .toBeUndefined();
  });
});
