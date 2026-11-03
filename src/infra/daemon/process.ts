import { once } from 'node:events';
import type { CommandRequest, IoOptions, LaunchedProcess, ProcessObservation, ProcessOwner, ProcessPort } from '../../core/daemon/io.js';
import { spawnManagedProcess } from '../../shared/utils/spawn.js';
import { resolveWindowsPowerShellExecutablePathAsync } from '../../shared/utils/executable-path-async.js';
import { AsyncCommand, validateCommand } from './command.js';
import { hasCode, readPrivateFile } from './privateFile.js';
import { ioScope } from './io.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PS_START = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +([1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d) ([1-9]\d{3})$/;

async function psStart(pid: number, options: IoOptions): Promise<string | undefined> {
  const result = await new AsyncCommand().run({ executable: '/bin/ps', args: ['-p', String(pid), '-o', 'lstart='],
    cwd: '/', env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC0' }, maxOutputBytes: 4096 }, options);
  if (result.code !== 0 || result.truncated) return undefined;
  const text = Buffer.from(result.stdout).toString('utf8').trim();
  return PS_START.test(text) ? text : undefined;
}

export async function readProcessOwner(pid: number, options: IoOptions): Promise<(ProcessOwner & { startTime: string }) | undefined> {
  options.signal.throwIfAborted();
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process PID');
  if (process.platform === 'linux') {
    const boot = (await readPrivateFile('/proc/sys/kernel/random/boot_id', 4096))?.toString('utf8').trim();
    const stat = (await readPrivateFile(`/proc/${pid}/stat`, 16 * 1024))?.toString('utf8');
    options.signal.throwIfAborted();
    if (boot === undefined || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(boot)
      || stat === undefined || !stat.startsWith(`${pid} (`)) return undefined;
    const end = stat.lastIndexOf(')');
    const ticks = stat.slice(end + 1).trim().split(/\s+/)[19];
    if (end < 0 || ticks === undefined || !/^(0|[1-9]\d*)$/.test(ticks) || BigInt(ticks) > 0xffffffffffffffffn) return undefined;
    return { pid, startTime: `linux-start-v3:${boot}:${ticks}` };
  }
  if (process.platform === 'darwin') {
    const value = await psStart(pid, options);
    if (value === undefined) return undefined;
    const match = PS_START.exec(value)!;
    const date = new Date(Date.UTC(Number(match[7]), MONTHS.indexOf(match[2]!), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])));
    if (date.getUTCMonth() !== MONTHS.indexOf(match[2]!) || date.getUTCDay() !== WEEKDAYS.indexOf(match[1]!)) return undefined;
    return { pid, startTime: `darwin-start-v2:${date.getTime() / 1000}` };
  }
  if (process.platform === 'win32') {
    const executable = await resolveWindowsPowerShellExecutablePathAsync();
    const result = await new AsyncCommand().run({ executable,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('O')`],
      cwd: process.cwd(), env: { ...process.env }, maxOutputBytes: 4096 }, options);
    const value = Buffer.from(result.stdout).toString('utf8').trim();
    if (result.code !== 0 || result.truncated || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(value)) return undefined;
    return { pid, startTime: value };
  }
  return undefined;
}

function isMissing(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (error) { if (hasCode(error, 'ESRCH')) return true; throw error; }
}

export async function observeProcess(owner: ProcessOwner, options: IoOptions): Promise<ProcessObservation> {
  const scope = ioScope(options);
  try {
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.startTime === '') throw new Error('Invalid process owner');
    if (isMissing(owner.pid)) return { kind: 'dead' };
    if (owner.startTime === null) return { kind: 'unknown', reason: 'Process start time unavailable' };
    const bounded = { signal: scope.signal, timeoutMs: options.timeoutMs };
    let current: Awaited<ReturnType<typeof readProcessOwner>>;
    // tasks.yaml の既存 run は ps の表示形式を保存している。
    if (PS_START.test(owner.startTime) && (process.platform === 'darwin' || process.platform === 'linux')) {
      const startTime = await psStart(owner.pid, bounded);
      if (startTime !== undefined) current = { pid: owner.pid, startTime };
    } else current = await readProcessOwner(owner.pid, bounded);
    scope.signal.throwIfAborted();
    if (current === undefined) return isMissing(owner.pid) ? { kind: 'dead' } : { kind: 'unknown', reason: 'Process identity unavailable' };
    if (current.startTime === owner.startTime) return { kind: 'alive', owner: current };
    const format = (value: string): string => {
      if (/^linux-start-v3:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:(0|[1-9]\d*)$/.test(value)) {
        const ticks = value.slice(value.lastIndexOf(':') + 1);
        return BigInt(ticks) <= 0xffffffffffffffffn ? 'linux' : 'unknown';
      }
      if (/^darwin-start-v2:[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value.slice('darwin-start-v2:'.length)))) return 'darwin';
      if (PS_START.test(value)) return 'ps';
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(value) && !Number.isNaN(Date.parse(value))) return 'windows';
      return 'unknown';
    };
    return format(current.startTime) === format(owner.startTime) && format(owner.startTime) !== 'unknown'
      ? { kind: 'dead' } : { kind: 'unknown', reason: 'Unrecognized process identity format' };
  } catch (error) {
    scope.signal.throwIfAborted();
    return { kind: 'unknown', reason: String(error) };
  } finally { scope.close(); }
}

export class AsyncProcess implements ProcessPort {
  inspect(owner: ProcessOwner, options: IoOptions): Promise<ProcessObservation> { return observeProcess(owner, options); }

  async launch(request: CommandRequest, options: IoOptions): Promise<LaunchedProcess> {
    validateCommand(request);
    const scope = ioScope(options);
    let managed: ReturnType<typeof spawnManagedProcess> | undefined;
    try {
      managed = spawnManagedProcess(request.executable, request.args, {
        cwd: request.cwd, env: { ...request.env }, shell: false, windowsHide: true, stdio: 'ignore',
      }, scope.signal);
      await once(managed.child, 'spawn', { signal: scope.signal });
      const pid = managed.child.pid;
      if (pid === undefined) throw new Error('Spawned process has no PID');
      const owner = await readProcessOwner(pid, { signal: scope.signal, timeoutMs: options.timeoutMs });
      scope.signal.throwIfAborted();
      if (owner === undefined) throw new Error('Cannot establish launched process identity');
      return { owner, process: managed };
    } catch (error) {
      if (managed !== undefined) {
        try {
          if (managed.child.pid === undefined) {
            try { await managed.wait(); } catch (spawnError) { if (spawnError !== error) throw spawnError; }
          } else await managed.terminate();
        } catch (cleanup) { throw new AggregateError([error, cleanup], 'Process launch and termination failed'); }
      }
      throw error;
    } finally { scope.close(); }
  }
}
