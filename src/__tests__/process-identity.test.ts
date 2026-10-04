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
    '2026-02-29T14:23:40.1234567Z', '2026-04-31T14:23:40.1234567Z',
    '1900-02-29T14:23:40.1234567Z', '0000-01-01T00:00:00.0000000Z',
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
  it.each([
    'unknown', 'Sun Oct  4 10:28:57 2026 trailing', 'Sun Oct  4 24:28:57 2026',
    'Sun Feb 29 10:28:57 2026', 'Fri Apr 31 10:28:57 2026',
    'Mon Oct  4 10:28:57 2026', 'Sun Oct  4 10:28:57 0000',
    'Sun Oct 04 10:28:57 2026',
  ])('不正な ps 出力 %j は保存用の自己識別にも使わない', async (output) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.mocked(execFileSync).mockReturnValue(output);
    const { getProcessIdentity, getSelfProcessIdentity } = await import('../infra/task/process.js');
    expect(getSelfProcessIdentity()).toBeUndefined();
    expect(getProcessIdentity(otherPid)).toBeUndefined();
  });

  it.each([
    { invalid: 'ps-lstart-utc-v1:garbage', valid: 'ps-lstart-utc-v1:Sun Oct  4 10:28:57 2026' },
    { invalid: 'ps-lstart-utc-v1:Sun Oct 04 10:28:57 2026', valid: 'ps-lstart-utc-v1:Sun Oct  4 10:28:57 2026' },
    { invalid: 'ps-lstart-utc-v1:Sun Oct  4 10:28:57 2026\n', valid: 'ps-lstart-utc-v1:Sun Oct  4 10:28:57 2026' },
    { invalid: 'ps-lstart-utc-v1:Sun Feb 29 10:28:57 2026', valid: 'ps-lstart-utc-v1:Sun Oct  4 10:28:57 2026' },
    { invalid: '2026-02-29T14:23:40.1234567Z', valid: startTime },
    { invalid: '2026-04-31T14:23:40.1234567Z', valid: startTime },
    { invalid: `${startTime}\n`, valid: startTime },
  ])('不正な開始時刻 $invalid は一致も不一致も証明しない', async ({ invalid, valid }) => {
    const { sameProcessIdentity, hasProcessIdentityMismatch } = await import('../infra/task/process.js');
    expect(sameProcessIdentity({ startTime: invalid }, { startTime: invalid })).toBe(false);
    expect(hasProcessIdentityMismatch({ startTime: invalid }, { startTime: valid })).toBe(false);
    expect(hasProcessIdentityMismatch({ startTime: valid }, { startTime: invalid })).toBe(false);
  });

  it.each([
    { platform: 'linux', output: 'Tue Feb 29 14:23:40 2000', stored: 'ps-lstart-utc-v1:Tue Feb 29 14:23:40 2000' },
    { platform: 'win32', output: '2000-02-29T14:23:40.1234567Z', stored: '2000-02-29T14:23:40.1234567Z' },
  ] as const)('$platform の実在する閏日は精度を保って保存・比較する', async ({ platform, output, stored }) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    vi.mocked(execFileSync).mockReturnValue(output);
    const { getSelfProcessIdentity, sameProcessIdentity } = await import('../infra/task/process.js');
    expect(getSelfProcessIdentity()).toEqual({ startTime: stored });
    expect(sameProcessIdentity(getSelfProcessIdentity(), { startTime: stored })).toBe(true);
  });

  it.each(['darwin', 'linux'] as const)('%s の ps 形式・引数・自己キャッシュを維持する', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const psStartTime = 'Sat Oct  3 14:23:40 2026';
    vi.mocked(execFileSync).mockReturnValue(`  ${psStartTime}\n`);
    const { getProcessIdentity, getSelfProcessIdentity } = await import('../infra/task/process.js');

    expect(getProcessIdentity(otherPid)).toEqual({ startTime: `ps-lstart-utc-v1:${psStartTime}` });
    expect(execFileSync).toHaveBeenCalledWith('ps', ['-o', 'lstart=', '-p', String(otherPid)], {
      ...inspectionOptions, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' },
    });
    expect(getSelfProcessIdentity()).toEqual({ startTime: `ps-lstart-utc-v1:${psStartTime}` });
    expect(getProcessIdentity(process.pid)).toEqual({ startTime: `ps-lstart-utc-v1:${psStartTime}` });
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it.each(['darwin', 'linux'] as const)('%s は呼び出し元の日時環境を上書きして同じ識別値を返す', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    vi.mocked(execFileSync).mockReturnValue('Sun Oct  4 10:28:57 2026');
    const { getProcessIdentity, sameProcessIdentity } = await import('../infra/task/process.js');
    vi.stubEnv('LC_ALL', 'ja_JP.UTF-8');
    vi.stubEnv('LC_TIME', 'ja_JP.UTF-8');
    vi.stubEnv('TZ', 'JST-9');
    const first = getProcessIdentity(otherPid);
    vi.stubEnv('LC_ALL', 'fr_FR.UTF-8');
    vi.stubEnv('LC_TIME', 'fr_FR.UTF-8');
    vi.stubEnv('TZ', 'PST8PDT');
    const second = getProcessIdentity(otherPid);

    expect(sameProcessIdentity(first, second)).toBe(true);
    expect(execFileSync).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(execFileSync).mock.calls) {
      expect(call[2]).toMatchObject({ env: { LC_ALL: 'C', TZ: 'UTC0' } });
    }
    expect(process.env.LC_ALL).toBe('fr_FR.UTF-8');
    expect(process.env.TZ).toBe('PST8PDT');
  });

  it('旧形式・未知の形式・識別不能は PID 再利用の根拠にしない', async () => {
    const { hasProcessIdentityMismatch } = await import('../infra/task/process.js');
    const current = { startTime: 'ps-lstart-utc-v1:Sun Oct  4 10:28:57 2026' };
    for (const recorded of [undefined, { startTime: '日 10/ 4 19:28:57 2026' },
      { startTime: 'ps-lstart-utc-v2:Sun Oct  4 10:28:57 2026' }]) {
      expect(hasProcessIdentityMismatch(recorded, current)).toBe(false);
      expect(hasProcessIdentityMismatch(current, recorded)).toBe(false);
    }
    expect(hasProcessIdentityMismatch(current, current)).toBe(false);
    expect(hasProcessIdentityMismatch({ startTime: 'ps-lstart-utc-v1:Sun Oct  4 10:28:58 2026' }, current)).toBe(true);
    expect(hasProcessIdentityMismatch({ startTime }, { startTime: '2026-10-03T14:23:41.1234567Z' })).toBe(true);
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
