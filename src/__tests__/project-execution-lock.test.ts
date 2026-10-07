import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  identity: vi.fn(), mkdir: vi.fn(), staging: vi.fn(), stat: vi.fn(), open: vi.fn(),
  write: vi.fn(), sync: vi.fn(), close: vi.fn(), rename: vi.fn(), list: vi.fn(),
  unlink: vi.fn(), rmdir: vi.fn(), read: vi.fn(), fileStat: vi.fn(),
  currentIdentity: vi.fn(), alive: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  mkdirSync: mocks.mkdir, mkdtempSync: mocks.staging, lstatSync: mocks.stat,
  openSync: mocks.open, writeFileSync: mocks.write, fsyncSync: mocks.sync,
  closeSync: mocks.close, renameSync: mocks.rename, readdirSync: mocks.list,
  unlinkSync: mocks.unlink, rmdirSync: mocks.rmdir,
  readFileSync: mocks.read, fstatSync: mocks.fileStat,
}));
vi.mock('../infra/task/process.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infra/task/process.js')>(),
  getSelfProcessIdentity: mocks.identity, getProcessIdentity: mocks.currentIdentity,
  isProcessAlive: mocks.alive,
}));
vi.mock('../infra/task/manager-run-state.js', () => ({
  withProjectRunCoordination: (_cwd: string, action: () => unknown) => action(),
  assertManagerReservationAllowsExecution: vi.fn(),
  adoptManagerReservation: vi.fn(),
}));
import { acquireProjectExecutionLock } from '../infra/task/project-execution-lock.js';

const projectDir = '/project';
const directory = join(projectDir, '.takt', 'execution.lock');
const staging = `${directory}.staging`;
const ownerId = '550e8400-e29b-41d4-a716-446655440000';
const ownerPath = join(directory, `owner-${ownerId}.json`);
const directoryStat = { dev: 1, ino: 2, isDirectory: () => true, isSymbolicLink: () => false };

