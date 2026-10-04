import { execFileSync } from 'node:child_process';
import { realpathSync, statSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  realpathSync: vi.fn(),
  statSync: vi.fn(),
}));

const startTime = '2026-10-03T14:23:40.1234567Z';
const otherPid = process.pid + 1;
const systemRoot = join(tmpdir(), 'takt-windows');
const system32 = join(systemRoot, 'System32');
const powershell = join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const inspectionOptions = {
  encoding: 'utf8', shell: false, timeout: 1_000,
  stdio: ['ignore', 'pipe', 'ignore'],
};

beforeEach(() => {
  vi.resetModules();
  vi.mocked(execFileSync).mockReset();
  vi.mocked(realpathSync).mockReset().mockImplementation((path) => String(path));
  vi.mocked(statSync).mockReset().mockReturnValue({ isFile: () => true } as Stats);
  vi.stubEnv('SystemRoot', systemRoot);
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Windows のプロセス識別', () => {
  it('指定した別 PID の UTC 開始時刻を精度を保って返す', async () => {
    vi.mocked(execFileSync).mockReturnValue(`${startTime}\r\n`);
    const { getProcessIdentity } = await import('../infra/task/process.js');

    expect(getProcessIdentity(otherPid)).toEqual({ startTime });
    expect(execFileSync).toHaveBeenCalledWith(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${otherPid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('O')`,
    ], inspectionOptions);
  });

  it('cwd・PATH に同名候補があっても OS 側の検証済み実体だけを起動する', async () => {
    const projectDir = join(tmpdir(), 'takt-project');
    const projectExecutable = join(projectDir, 'powershell.exe');
    const canonicalPowershell = join(system32, 'WindowsPowerShell', 'v1.0', 'POWERSHELL.EXE');
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    vi.stubEnv('PATH', projectDir);
    vi.mocked(realpathSync).mockImplementation((path) => String(path) === powershell ? canonicalPowershell : String(path));
    vi.mocked(execFileSync).mockReturnValue(startTime);
    const { getProcessIdentity } = await import('../infra/task/process.js');

    expect(getProcessIdentity(otherPid)).toEqual({ startTime });
    expect(statSync).toHaveBeenCalledWith(powershell);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execFileSync).mock.calls[0]?.[0]).toBe(canonicalPowershell);
    expect(statSync).not.toHaveBeenCalledWith(projectExecutable);
  });

  it('OS 側の候補がプロジェクトの実体へ解決される場合は起動せず未知を返す', async () => {
    const projectExecutable = join(tmpdir(), 'takt-project', 'powershell.exe');
    vi.mocked(realpathSync).mockImplementation((path) => String(path) === powershell ? projectExecutable : String(path));
    const { getProcessIdentity } = await import('../infra/task/process.js');

    expect(getProcessIdentity(otherPid)).toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'Windows'])('OS ルート %j は起動前に拒否する', async (root) => {
    vi.stubEnv('SystemRoot', root);
    const { getProcessIdentity } = await import('../infra/task/process.js');

    expect(getProcessIdentity(otherPid)).toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('OS 側の実行ファイルが利用不能なら自己識別の未知をキャッシュして代用しない', async () => {
    vi.mocked(statSync).mockImplementation(() => { throw new Error('unavailable'); });
    const { getSelfProcessIdentity, getProcessIdentity } = await import('../infra/task/process.js');

    expect(getSelfProcessIdentity()).toBeUndefined();
    vi.mocked(statSync).mockReturnValue({ isFile: () => true } as Stats);
    expect(getProcessIdentity(process.pid)).toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(statSync).toHaveBeenCalledTimes(1);
  });

  it('自己 PID の開始時刻を一度だけ照会して両 helper で共有する', async () => {
    vi.mocked(execFileSync).mockReturnValue(startTime);
    const { getProcessIdentity, getSelfProcessIdentity } = await import('../infra/task/process.js');

    expect(getSelfProcessIdentity()).toEqual({ startTime });
    expect(getProcessIdentity(process.pid)).toEqual({ startTime });
    expect(getSelfProcessIdentity()).toEqual({ startTime });
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execFileSync).mock.calls[0]?.[1]).toContain(
      `(Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('O')`,
    );
  });

  it('別 PID は再照会し、再利用された PID の開始時刻変化を検出する', async () => {
    const nextStartTime = '2026-10-03T14:23:41.1234567Z';
    vi.mocked(execFileSync).mockReturnValueOnce(startTime).mockReturnValueOnce(nextStartTime);
    const { getProcessIdentity, sameProcessIdentity } = await import('../infra/task/process.js');

    const first = getProcessIdentity(otherPid);
    const second = getProcessIdentity(otherPid);
    expect(first).toEqual({ startTime });
    expect(second).toEqual({ startTime: nextStartTime });
    expect(sameProcessIdentity(first, second)).toBe(false);
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it.each([
    '', ' \r\n\t', 'unknown', 'Sat Oct 03 14:23:40 2026',
    '2026-10-03T14:23:40.123Z', '2026-10-03T14:23:40.1234567+00:00',
    '2026-13-03T14:23:40.1234567Z', '2026-10-03T24:23:40.1234567Z',
    `${startTime}\n${startTime}`,
  ])('指定 UTC 形式を確認できない出力 %j は未知にする', async (output) => {
    vi.mocked(execFileSync).mockReturnValue(output);
    const { getProcessIdentity } = await import('../infra/task/process.js');

    expect(getProcessIdentity(otherPid)).toBeUndefined();
  });

  it.each(['ENOENT', 'EACCES', 'ETIMEDOUT', 'process lookup failed'])('照会の失敗 %s は未知にし、代用しない', async (code) => {
    vi.mocked(execFileSync).mockImplementation(() => { throw Object.assign(new Error(code), { code }); });
    const { getProcessIdentity } = await import('../infra/task/process.js');

    expect(getProcessIdentity(otherPid)).toBeUndefined();
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('自己識別の失敗もキャッシュし、未知同士を一致扱いしない', async () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('lookup failed'); });
    const { getSelfProcessIdentity, getProcessIdentity, sameProcessIdentity } = await import('../infra/task/process.js');

    expect(getSelfProcessIdentity()).toBeUndefined();
    vi.mocked(execFileSync).mockReturnValue(startTime);
    expect(getProcessIdentity(process.pid)).toBeUndefined();
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(sameProcessIdentity(undefined, undefined)).toBe(false);
    expect(sameProcessIdentity({ startTime }, undefined)).toBe(false);
    expect(sameProcessIdentity(undefined, { startTime })).toBe(false);
    expect(sameProcessIdentity({ startTime }, { startTime })).toBe(true);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('無効 PID %s は照会しない', async (pid) => {
    const { getProcessIdentity } = await import('../infra/task/process.js');

    expect(getProcessIdentity(pid)).toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe('既存 OS のプロセス識別', () => {
  it.each(['darwin', 'linux'] as const)('%s の ps 形式・引数・自己キャッシュを維持する', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const psStartTime = 'Sat Oct  3 14:23:40 2026';
    vi.mocked(execFileSync).mockReturnValue(`  ${psStartTime}\n`);
    const { getProcessIdentity, getSelfProcessIdentity } = await import('../infra/task/process.js');

    expect(getProcessIdentity(otherPid)).toEqual({ startTime: psStartTime });
    expect(execFileSync).toHaveBeenCalledWith('ps', ['-o', 'lstart=', '-p', String(otherPid)], inspectionOptions);
    expect(getSelfProcessIdentity()).toEqual({ startTime: psStartTime });
    expect(getProcessIdentity(process.pid)).toEqual({ startTime: psStartTime });
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it.each(['darwin', 'linux'] as const)('%s の ps 空出力と失敗は未知にする', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    vi.mocked(execFileSync).mockReturnValueOnce(' \n').mockImplementationOnce(() => { throw new Error('ps failed'); });
    const { getProcessIdentity } = await import('../infra/task/process.js');

    expect(getProcessIdentity(otherPid)).toBeUndefined();
    expect(getProcessIdentity(otherPid)).toBeUndefined();
  });

  it('未対応 OS は外部照会せず未知にする', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('freebsd');
    const { getProcessIdentity } = await import('../infra/task/process.js');

    expect(getProcessIdentity(otherPid)).toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
