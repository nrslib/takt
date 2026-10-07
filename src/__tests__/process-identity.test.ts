import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync, type BigIntStats, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: vi.fn(),
}));
vi.mock('node:crypto', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:crypto')>(), randomUUID: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  realpathSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(), readlinkSync: vi.fn(), openSync: vi.fn(), closeSync: vi.fn(),
  fstatSync: vi.fn(), readSync: vi.fn(), writeFileSync: vi.fn(), unlinkSync: vi.fn(),
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
  vi.mocked(readFileSync).mockReset();
  vi.mocked(randomUUID).mockReset().mockReturnValue('650e8400-e29b-41d4-a716-446655440001');
  for (const fn of [readdirSync, readlinkSync, openSync, closeSync, fstatSync, readSync, writeFileSync, unlinkSync]) vi.mocked(fn).mockReset();
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

describe('Unix のプロセス識別', () => {
  const seconds = 1791244800n;
  const boot = '550e8400-e29b-41d4-a716-446655440000';
  const darwinTime = 'darwin-start-v1:1791244800:100000';
  const nonce = '650e8400-e29b-41d4-a716-446655440001';
  const nextNonce = '650e8400-e29b-41d4-a716-446655440002';
  const linuxTime = `linux-start-v2:${boot}:123450:${nonce}`;
  const evidenceStat = { dev: 1n, ino: 2n, nlink: 0n, size: 36n, isFile: () => true } as BigIntStats;
  function evidence(value: string) {
    vi.mocked(readdirSync).mockReturnValue(['18'] as never);
    vi.mocked(readlinkSync).mockImplementation((path) => `/tmp/takt-process-identity-${String(path).split('/')[2]}-${value} (deleted)`);
    vi.mocked(openSync).mockReturnValue(99);
    vi.mocked(fstatSync).mockReturnValue(evidenceStat);
    vi.mocked(statSync).mockReturnValue(evidenceStat);
    vi.mocked(readSync).mockImplementation((_fd, buffer) => { Buffer.from(value).copy(buffer as Buffer); return 36; });
  }
  function darwinTable(pid = otherPid, usec = 100000): Buffer<ArrayBuffer> {
    const record = Buffer.alloc(648);
    record.writeBigInt64LE(seconds, 0);
    record.writeInt32LE(usec, 8);
    record.writeInt32LE(pid, 40);
    return record;
  }
  function linuxStat(pid = otherPid, ticks = '123450'): string {
    return `${pid} (name with ) parentheses) S ${Array(18).fill('0').join(' ')} ${ticks} 0 0\n`;
  }
  function select(platform: 'darwin' | 'linux') {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64');
    vi.mocked(execFileSync).mockImplementation(() => darwinTable());
    vi.mocked(readFileSync).mockImplementation((path) => String(path).endsWith('boot_id') ? boot : linuxStat(Number(String(path).split('/')[2])));
    if (platform === 'linux') evidence(nonce);
  }

  it.each(['darwin', 'linux'] as const)('%s は同じPIDの別プロセスを保存・復元して区別する', async (platform) => {
    select(platform);
    if (platform === 'darwin') vi.mocked(execFileSync).mockReturnValueOnce(darwinTable()).mockReturnValueOnce(darwinTable(otherPid, 200000));
    const { getProcessIdentity, sameProcessIdentity, hasProcessIdentityMismatch } = await import('../infra/task/process.js');
    const first = getProcessIdentity(otherPid);
    const restored = JSON.parse(JSON.stringify(first));
    if (platform === 'linux') evidence(nextNonce);
    const second = getProcessIdentity(otherPid);
    expect(first).toEqual({ startTime: platform === 'darwin' ? darwinTime : linuxTime });
    expect(sameProcessIdentity(first, restored)).toBe(true);
    expect(hasProcessIdentityMismatch(first, restored)).toBe(false);
    expect(sameProcessIdentity(first, second)).toBe(false);
    expect(hasProcessIdentityMismatch(first, second)).toBe(true);
  });

  it.each(['absent', 'closed', 'content', 'replaced', 'size', 'linked', 'duplicate'] as const)('Linux の追加証拠が検証不能なら一致も不一致も証明しない: %s', async (change) => {
    select('linux');
    const { getProcessIdentity, sameProcessIdentity, hasProcessIdentityMismatch } = await import('../infra/task/process.js');
    const saved = JSON.parse(JSON.stringify(getProcessIdentity(otherPid)));
    if (change === 'absent') vi.mocked(readdirSync).mockReturnValue([]);
    if (change === 'closed') vi.mocked(openSync).mockImplementation(() => { throw Object.assign(new Error('closed'), { code: 'ENOENT' }); });
    if (change === 'content') vi.mocked(readSync).mockImplementation((_fd, buffer) => { Buffer.from(nextNonce).copy(buffer as Buffer); return 36; });
    if (change === 'replaced') vi.mocked(statSync).mockReturnValue({ ...evidenceStat, ino: 3n } as BigIntStats);
    if (change === 'size') vi.mocked(fstatSync).mockReturnValue({ ...evidenceStat, size: 37n } as BigIntStats);
    if (change === 'linked') vi.mocked(fstatSync).mockReturnValue({ ...evidenceStat, nlink: 1n } as BigIntStats);
    if (change === 'duplicate') {
      vi.mocked(readdirSync).mockReturnValue(['18', '19'] as never);
      vi.mocked(readlinkSync).mockImplementation((path) => `/tmp/takt-process-identity-${otherPid}-${String(path).endsWith('18') ? nonce : nextNonce} (deleted)`);
      vi.mocked(openSync).mockImplementation((path) => String(path).endsWith('18') ? 98 : 99);
      vi.mocked(readSync).mockImplementation((fd, buffer) => { Buffer.from(fd === 98 ? nonce : nextNonce).copy(buffer as Buffer); return 36; });
    }
    const current = getProcessIdentity(otherPid);
    expect(current).toBeUndefined();
    expect(sameProcessIdentity(saved, current)).toBe(false);
    expect(hasProcessIdentityMismatch(saved, current)).toBe(false);
  });

  it('Linux の自己証拠を一度だけ作り、公開前にFDから検証する', async () => {
    select('linux');
    vi.mocked(readdirSync).mockReturnValueOnce([]);
    vi.mocked(openSync).mockReturnValueOnce(88);
    const { getSelfProcessIdentity, sameProcessIdentity } = await import('../infra/task/process.js');
    const first = getSelfProcessIdentity();
    expect(first).toEqual({ startTime: linuxTime });
    expect(sameProcessIdentity(first, getSelfProcessIdentity())).toBe(true);
    expect(writeFileSync).toHaveBeenCalledOnce();
    expect(unlinkSync).toHaveBeenCalledOnce();
    expect(openSync).toHaveBeenCalledWith(expect.any(String), 'wx+', 0o600);
    expect(writeFileSync).toHaveBeenCalledWith(88, nonce);
    expect(closeSync).not.toHaveBeenCalledWith(88);
    expect(closeSync).toHaveBeenCalledWith(99);
  });

  it('Linux の証拠の準備が失敗したらFDを閉じ、識別値を返さない', async () => {
    select('linux');
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(openSync).mockReturnValue(88);
    vi.mocked(unlinkSync).mockImplementation(() => { throw new Error('unlink failed'); });
    const { getSelfProcessIdentity } = await import('../infra/task/process.js');
    expect(getSelfProcessIdentity()).toBeUndefined();
    expect(closeSync).toHaveBeenCalledWith(88);
  });

  it('Linux は親から継承した証拠を子自身の証拠として使わない', async () => {
    select('linux');
    vi.mocked(readlinkSync).mockReturnValue(`/tmp/takt-process-identity-${otherPid + 1}-${nonce} (deleted)`);
    const { getProcessIdentity } = await import('../infra/task/process.js');
    expect(getProcessIdentity(otherPid)).toBeUndefined();
    expect(openSync).not.toHaveBeenCalled();
  });

  it('Linux の自己識別がキャッシュ済みでもFDの寿命が終われば未知にする', async () => {
    select('linux');
    const { getSelfProcessIdentity } = await import('../infra/task/process.js');
    expect(getSelfProcessIdentity()).toEqual({ startTime: linuxTime });
    vi.mocked(readdirSync).mockReturnValue([]);
    expect(getSelfProcessIdentity()).toBeUndefined();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'linux'] as const)('%s は反復照会と自己照会で同じ値を保持する', async (platform) => {
    select(platform);
    if (platform === 'darwin') vi.mocked(execFileSync).mockImplementation(() => Buffer.concat([darwinTable(), darwinTable(process.pid)]));
    const { getProcessIdentity, getSelfProcessIdentity, sameProcessIdentity } = await import('../infra/task/process.js');
    const first = getProcessIdentity(otherPid);
    expect(sameProcessIdentity(first, getProcessIdentity(otherPid))).toBe(true);
    expect(sameProcessIdentity(getSelfProcessIdentity(), getProcessIdentity(process.pid))).toBe(true);
    const calls = platform === 'darwin' ? execFileSync : readFileSync;
    const count = vi.mocked(calls).mock.calls.length;
    getSelfProcessIdentity();
    expect(vi.mocked(calls).mock.calls.length).toBe(count);
    if (platform === 'darwin') expect(execFileSync).toHaveBeenCalledWith('/usr/sbin/sysctl', ['-b', 'kern.proc'], {
      shell: false, timeout: 1000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    else {
      expect(readFileSync).toHaveBeenCalledWith('/proc/sys/kernel/random/boot_id', 'utf8');
      expect(readFileSync).toHaveBeenCalledWith(`/proc/${otherPid}/stat`, 'utf8');
    }
  });

  it.each(['darwin', 'linux'] as const)('%s の識別は呼出元の日時環境に依存しない', async (platform) => {
    select(platform);
    const { getProcessIdentity, sameProcessIdentity } = await import('../infra/task/process.js');
    vi.stubEnv('LC_ALL', 'ja_JP.UTF-8'); vi.stubEnv('TZ', 'JST-9');
    const first = getProcessIdentity(otherPid);
    vi.stubEnv('LC_ALL', 'fr_FR.UTF-8'); vi.stubEnv('TZ', 'PST8PDT');
    expect(sameProcessIdentity(first, getProcessIdentity(otherPid))).toBe(true);
  });

  it.each(['empty', 'length', 'pid', 'duplicate', 'seconds', 'microseconds', 'overflow'] as const)('Darwin の不正な取得値を未知にする: %s', async (change) => {
    select('darwin');
    let record = darwinTable();
    if (change === 'empty') record = Buffer.alloc(0);
    if (change === 'length') record = record.subarray(0, 647);
    if (change === 'pid') record.writeInt32LE(otherPid + 1, 40);
    if (change === 'duplicate') record = Buffer.concat([record, record]);
    if (change === 'seconds') record.writeBigInt64LE(-1n, 0);
    if (change === 'overflow') record.writeBigInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 0);
    if (change === 'microseconds') record.writeInt32LE(1000000, 8);
    vi.mocked(execFileSync).mockReturnValue(record);
    const { getProcessIdentity } = await import('../infra/task/process.js');
    expect(getProcessIdentity(otherPid)).toBeUndefined();
  });
  it('Darwin の未確認 ABI は取得しない', async () => {
    select('darwin'); vi.spyOn(process, 'arch', 'get').mockReturnValue('ia32');
    const { getProcessIdentity } = await import('../infra/task/process.js');
    expect(getProcessIdentity(otherPid)).toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it.each(['boot', 'pid', 'truncated', 'negative', 'overflow'] as const)('Linux の不正な取得値を未知にする: %s', async (change) => {
    select('linux');
    vi.mocked(readFileSync).mockImplementation((path) => String(path).endsWith('boot_id')
      ? change === 'boot' ? 'unknown' : boot
      : change === 'pid' ? linuxStat(otherPid + 1)
        : change === 'truncated' ? `${otherPid} (name) S 0`
          : linuxStat(otherPid, change === 'negative' ? '-1' : change === 'overflow' ? '18446744073709551616' : '123450'));
    const { getProcessIdentity } = await import('../infra/task/process.js');
    expect(getProcessIdentity(otherPid)).toBeUndefined();
  });
  it('Linux は再起動前後の同じ開始tickを同一プロセスと扱わない', async () => {
    select('linux');
    const { getProcessIdentity, sameProcessIdentity, hasProcessIdentityMismatch } = await import('../infra/task/process.js');
    const first = getProcessIdentity(otherPid);
    vi.mocked(readFileSync).mockImplementation((path) => String(path).endsWith('boot_id') ? boot.replace('0000', '0001') : linuxStat());
    const second = getProcessIdentity(otherPid);
    expect(sameProcessIdentity(first, second)).toBe(false);
    expect(hasProcessIdentityMismatch(first, second)).toBe(true);
  });

  it.each([
    'ps-lstart-utc-v1:Sun Oct  4 10:28:57 2026', '日 10/ 4 19:28:57 2026', 'unknown',
    'darwin-start-v1:1791244800:1000000', 'darwin-start-v1:1791244800:-1',
    'darwin-start-v1:0:100000', 'darwin-start-v1:1791244800:010000',
    'darwin-start-v1:1791244800:100000\n', `linux-start-v1:${boot}:123450`,
    `${linuxTime}\n`, `linux-start-v2:${boot}:18446744073709551616:${nonce}`,
    '2026-02-29T14:23:40.1234567Z', `${startTime}\n`,
  ])('旧形式・不正値 %j は一致も不一致も証明しない', async (invalid) => {
    const { sameProcessIdentity, hasProcessIdentityMismatch } = await import('../infra/task/process.js');
    expect(sameProcessIdentity({ startTime: invalid }, { startTime: invalid })).toBe(false);
    for (const valid of [darwinTime, linuxTime, startTime]) {
      expect(hasProcessIdentityMismatch({ startTime: invalid }, { startTime: valid })).toBe(false);
      expect(hasProcessIdentityMismatch({ startTime: valid }, { startTime: invalid })).toBe(false);
    }
  });
  it('異なる OS 形式は比較可能な不一致として扱わない', async () => {
    const { hasProcessIdentityMismatch } = await import('../infra/task/process.js');
    expect(hasProcessIdentityMismatch({ startTime: darwinTime }, { startTime: linuxTime })).toBe(false);
  });
  it.each(['darwin', 'linux'] as const)('%s の取得失敗は未知にする', async (platform) => {
    select(platform);
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('unavailable'); });
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('unavailable'); });
    const { getProcessIdentity } = await import('../infra/task/process.js');
    expect(getProcessIdentity(otherPid)).toBeUndefined();
  });
  it('未対応 OS は外部照会せず未知にする', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('freebsd');
    const { getProcessIdentity } = await import('../infra/task/process.js');
    expect(getProcessIdentity(otherPid)).toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
  });
});
