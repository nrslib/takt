import { EventEmitter } from 'node:events';
import type { Dirent } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Admission, EventInput, WatchObservation } from '../core/daemon/events.js';
import type { CommandPort, CommandResult, ProcessObservation } from '../core/daemon/io.js';
import { parseDaemonProcessMessage } from '../core/daemon/processProtocol.js';
import { WatchChecks, type InquiryWatchTarget, type LaunchWatchTarget, type LogStamp, type RunWatchTarget } from '../features/daemon/watchers/checks.js';
import { startDirectoryWatcher, type DirectoryWatchTarget, type WatchFileChange } from '../features/daemon/watchers/directories.js';
import { startDaemonWatchers, type DaemonWatchSource } from '../features/daemon/watchers/index.js';
import { startWatchLoop, WATCH_INTERVALS, WATCH_THRESHOLDS } from '../features/daemon/watchers/loop.js';
import { WatchObservations, type WatchRecord, type WatchRecordStore, type WatchTarget } from '../features/daemon/watchers/observations.js';
import { observePullRequest, type PullRequestWatchTarget } from '../features/daemon/watchers/pullRequests.js';

const filesystem = vi.hoisted(() => ({ watch: vi.fn(), stat: vi.fn(), list: vi.fn(), json: vi.fn() }));
vi.mock('node:fs', () => ({ watch: filesystem.watch }));
vi.mock('node:fs/promises', () => ({ stat: filesystem.stat }));
vi.mock('../features/daemon/watchers/files.js', () => ({
  MAX_WATCH_ENTRIES: 128,
  isMissing: (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT',
  listWatchEntries: filesystem.list, readSmallJson: filesystem.json,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function harness() {
  // JSON 往復で、B の保存境界と同様にオブジェクト共有を避ける。
  const saved = new Map<string, WatchRecord>();
  const records: WatchRecordStore = {
    async read(key) { const value = saved.get(key); return value === undefined ? undefined : structuredClone(value); },
    async write(key, record) { saved.set(key, structuredClone(record)); },
  };
  const accepted = new Map<string, EventInput>();
  const accept = vi.fn(async (input: EventInput): Promise<Admission> => {
    parseDaemonProcessMessage({ kind: 'start_turn', protocolVersion: 1, launchId: 'launch-1', input: {
      event: { ...input, operationId: input.eventId, acceptedSequence: 1, lane: 'other' },
      turn: { conversationId: input.conversationId, operationId: input.eventId, generation: 1 },
      state: { version: 0, assignment: { kind: 'repository', repositoryDirectory: '/repo' },
        session: { provider: 'mock', model: null, sessionId: null }, revision: 0, pending: null, approval: null },
    } }, 'launch-1');
    const previous = accepted.get(input.eventId);
    if (previous !== undefined) expect(input).toEqual(previous);
    else accepted.set(input.eventId, structuredClone(input));
    return { kind: 'accepted', eventId: input.eventId, operationId: input.eventId, acceptedSequence: accepted.size };
  });
  const observations = new WatchObservations(records, { accept }, Date.now);
  const onError = vi.fn();
  const checks = new WatchChecks(observations, Date.now, onError, 'process');
  return { records, accepted, accept, observations, checks, onError };
}

const base: WatchTarget = { targetId: 'run-1', generation: 'execution-1', conversationId: 'manager-1' };
const run: RunWatchTarget = { ...base,
  task: { repositoryDirectory: '/repo', goalId: 'goal-1', taskName: 'task-1', runSlug: 'run-1', executionId: 'execution-1' },
  owner: { pid: 123, startTime: 'start-1' }, running: true, paused: false, awaitingAnswer: false, logPath: '/log', metaPath: null,
  startedAt: '2026-11-01T00:00:00.000Z',
};
const inquiry: InquiryWatchTarget = { ...base, repositoryDirectory: '/repo', questionId: 'question-1', goalId: 'goal-1',
  pending: true, createdAt: '2026-11-01T00:00:00.000Z' };
const launch: LaunchWatchTarget = { ...base, repositoryDirectory: '/repo', autoRun: true, runnablePending: true,
  owner: 'absent', launching: false, pendingSince: '2026-11-01T00:00:00.000Z' };
const pr: PullRequestWatchTarget = { ...base, repositoryDirectory: '/repo', goalId: 'goal-1', awaitingMerge: true,
  number: 9, url: 'https://github.com/owner/repo/pull/9', headBranch: 'goal', baseBranch: 'main' };
const options = () => ({ signal: new AbortController().signal, timeoutMs: 5_000 });
const observedKinds = (accepted: Map<string, EventInput>) => [...accepted.values()].map((input) => {
  if (input.event.kind !== 'watch_observation') throw new Error('Unexpected turn event');
  return input.event.observation.kind;
});

it('emits process loss with a PID and unknown start time only when the PID is missing', async () => {
  const h = harness();
  const target = { ...run, owner: { pid: 123, startTime: null } };
  const inspect = vi.fn(async () => ({ kind: 'unknown' as const, reason: 'Process start time unavailable' }));
  await expect(h.checks.process(target, { inspect }, options(), async () => target)).rejects.toThrow('unknown');
  expect(h.accept).not.toHaveBeenCalled();
  await h.checks.process(target, { inspect: async () => ({ kind: 'dead' }) }, options(), async () => target);
  expect([...h.accepted.values()]).toMatchObject([{ event: { observation: { kind: 'run_process_lost', pid: 123, startTime: null } } }]);
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T00:00:00.000Z'));
  filesystem.watch.mockReset().mockImplementation(() => Object.assign(new EventEmitter(), { close: vi.fn() }));
  filesystem.stat.mockReset().mockResolvedValue({ dev: 1, ino: 1, isDirectory: () => true });
  filesystem.list.mockReset().mockResolvedValue([]);
  filesystem.json.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('永続的な発行記録', () => {
  const observation = (): WatchObservation => ({ targetId: base.targetId, generation: base.generation,
    observedAt: new Date().toISOString(), kind: 'run_launch_stalled', repositoryDirectory: '/repo' });

  it('同じ異常を再通知せず、再起動後も抑え、正常復帰後の再発は新たなIDにする', async () => {
    const h = harness();
    await h.observations.abnormal(base, observation());
    await h.observations.abnormal(base, observation());
    const restarted = new WatchObservations(h.records, { accept: h.accept }, Date.now);
    await restarted.abnormal(base, observation());
    expect(h.accept).toHaveBeenCalledTimes(1);
    await restarted.normal(base, 'run_launch_stalled');
    await restarted.abnormal(base, observation());
    expect(h.accepted.size).toBe(2);
    expect(new Set([...h.accepted.values()].map((input) => input.requestId)).size).toBe(2);
  });

  it('受付拒否の後も保存済みの入力をそのまま再送する', async () => {
    const h = harness();
    h.accept.mockResolvedValueOnce({ kind: 'rejected', reason: 'capacity' });
    await expect(h.observations.abnormal(base, observation())).rejects.toThrow();
    vi.setSystemTime(Date.now() + 5_000);
    const restarted = new WatchObservations(h.records, { accept: h.accept }, Date.now);
    await restarted.abnormal(base, observation());
    expect(h.accept.mock.calls[1]?.[0]).toEqual(h.accept.mock.calls[0]?.[0]);
    expect(h.accepted.size).toBe(1);
  });

  it('受付後の保存失敗では再起動してもイベントを増やさない', async () => {
    const h = harness();
    const write = h.records.write.bind(h.records);
    const records = { ...h.records, write: vi.fn(write).mockImplementationOnce(write).mockRejectedValueOnce(new Error('disk')) };
    const first = new WatchObservations(records, { accept: h.accept }, Date.now);
    await expect(first.abnormal(base, observation())).rejects.toThrow();
    vi.setSystemTime(Date.now() + 5_000);
    const restarted = new WatchObservations(h.records, { accept: h.accept }, Date.now);
    await restarted.abnormal(base, observation());
    expect(h.accept).toHaveBeenCalledTimes(2);
    expect(h.accepted.size).toBe(1);
  });

  it('受付前の保存に失敗した場合はイベントを送らない', async () => {
    const h = harness();
    const observations = new WatchObservations({ ...h.records, write: vi.fn().mockRejectedValue(new Error('disk')) }, { accept: h.accept }, Date.now);
    await expect(observations.abnormal(base, observation())).rejects.toThrow();
    expect(h.accept).not.toHaveBeenCalled();
  });

  it('対象・世代・種類ごとに独立して重複を抑える', async () => {
    const h = harness();
    for (const target of [base, { ...base, generation: 'execution-2' }, { ...base, targetId: 'run-2' }]) {
      await h.observations.abnormal(target, { ...observation(), targetId: target.targetId, generation: target.generation });
    }
    await h.observations.abnormal(base, { ...h.observations.evidence(base), kind: 'watch_failed', reason: 'failed' });
    expect(h.accepted.size).toBe(4);
  });
});

describe('run の生死', () => {
  it.each<ProcessObservation>([
    { kind: 'dead' }, { kind: 'alive', owner: { pid: 123, startTime: 'reused' } },
    { kind: 'alive', owner: { pid: 456, startTime: 'start-1' } },
  ])('死亡・PID再利用の証拠だけを発行する: %j', async (value) => {
    const h = harness();
    const inspect = vi.fn().mockResolvedValue(value);
    await h.checks.process(run, { inspect }, options(), async () => run);
    expect(inspect).toHaveBeenCalledWith(run.owner, expect.objectContaining({ timeoutMs: 5_000, signal: expect.any(AbortSignal) }));
    expect(observedKinds(h.accepted)).toEqual(['run_process_lost']);
  });

  it('照会失敗・unknown を死亡や正常復帰として扱わない', async () => {
    const h = harness();
    await h.checks.process(run, { inspect: vi.fn().mockResolvedValue({ kind: 'dead' }) }, options(), async () => run);
    await expect(h.checks.process(run, { inspect: vi.fn().mockResolvedValue({ kind: 'unknown', reason: 'denied' }) }, options(), async () => run)).rejects.toThrow();
    await expect(h.checks.process(run, { inspect: vi.fn().mockRejectedValue(new Error('ps')) }, options(), async () => run)).rejects.toThrow();
    await h.checks.process(run, { inspect: vi.fn().mockResolvedValue({ kind: 'dead' }) }, options(), async () => run);
    expect(h.accepted.size).toBe(1);
  });

  it.each([undefined, { ...run, running: false }, { ...run, generation: 'new' }, { ...run, owner: { pid: 999, startTime: 'new' } }])(
    '照会中に完了・世代変更した実行には発行しない: %j', async (current) => {
      const h = harness();
      await h.checks.process(run, { inspect: vi.fn().mockResolvedValue({ kind: 'dead' }) }, options(), async () => current);
      expect(h.accept).not.toHaveBeenCalled();
    });

  it('正常復帰後の再死亡を一度ずつ通知する', async () => {
    const h = harness();
    const inspect = vi.fn();
    for (const value of [{ kind: 'dead' }, { kind: 'alive', owner: run.owner }, { kind: 'dead' }]) {
      inspect.mockResolvedValueOnce(value);
      await h.checks.process(run, { inspect }, options(), async () => run);
    }
    expect(observedKinds(h.accepted)).toEqual(['run_process_lost', 'run_process_lost']);
  });

  it('照会中の取消しでは死亡イベントを発行しない', async () => {
    const h = harness();
    const controller = new AbortController();
    const inspect = vi.fn(async () => { controller.abort(); return { kind: 'dead' as const }; });
    await expect(h.checks.process(run, { inspect }, { signal: controller.signal, timeoutMs: 5_000 }, async () => run)).rejects.toThrow();
    expect(h.accept).not.toHaveBeenCalled();
  });
});

describe('ログ停止', () => {
  const stamp = (): LogStamp => ({ identity: 'dev:ino', size: 5, mtimeMs: Date.parse('2026-11-01T00:00:00Z'), ctimeMs: Date.parse('2026-11-01T00:00:00Z') });

  it.each([null, 'invalid'])('ログ未作成で開始時刻が不明なら読み取りも通知も行わず、監視失敗に数えない: %s', async (startedAt) => {
    const h = harness();
    const target = { ...run, logPath: null, startedAt };
    const read = vi.fn();
    const reread = vi.fn();
    vi.setSystemTime(Date.now() + WATCH_THRESHOLDS.log);
    for (let index = 0; index < 4; index++) {
      await expect(h.checks.log(target, read, reread)).resolves.toBeUndefined();
      await h.checks.check(target, () => h.checks.log(target, read, reread));
    }
    expect(read).not.toHaveBeenCalled();
    expect(reread).not.toHaveBeenCalled();
    expect(h.accept).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('ログ未作成なら開始時刻からの閾値で通知し、作成後はログの更新時刻で判定する', async () => {
    const h = harness();
    const target = { ...run, logPath: null };
    const read = vi.fn();
    vi.setSystemTime(Date.now() + WATCH_THRESHOLDS.log - 1);
    for (let index = 0; index < 4; index++) {
      await h.checks.check(target, () => h.checks.log(target, read, async () => target));
    }
    expect(h.accept).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 2);
    await h.checks.log(target, read, async () => target);
    expect(read).not.toHaveBeenCalled();
    expect([...h.accepted.values()]).toMatchObject([{ event: { observation: {
      kind: 'run_log_stalled', lastUpdatedAt: run.startedAt,
    } } }]);
    const created = { ...stamp(), mtimeMs: Date.now(), ctimeMs: Date.now() };
    await h.checks.log(run, async () => created, async () => run);
    vi.setSystemTime(Date.now() + WATCH_THRESHOLDS.log - 1);
    await h.checks.log(run, async () => created, async () => run);
    expect(h.accepted.size).toBe(1);
    vi.setSystemTime(Date.now() + 2);
    await h.checks.log(run, async () => created, async () => run);
    expect(observedKinds(h.accepted)).toEqual(['run_log_stalled', 'run_log_stalled']);
    expect([...h.accepted.values()][1]).toMatchObject({ event: { observation: {
      lastUpdatedAt: new Date(created.mtimeMs).toISOString(),
    } } });
  });

  it('組立済みの見張りもログ未作成の停止を検出し、作成後は通常の監視に戻る', async () => {
    const h = harness();
    const target = { ...run, logPath: null };
    const source: DaemonWatchSource = { readRunProgress: vi.fn(), runs: vi.fn().mockResolvedValue([target]), run: vi.fn().mockResolvedValue(target),
      pullRequests: vi.fn().mockResolvedValue([]), inquiries: vi.fn().mockResolvedValue([]), goals: vi.fn().mockResolvedValue([]),
      launches: vi.fn().mockResolvedValue([]), directories: vi.fn().mockResolvedValue([]) };
    const errors = vi.fn();
    const watchers = startDaemonWatchers({ source, processes: { inspect: vi.fn().mockResolvedValue({ kind: 'alive', owner: run.owner }) },
      commands: { run: vi.fn() }, records: h.records, ingress: { accept: h.accept }, filesChanged: vi.fn(), now: Date.now, onError: errors });
    try {
      await watchers.drain();
      await vi.advanceTimersByTimeAsync(WATCH_INTERVALS.log * 4);
      expect(filesystem.stat).not.toHaveBeenCalled();
      expect(h.accept).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(WATCH_THRESHOLDS.log - WATCH_INTERVALS.log * 4);
      expect(observedKinds(h.accepted)).toEqual(['run_log_stalled']);
      vi.mocked(source.runs).mockResolvedValue([run]);
      vi.mocked(source.run).mockResolvedValue(run);
      filesystem.stat.mockResolvedValue({ dev: 1, ino: 1, ...stamp(), mtimeMs: Date.now(), ctimeMs: Date.now(), isFile: () => true });
      watchers.changed();
      await watchers.drain();
      expect(filesystem.stat).toHaveBeenCalledWith(run.logPath);
      expect(h.accepted.size).toBe(1);
      await vi.advanceTimersByTimeAsync(WATCH_THRESHOLDS.log);
      expect(observedKinds(h.accepted)).toEqual(['run_log_stalled', 'run_log_stalled']);
      expect(errors).not.toHaveBeenCalled();
    } finally { await watchers.close(); }
  });

  it('30分の直前・到達後・更新復帰・再停止と再起動の抑制を確認する', async () => {
    const h = harness();
    const current = stamp();
    vi.setSystemTime(current.mtimeMs + WATCH_THRESHOLDS.log - 1);
    await h.checks.log(run, async () => current, async () => run);
    expect(h.accept).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1);
    await h.checks.log(run, async () => current, async () => run);
    const restarted = new WatchChecks(new WatchObservations(h.records, { accept: h.accept }, Date.now), Date.now, h.onError, 'log');
    await restarted.log(run, async () => current, async () => run);
    expect(h.accepted.size).toBe(1);
    const changed = { ...current, size: 6, mtimeMs: Date.now() };
    await restarted.log(run, async () => changed, async () => run);
    vi.setSystemTime(Date.now() + WATCH_THRESHOLDS.log);
    await restarted.log(run, async () => changed, async () => run);
    expect(observedKinds(h.accepted)).toEqual(['run_log_stalled', 'run_log_stalled']);
  });

  it.each([{ paused: true }, { awaitingAnswer: true }, { running: false }])('待機・停止・終端を異常にしない: %j', async (patch) => {
    const h = harness();
    vi.setSystemTime(Date.now() + WATCH_THRESHOLDS.log);
    const read = vi.fn();
    await h.checks.log({ ...run, ...patch }, read, async () => run);
    expect(read).not.toHaveBeenCalled();
    expect(h.accept).not.toHaveBeenCalled();
  });

  it.each([{ identity: 'replacement' }, { size: 6 }, { mtimeMs: 1 }, { ctimeMs: 1 }])('identity・size・mtime・ctime変化を更新として観測する: %j', async (patch) => {
    const h = harness();
    const initial = stamp();
    await h.checks.log(run, async () => initial, async () => run);
    vi.setSystemTime(Date.now() + WATCH_THRESHOLDS.log);
    await h.checks.log(run, async () => ({ ...initial, ...patch }), async () => run);
    expect(h.accept).not.toHaveBeenCalled();
  });
});

describe('期限と監視障害', () => {
  it('未回答24時間の直前と到達後を確認し、回答後には発行しない', async () => {
    const h = harness();
    vi.setSystemTime(Date.now() + WATCH_THRESHOLDS.inquiry - 1);
    await h.checks.inquiry(inquiry);
    expect(h.accept).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1);
    await h.checks.inquiry(inquiry);
    await h.checks.inquiry({ ...inquiry, pending: false });
    expect(observedKinds(h.accepted)).toEqual(['inquiry_stalled']);
  });

  it('日時欠落を期限超過にしない', async () => {
    const h = harness();
    await expect(h.checks.inquiry({ ...inquiry, createdAt: null })).rejects.toThrow();
    await expect(h.checks.launch({ ...launch, pendingSince: null })).rejects.toThrow();
    expect(h.accept).not.toHaveBeenCalled();
  });

  it('起動停滞は30秒後に確認し、owner不明を不在と扱わない', async () => {
    const h = harness();
    vi.setSystemTime(Date.now() + WATCH_THRESHOLDS.launch - 1);
    await h.checks.launch(launch);
    expect(h.accept).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1);
    await expect(h.checks.launch({ ...launch, owner: 'unknown' })).rejects.toThrow();
    await h.checks.launch(launch);
    expect(observedKinds(h.accepted)).toEqual(['run_launch_stalled']);
    await h.checks.launch({ ...launch, launching: true });
    await h.checks.launch(launch);
    expect(h.accepted.size).toBe(2);
  });

  it.each([{ autoRun: false }, { runnablePending: false }, { owner: 'present' as const }, { launching: true }])(
    '起動を必要としない状態には発行しない: %j', async (patch) => {
      const h = harness();
      vi.setSystemTime(Date.now() + 100_000);
      await h.checks.launch({ ...launch, ...patch });
      expect(h.accept).not.toHaveBeenCalled();
    });

  it('3連続失敗で一度だけ通知し、成功で解除して再発を通知する', async () => {
    const h = harness();
    const fail = async () => { throw new Error('unavailable'); };
    await h.checks.check(base, fail);
    await h.checks.check(base, fail);
    expect(h.accept).not.toHaveBeenCalled();
    await h.checks.check(base, fail);
    await h.checks.check(base, fail);
    expect(h.accepted.size).toBe(1);
    await h.checks.check(base, async () => undefined);
    for (let index = 0; index < 3; index++) await h.checks.check(base, fail);
    expect(observedKinds(h.accepted)).toEqual(['watch_failed', 'watch_failed']);
  });

  it('別の種類の観測成功ではプロセス照会の障害を解除しない', async () => {
    const h = harness();
    const logs = new WatchChecks(h.observations, Date.now, h.onError, 'log');
    const fail = async () => { throw new Error('unknown'); };
    for (let index = 0; index < 3; index++) await h.checks.check(base, fail);
    await logs.check(base, async () => undefined);
    await h.checks.check(base, fail);
    expect(observedKinds(h.accepted)).toEqual(['watch_failed']);
  });
});

function commandWith(response: object, patch: Partial<CommandResult> = {}) {
  const result: CommandResult = { code: 0, signal: null, stdout: Buffer.from(JSON.stringify(response)), stderr: Buffer.alloc(0), truncated: false, ...patch };
  return { run: vi.fn<CommandPort['run']>().mockResolvedValue(result) };
}
const prResponse = (state = 'MERGED') => ({ number: 9, url: pr.url, state, headRefName: 'goal', baseRefName: 'main' });

describe('保存済みPRの照会', () => {
  it('OPENを観測せずCLOSEDからMERGEDになっても、再起動後に別の変化として一度だけ通知する', async () => {
    const h = harness();
    await observePullRequest(pr, commandWith(prResponse('CLOSED')), h.observations, options());
    const restarted = new WatchObservations(h.records, { accept: h.accept }, Date.now);
    await observePullRequest(pr, commandWith(prResponse('MERGED')), restarted, options());
    await observePullRequest(pr, commandWith(prResponse('MERGED')), restarted, options());
    expect([...h.accepted.values()].map((input) => input.event)).toMatchObject([
      { kind: 'watch_observation', observation: { kind: 'pr_changed', state: 'CLOSED' } },
      { kind: 'watch_observation', observation: { kind: 'pr_changed', state: 'MERGED' } },
    ]);
  });

  it.each(['MERGED', 'CLOSED'])('初回から%sのPRを照合して一度だけ通知する', async (state) => {
    const h = harness();
    const command = commandWith(prResponse(state));
    const io = options();
    await observePullRequest(pr, command, h.observations, io);
    await observePullRequest(pr, command, h.observations, io);
    expect(observedKinds(h.accepted)).toEqual(['pr_changed']);
    expect(command.run).toHaveBeenCalledWith(expect.objectContaining({ executable: 'gh',
      args: ['pr', 'view', pr.url, '--json', 'number,url,state,headRefName,baseRefName'],
      cwd: '/repo', maxOutputBytes: 16384 }), io);
  });

  it.each([{ number: 8 }, { url: 'https://github.com/other/repo/pull/9' }, { headRefName: 'other' }, { baseRefName: 'other' }])(
    '不一致をマージと扱わない: %j', async (patch) => {
      const h = harness();
      await observePullRequest(pr, commandWith({ ...prResponse(), ...patch }), h.observations, options());
      expect(observedKinds(h.accepted)).toEqual(['pr_mismatch']);
    });

  it.each([{ code: 1 }, { truncated: true }, { signal: 'SIGTERM' as const }, { stdout: Buffer.from('{}') }])(
    '照会不能をマージと扱わない: %j', async (patch) => {
      const h = harness();
      await expect(observePullRequest(pr, commandWith(prResponse(), patch), h.observations, options())).rejects.toThrow();
      expect(h.accept).not.toHaveBeenCalled();
    });

  it('awaiting_merge以外を照会せず、OPENは正常として回復する', async () => {
    const h = harness();
    const command = commandWith(prResponse());
    await observePullRequest({ ...pr, awaitingMerge: false }, command, h.observations, options());
    expect(command.run).not.toHaveBeenCalled();
    await observePullRequest(pr, command, h.observations, options());
    await observePullRequest(pr, commandWith(prResponse('OPEN')), h.observations, options());
    await observePullRequest(pr, command, h.observations, options());
    expect(h.accepted.size).toBe(2);
  });

  it('照会完了時に取り消されていたら結果を発行しない', async () => {
    const h = harness();
    const controller = new AbortController();
    const command = commandWith(prResponse());
    controller.abort();
    await expect(observePullRequest(pr, command, h.observations, { signal: controller.signal, timeoutMs: 5_000 })).rejects.toThrow();
    expect(command.run).not.toHaveBeenCalled();
    expect(h.accept).not.toHaveBeenCalled();
  });
});

describe('観測の直列化と停止', () => {
  it('保留中の観測は重ならず、通知をまとめ、完了後に次の周期を予約する', async () => {
    const first = deferred<void>();
    const entered = deferred<void>();
    const observe = vi.fn().mockImplementationOnce(async () => { entered.resolve(); await first.promise; }).mockResolvedValue(undefined);
    const loop = startWatchLoop(WATCH_INTERVALS.process, observe, vi.fn());
    await entered.promise;
    loop.wake(); loop.wake(); loop.wake();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    first.resolve();
    await loop.drain();
    expect(observe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(WATCH_INTERVALS.process);
    expect(observe).toHaveBeenCalledTimes(3);
    await loop.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('停止で取消し、進行中の後始末が済むまでcloseを完了しない', async () => {
    const entered = deferred<AbortSignal>();
    const finish = deferred<void>();
    const observe = vi.fn(async (signal: AbortSignal) => { entered.resolve(signal); await finish.promise; });
    const loop = startWatchLoop(5_000, observe, vi.fn());
    const signal = await entered.promise;
    const closed = vi.fn();
    const closing = loop.close().then(closed);
    expect(signal.aborted).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    loop.wake();
    finish.resolve();
    await closing;
    expect(observe).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledOnce();
  });
});

function entry(name: string, directory = false): Dirent {
  return { name, isFile: () => !directory, isDirectory: () => directory } as Dirent;
}
const directoryTarget: DirectoryWatchTarget = { ...base, directory: '/inbox', kind: 'inbox' };

describe('fs.watchと限定照合', () => {
  it('通知取りこぼしを周期で拾い、変更時だけ通知し、削除も観測する', async () => {
    const changed = vi.fn(async (_value: WatchFileChange) => undefined);
    const errors = vi.fn();
    filesystem.list.mockResolvedValue([entry('event.json')]);
    filesystem.json.mockResolvedValue({ value: 1 });
    const loop = startDirectoryWatcher({ targets: async () => [directoryTarget], changed, onError: errors });
    await loop.drain();
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WATCH_INTERVALS.files);
    expect(changed).toHaveBeenCalledTimes(1);
    filesystem.json.mockResolvedValue({ value: 2 });
    await vi.advanceTimersByTimeAsync(WATCH_INTERVALS.files);
    expect(changed).toHaveBeenCalledTimes(2);
    filesystem.list.mockResolvedValue([]);
    loop.wake();
    await loop.drain();
    expect(changed.mock.calls[2]?.[0]).toMatchObject({ removed: true, path: '/inbox/event.json' });
    await loop.close();
    expect(errors).not.toHaveBeenCalled();
    expect(filesystem.watch.mock.results[0]?.value.close).toHaveBeenCalledOnce();
  });

  it('受付失敗を既読にせず同じ世代で照合し直す', async () => {
    filesystem.list.mockResolvedValue([entry('event.json')]);
    filesystem.json.mockResolvedValue({ value: 1 });
    const changed = vi.fn(async (_value: WatchFileChange) => undefined).mockRejectedValueOnce(new Error('capacity'));
    const errors = vi.fn();
    const loop = startDirectoryWatcher({ targets: async () => [directoryTarget], changed, onError: errors });
    await loop.drain();
    expect(errors).toHaveBeenCalledOnce();
    loop.wake();
    await loop.drain();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed.mock.calls[1]?.[0]).toEqual(changed.mock.calls[0]?.[0]);
    await loop.close();
  });

  it('fs.watchの通知を受けて照合し、ディレクトリ置換時はwatchを張り直す', async () => {
    const loop = startDirectoryWatcher({ targets: async () => [directoryTarget], changed: vi.fn(), onError: vi.fn() });
    await loop.drain();
    filesystem.stat.mockResolvedValue({ dev: 1, ino: 2, isDirectory: () => true });
    filesystem.watch.mock.calls[0]?.[2]('rename', 'event.json');
    await loop.drain();
    expect(filesystem.watch).toHaveBeenCalledTimes(2);
    expect(filesystem.watch.mock.results[0]?.value.close).toHaveBeenCalledOnce();
    await loop.close();
  });

  it('未作成の受け箱は親を監視し、作成後は受け箱へ張り直す', async () => {
    filesystem.stat.mockImplementation(async (path: string) => {
      if (path === '/inbox') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { dev: 1, ino: 1, isDirectory: () => true };
    });
    const loop = startDirectoryWatcher({ targets: async () => [directoryTarget], changed: vi.fn(), onError: vi.fn() });
    await loop.drain();
    expect(filesystem.watch.mock.calls[0]?.[0]).toBe('/');
    filesystem.stat.mockResolvedValue({ dev: 1, ino: 2, isDirectory: () => true });
    loop.wake();
    await loop.drain();
    expect(filesystem.watch.mock.calls[1]?.[0]).toBe('/inbox');
    await loop.close();
  });

  it('workspace.jsonはworkspace単位のディレクトリも監視する', async () => {
    const id = '77e242c3-046c-4afb-8984-1736cad17245';
    filesystem.list.mockResolvedValue([entry(id, true)]);
    filesystem.json.mockResolvedValue({ id, name: 'workspace', repositoryDirectories: ['/repo'] });
    const changed = vi.fn();
    const loop = startDirectoryWatcher({ targets: async () => [{ ...directoryTarget, kind: 'workspaces', directory: '/workspaces' }],
      changed, onError: vi.fn() });
    await loop.drain();
    expect(filesystem.watch.mock.calls.map((call) => call[0])).toEqual(['/workspaces', `/workspaces/${id}`]);
    expect(changed.mock.calls[0]?.[0].path).toBe(`/workspaces/${id}/workspace.json`);
    await loop.close();
  });
});

it('組立済みの見張りは各周期で観測し、停止後には再開しない', async () => {
  const h = harness();
  const source: DaemonWatchSource = { readRunProgress: vi.fn(), runs: vi.fn().mockResolvedValue([]), run: vi.fn(), pullRequests: vi.fn().mockResolvedValue([]),
    inquiries: vi.fn().mockResolvedValue([]), goals: vi.fn().mockResolvedValue([]), launches: vi.fn().mockResolvedValue([]), directories: vi.fn().mockResolvedValue([]) };
  const watchers = startDaemonWatchers({ source, processes: { inspect: vi.fn() }, commands: { run: vi.fn() }, records: h.records,
    ingress: { accept: h.accept }, filesChanged: vi.fn(), now: Date.now, onError: vi.fn() });
  await watchers.drain();
  expect(source.runs).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(source.runs).toHaveBeenCalledTimes(7);
  expect(source.pullRequests).toHaveBeenCalledTimes(1);
  expect(source.inquiries).toHaveBeenCalledTimes(4);
  expect(source.launches).toHaveBeenCalledTimes(1);
  await watchers.close();
  watchers.changed();
  expect(vi.getTimerCount()).toBe(0);
  expect(h.accept).not.toHaveBeenCalled();
});

it('組立済みのrun監視が保存状態を再確認し、Ingressへ観測だけを届ける', async () => {
  const h = harness();
  filesystem.stat.mockResolvedValue({ dev: 1, ino: 1, size: 2, mtimeMs: Date.now(), ctimeMs: Date.now(), isFile: () => true });
  const source: DaemonWatchSource = { readRunProgress: vi.fn(), runs: vi.fn().mockResolvedValue([run]), run: vi.fn().mockResolvedValue(run),
    pullRequests: vi.fn().mockResolvedValue([]), inquiries: vi.fn().mockResolvedValue([]), goals: vi.fn().mockResolvedValue([]),
    launches: vi.fn().mockResolvedValue([]), directories: vi.fn().mockResolvedValue([]) };
  const errors = vi.fn();
  const watchers = startDaemonWatchers({ source, processes: { inspect: vi.fn().mockResolvedValue({ kind: 'dead' }) },
    commands: { run: vi.fn() }, records: h.records, ingress: { accept: h.accept }, filesChanged: vi.fn(), now: Date.now, onError: errors });
  await watchers.drain();
  expect(source.run).toHaveBeenCalledWith(run.targetId);
  expect(observedKinds(h.accepted)).toEqual(['run_process_lost']);
  watchers.changed();
  await watchers.drain();
  expect(h.accepted.size).toBe(1);
  expect(errors).not.toHaveBeenCalled();
  await watchers.close();
});

it('組立済みのrun監視は停止時にreaderへ渡したsignalを中断する', async () => {
  const h = harness();
  const entered = deferred<AbortSignal>();
  const target = { ...run, metaPath: '/meta.json' };
  const source: DaemonWatchSource = { runs: async () => [target], run: async () => target,
    readRunProgress: vi.fn((_path: string, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      entered.resolve(signal!);
    })),
    pullRequests: async () => [], inquiries: async () => [], goals: async () => [], launches: async () => [], directories: async () => [] };
  const watchers = startDaemonWatchers({ source, processes: { inspect: async () => ({ kind: 'alive', owner: run.owner! }) },
    commands: { run: vi.fn() }, records: h.records, ingress: { accept: h.accept }, filesChanged: vi.fn(), now: Date.now, onError: vi.fn() });
  try {
    const signal = await entered.promise;
    expect(signal.aborted).toBe(false);
    await watchers.close();
    expect(signal.aborted).toBe(true);
    expect(source.readRunProgress).toHaveBeenCalledWith(target.metaPath, signal);
    watchers.changed();
    await watchers.drain();
    expect(source.readRunProgress).toHaveBeenCalledOnce();
  } finally { await watchers.close(); }
});

it('ゴールの長期停滞は保存時刻から判定し、同じ状態ではイベントを増やさない', async () => {
  const h = harness();
  const target = { ...base, repositoryDirectory: '/repo', goalId: 'goal-1', active: true, lastUpdatedAt: new Date().toISOString() };
  await h.checks.goal(target);
  expect(h.accept).not.toHaveBeenCalled();
  vi.setSystemTime(Date.now() + WATCH_THRESHOLDS.inquiry);
  await h.checks.goal(target); await h.checks.goal(target);
  expect(observedKinds(h.accepted)).toEqual(['goal_stalled']);
  await h.checks.goal({ ...target, active: false });
  await h.checks.goal(target);
  expect(observedKinds(h.accepted)).toEqual(['goal_stalled', 'goal_stalled']);
});

it('processes directory files in pages and retains unchanged entries between pages', async () => {
  filesystem.list.mockResolvedValue(Array.from({ length: 130 }, (_, index) => entry(`${index.toString().padStart(3, '0')}.json`)));
  filesystem.json.mockResolvedValue({ kind: 'registered' });
  const changed = vi.fn(); const onError = vi.fn();
  const loop = startDirectoryWatcher({ targets: async () => [directoryTarget], changed, onError });
  try {
    await loop.drain(); expect(changed).toHaveBeenCalledTimes(128);
    loop.wake(); await loop.drain(); expect(changed).toHaveBeenCalledTimes(130);
    loop.wake(); await loop.drain(); expect(changed).toHaveBeenCalledTimes(130);
    expect(changed.mock.calls.every(([change]) => !(change as WatchFileChange).removed)).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  } finally { await loop.close(); }
});

it('notifies only after two hours and more than five step executions, once per run and step across restart', async () => {
  const h = harness();
  const target = { ...run, metaPath: '/meta.json' };
  const started = Date.now();
  const progress = { runSlug: run.task.runSlug!, running: true, startedAt: new Date(started).toISOString(),
    steps: [{ identity: 'root-review', workflow: 'root', step: 'review', count: 5 }] };
  const read = vi.fn(async () => progress);
  const reread = async () => target;
  vi.setSystemTime(started + WATCH_THRESHOLDS.runDuration - 1);
  await h.checks.runProgress(target, read, reread);
  vi.setSystemTime(started + WATCH_THRESHOLDS.runDuration);
  await h.checks.runProgress(target, read, reread);
  expect(h.accept).not.toHaveBeenCalled();
  vi.setSystemTime(Date.now() + 1);
  progress.steps[0]!.count = 6;
  await h.checks.runProgress(target, read, reread);
  const restarted = new WatchChecks(new WatchObservations(h.records, { accept: h.accept }, Date.now), Date.now, h.onError, 'run');
  // PID の世代や観測できる段階が変わっても同じ run の同じ異常は再通知しない。
  await restarted.runProgress({ ...target, generation: 'new-owner' }, read, async () => ({ ...target, generation: 'new-owner' }));
  progress.steps = [];
  await restarted.runProgress(target, read, reread);
  progress.steps = [{ identity: 'root-review', workflow: 'root', step: 'review', count: 9 }];
  await restarted.runProgress(target, read, reread);
  expect(observedKinds(h.accepted)).toEqual(['run_too_long', 'run_step_repeated']);
  progress.steps.push({ identity: 'child-review', workflow: 'child', step: 'review', count: 6 });
  await restarted.runProgress(target, read, reread);
  expect(observedKinds(h.accepted)).toEqual(['run_too_long', 'run_step_repeated', 'run_step_repeated']);
  const next = { ...target, task: { ...target.task, runSlug: 'next' }, generation: 'next' };
  progress.runSlug = 'next';
  await restarted.runProgress(next, read, async () => next);
  expect(observedKinds(h.accepted)).toEqual(['run_too_long', 'run_step_repeated', 'run_step_repeated',
    'run_too_long', 'run_step_repeated', 'run_step_repeated']);
});

it('discards run progress after completion or replacement and rejects mismatched metadata', async () => {
  const h = harness();
  const target = { ...run, metaPath: '/meta.json' };
  const progress = { runSlug: run.task.runSlug!, running: true, startedAt: '2020-01-01T00:00:00.000Z',
    steps: [{ identity: 'child', workflow: 'child', step: 'review', count: 6 }] };
  await h.checks.runProgress(target, async () => undefined, async () => target);
  await h.checks.runProgress(target, async () => ({ ...progress, running: false }), async () => target);
  await h.checks.runProgress(target, async () => progress, async () => undefined);
  await h.checks.runProgress(target, async () => progress, async () => ({ ...target, running: false }));
  await h.checks.runProgress(target, async () => progress, async () => ({ ...target, generation: 'new' }));
  await expect(h.checks.runProgress(target, async () => ({ ...progress, runSlug: 'different' }), async () => target)).rejects.toThrow();
  expect(h.accept).not.toHaveBeenCalled();
});

it('ignores synthetic loop judge steps while observing repeated ordinary steps', async () => {
  const h = harness();
  const target = { ...run, metaPath: '/meta.json' };
  await h.checks.runProgress(target, async () => ({ runSlug: run.task.runSlug!, running: true,
    startedAt: new Date().toISOString(), steps: [
      { identity: 'judge', workflow: 'root', step: '_loop_judge_plan_review', count: 20 },
      { identity: 'review', workflow: 'root', step: 'review', count: 6 },
    ] }), async () => target);
  expect(observedKinds(h.accepted)).toEqual(['run_step_repeated']);
  expect([...h.accepted.values()]).toMatchObject([{ event: { observation: { step: 'review' } } }]);
});