describe('acquireProjectExecutionLock', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.identity.mockReturnValue({ startTime: '2026-10-03T14:23:40.1234567Z' });
    mocks.staging.mockReturnValue(staging);
    mocks.stat.mockReturnValue(directoryStat);
    mocks.list.mockReturnValue([]);
    mocks.open.mockReturnValue(42);
  });

  afterEach(() => vi.restoreAllMocks());

  it('開始時刻を取得できなければファイル操作を始めない', () => {
    mocks.identity.mockReturnValue(undefined);
    expect(() => acquireProjectExecutionLock('/project', 'run')).toThrow(/start time/);
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('記録の同期失敗では公開せず、一時記録とディレクトリを後片付けする', () => {
    const failure = new Error('fsync failed');
    mocks.sync.mockImplementation(() => { throw failure; });
    expect(() => acquireProjectExecutionLock('/project', 'watch')).toThrow(failure);
    expect(mocks.close).toHaveBeenCalledWith(42);
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.unlink).toHaveBeenCalledWith(expect.stringMatching(/execution\.lock\.staging[/\\]owner-.*\.json$/));
    expect(mocks.rmdir).toHaveBeenCalledWith(staging);
  });

  it('公開のI/Oエラーを競合として読み替えず、一時記録を解放する', () => {
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    mocks.rename.mockImplementation(() => { throw failure; });
    expect(() => acquireProjectExecutionLock('/project', 'run')).toThrow(failure);
    expect(mocks.sync).toHaveBeenCalledWith(42);
    expect(mocks.rename).toHaveBeenCalledTimes(1);
    expect(mocks.rmdir).toHaveBeenCalledWith(staging);
  });

  it.each(['darwin', 'linux'] as const)('%s の旧形式の生存所有者を引き継がない', (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    mocks.list.mockImplementation((path: string) => path === staging ? [] : [`owner-${ownerId}.json`]);
    mocks.fileStat.mockReturnValue({ isFile: () => true });
    mocks.read.mockReturnValue(JSON.stringify({ ownerId, pid: 4101, kind: 'run', state: 'running',
      processIdentity: { startTime: '日 10/ 4 19:28:57 2026' } }));
    mocks.alive.mockReturnValue(true);
    mocks.currentIdentity.mockReturnValue({ startTime: 'darwin-start-v1:1791244800:100000' });
    mocks.rename.mockImplementationOnce(() => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); });
    expect(() => acquireProjectExecutionLock(projectDir, 'watch')).toThrow(/run.*4101/);
    expect(mocks.unlink).not.toHaveBeenCalledWith(ownerPath);
    expect(mocks.rmdir).not.toHaveBeenCalledWith(directory);
  });

  it.each([
    { platform: 'linux', recorded: 'ps-lstart-utc-v1:garbage', current: 'linux-start-v2:550e8400-e29b-41d4-a716-446655440000:123450:650e8400-e29b-41d4-a716-446655440001' },
    { platform: 'darwin', recorded: 'ps-lstart-utc-v1:Sun Feb 29 10:28:57 2026', current: 'darwin-start-v1:1791244800:100000' },
    { platform: 'win32', recorded: '2026-02-29T14:23:40.1234567Z', current: '2026-10-03T14:23:40.1234567Z' },
    { platform: 'win32', recorded: '2026-04-31T14:23:40.1234567Z', current: '2026-10-03T14:23:40.1234567Z' },
  ] as const)('$platform の不正な開始時刻 $recorded では生存所有者を引き継がない', ({ platform, recorded, current }) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    mocks.list.mockImplementation((path: string) => path === staging ? [] : [`owner-${ownerId}.json`]);
    mocks.fileStat.mockReturnValue({ isFile: () => true });
    mocks.read.mockReturnValue(JSON.stringify({ ownerId, pid: 4101, kind: 'run', state: 'running',
      processIdentity: { startTime: recorded } }));
    mocks.alive.mockReturnValue(true);
    mocks.currentIdentity.mockReturnValue({ startTime: current });
    mocks.rename.mockImplementationOnce(() => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); });
    expect(() => acquireProjectExecutionLock(projectDir, 'watch')).toThrow(/run.*4101/);
    expect(mocks.unlink).not.toHaveBeenCalledWith(ownerPath);
    expect(mocks.rmdir).not.toHaveBeenCalledWith(directory);
    expect(mocks.rename).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ownerId: '../outside' }, { pid: 0 }, { kind: 'manager' }, { state: 'finished' },
    { processIdentity: { startTime: '' } }, { processIdentity: [] },
  ])('不正な必須所有者情報 %j は引き継がず維持する', (invalid) => {
    mocks.list.mockImplementation((directory: string) => directory.endsWith('.staging')
      ? [] : [`owner-${ownerId}.json`]);
    mocks.fileStat.mockReturnValue({ isFile: () => true });
    mocks.read.mockReturnValue(JSON.stringify({
      ownerId, pid: 4101, kind: 'watch', state: 'running',
      processIdentity: { startTime: 'start' }, ...invalid,
    }));
    mocks.rename.mockImplementation(() => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); });
    expect(() => acquireProjectExecutionLock('/project', 'run')).toThrow(/Invalid.*owner record/);
    expect(mocks.unlink).not.toHaveBeenCalledWith(ownerPath);
    expect(mocks.rename).toHaveBeenCalledTimes(1);
  });

  it.each(['matching', 'reused', 'unknown'] as const)('checks Linux ownership within the same tick before recovering a competing lock: %s', (identity) => {
    const owner = { ownerId, pid: 4101, kind: 'run', state: 'running', processIdentity: { startTime: 'linux-start-v2:550e8400-e29b-41d4-a716-446655440000:123450:650e8400-e29b-41d4-a716-446655440001' } };
    mocks.identity.mockReturnValue(owner.processIdentity);
    mocks.list.mockImplementation((path: string) => path === staging ? [] : [`owner-${ownerId}.json`]);
    mocks.fileStat.mockReturnValue({ isFile: () => true });
    mocks.read.mockReturnValue(JSON.stringify(owner));
    mocks.alive.mockReturnValue(true);
    mocks.currentIdentity.mockReturnValue(identity === 'unknown' ? undefined : { startTime: identity === 'reused' ? 'linux-start-v2:550e8400-e29b-41d4-a716-446655440000:123450:650e8400-e29b-41d4-a716-446655440002' : owner.processIdentity.startTime });
    mocks.rename.mockImplementationOnce(() => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); });
    if (identity === 'reused') {
      const lock = acquireProjectExecutionLock(projectDir, 'watch');
      expect(lock.owner.kind).toBe('watch');
      expect(mocks.unlink).toHaveBeenCalledWith(ownerPath);
    } else {
      expect(() => acquireProjectExecutionLock(projectDir, 'watch')).toThrow();
      expect(mocks.unlink).not.toHaveBeenCalledWith(ownerPath);
    }
  });

  it.each(['matching', 'reused', 'unknown'] as const)('checks the saved Linux identity before updating lock state: %s', (identity) => {
    mocks.identity.mockReturnValue({ startTime: 'linux-start-v2:550e8400-e29b-41d4-a716-446655440000:123450:650e8400-e29b-41d4-a716-446655440001' });
    const lock = acquireProjectExecutionLock(projectDir, 'run');
    const owner = lock.owner;
    mocks.list.mockReturnValue([`owner-${owner.ownerId}.json`]);
    mocks.fileStat.mockReturnValue({ isFile: () => true });
    mocks.read.mockReturnValue(JSON.stringify({ ...owner, processIdentity: { startTime: identity === 'unknown' ? 'ps-lstart-utc-v1:Tue Oct  6 00:00:00 2026'
      : identity === 'reused' ? 'linux-start-v2:550e8400-e29b-41d4-a716-446655440000:123450:650e8400-e29b-41d4-a716-446655440002' : owner.processIdentity.startTime } }));
    mocks.rename.mockClear();
    if (identity === 'matching') {
      lock.updateState('running');
      expect(lock.owner.state).toBe('running');
      expect(mocks.rename).toHaveBeenCalledTimes(1);
    } else {
      expect(() => lock.updateState('running')).toThrow();
      expect(mocks.rename).not.toHaveBeenCalled();
    }
  });

  describe('Windows のディレクトリ公開', () => {
    const owner = { ownerId, pid: 4101, kind: 'run', state: 'running',
      processIdentity: { startTime: '2026-10-03T14:23:40.1234567Z' } };
    const conflict = Object.assign(new Error('rename denied'), { code: 'EPERM' });

    beforeEach(() => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      mocks.list.mockImplementation((path: string) => path === staging ? [] : [`owner-${ownerId}.json`]);
      mocks.fileStat.mockReturnValue({ isFile: () => true });
      mocks.read.mockReturnValue(JSON.stringify(owner));
      mocks.alive.mockReturnValue(true);
      mocks.currentIdentity.mockReturnValue(owner.processIdentity);
      mocks.rename.mockImplementationOnce(() => { throw conflict; });
    });

    const kinds = ['run', 'watch'] as const;
    const states = ['starting', 'running', 'stopping'] as const;
    const conflicts = kinds.flatMap((ownerKind) => kinds.flatMap((nextKind) => states.map((state) => ({ ownerKind, nextKind, state }))));
    it.each(conflicts)('$ownerKind/$state の生存所有者を $nextKind が種別・PID付きで拒否する', ({ ownerKind, nextKind, state }) => {
      mocks.read.mockReturnValue(JSON.stringify({ ...owner, kind: ownerKind, state }));
      expect(() => acquireProjectExecutionLock(projectDir, nextKind)).toThrow(new RegExp(`${ownerKind}.*${owner.pid}`));
      expect(mocks.unlink).not.toHaveBeenCalledWith(ownerPath);
      expect(mocks.rmdir).not.toHaveBeenCalledWith(directory);
      expect(mocks.rename).toHaveBeenCalledTimes(1);
      expect(mocks.rmdir).toHaveBeenCalledWith(staging);
    });

    it.each(kinds)('死亡所有者を回復して %s の完成記録を公開する', (kind) => {
      mocks.alive.mockReturnValue(false);
      const lock = acquireProjectExecutionLock(projectDir, kind);
      expect(mocks.unlink).toHaveBeenCalledWith(ownerPath);
      expect(mocks.currentIdentity).not.toHaveBeenCalled();
      expect(lock.owner).toMatchObject({ pid: process.pid, kind, state: 'starting', processIdentity: { startTime: '2026-10-03T14:23:40.1234567Z' } });
      expect(lock.owner.ownerId).not.toBe(ownerId);
      expect(mocks.write).toHaveBeenCalledWith(42, `${JSON.stringify(lock.owner)}\n`, 'utf8');
      expect(mocks.rename).toHaveBeenCalledTimes(2);
      expect(mocks.rename).toHaveBeenLastCalledWith(staging, directory);
    });

    it.each(kinds)('開始時刻が不一致の生存PIDから %s が引き継ぐ', (kind) => {
      mocks.currentIdentity.mockReturnValue({ startTime: '2026-10-03T14:23:41.1234567Z' });
      const lock = acquireProjectExecutionLock(projectDir, kind);
      expect(mocks.currentIdentity).toHaveBeenCalledWith(owner.pid);
      expect(mocks.unlink).toHaveBeenCalledWith(ownerPath);
      expect(lock.owner.ownerId).not.toBe(ownerId);
      expect(lock.owner.kind).toBe(kind);
      expect(mocks.rename).toHaveBeenCalledTimes(2);
    });

    it('生存PIDの識別不能は回復の根拠にせず所有者を保持する', () => {
      mocks.currentIdentity.mockReturnValue(undefined);
      expect(() => acquireProjectExecutionLock(projectDir, 'watch')).toThrow(new RegExp(`run.*${owner.pid}`));
      expect(mocks.unlink).not.toHaveBeenCalledWith(ownerPath);
      expect(mocks.rmdir).not.toHaveBeenCalledWith(directory);
      expect(mocks.rename).toHaveBeenCalledTimes(1);
    });

    it('EPERMでも破損した所有者記録を死亡済みとして消さない', () => {
      mocks.read.mockReturnValue('{');
      expect(() => acquireProjectExecutionLock(projectDir, 'run')).toThrow(SyntaxError);
      expect(mocks.alive).not.toHaveBeenCalled();
      expect(mocks.unlink).not.toHaveBeenCalledWith(ownerPath);
      expect(mocks.rmdir).not.toHaveBeenCalledWith(directory);
      expect(mocks.rename).toHaveBeenCalledTimes(1);
    });

    it('WindowsでもEACCESをディレクトリ衝突へ読み替えない', () => {
      const denied = Object.assign(new Error('rename denied'), { code: 'EACCES' });
      mocks.rename.mockReset().mockImplementation(() => { throw denied; });
      expect(() => acquireProjectExecutionLock(projectDir, 'run')).toThrow(denied);
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.unlink).not.toHaveBeenCalledWith(ownerPath);
      expect(mocks.rename).toHaveBeenCalledTimes(1);
    });

    it.each([
      { target: '不存在', stat: undefined },
      { target: '通常ファイル', stat: { isDirectory: () => false, isSymbolicLink: () => false } },
      { target: 'シンボリックリンク', stat: { isDirectory: () => false, isSymbolicLink: () => true } },
    ])('宛先が $target ならEPERMを競合と扱わず伝播する', ({ stat }) => {
      mocks.stat.mockImplementation((path: string) => path === directory ? stat : directoryStat);
      expect(() => acquireProjectExecutionLock(projectDir, 'run')).toThrow(conflict);
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.unlink).not.toHaveBeenCalledWith(ownerPath);
      expect(mocks.rename).toHaveBeenCalledTimes(1);
      expect(mocks.rmdir).toHaveBeenCalledWith(staging);
    });

    it('宛先を調べる権限がなければ読取エラーを伝播して既存所有者を保持する', () => {
      const denied = Object.assign(new Error('stat denied'), { code: 'EACCES' });
      mocks.stat.mockImplementation((path: string) => {
        if (path === directory) throw denied;
        return { dev: 1, ino: 2, isDirectory: () => true, isSymbolicLink: () => false };
      });
      expect(() => acquireProjectExecutionLock(projectDir, 'run')).toThrow(denied);
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.unlink).not.toHaveBeenCalledWith(ownerPath);
      expect(mocks.rename).toHaveBeenCalledTimes(1);
    });

    it.each(['darwin', 'linux'] as const)('%s のEPERMは既存ディレクトリがあっても伝播する', (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
      expect(() => acquireProjectExecutionLock(projectDir, 'run')).toThrow(conflict);
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.unlink).not.toHaveBeenCalledWith(ownerPath);
      expect(mocks.rename).toHaveBeenCalledTimes(1);
    });
  });
});
