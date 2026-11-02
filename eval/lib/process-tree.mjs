import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { forceTerminateWindowsProcess } from '../../dist/shared/utils/spawn.js';

function processSnapshot() {
  const output = execFileSync('ps', ['-eo', 'pid=,ppid=,stat=,lstart='], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024,
  });
  return output.trim().split('\n').map((line) => {
    const [pid, ppid, state, ...started] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), state, started: started.join(' ') };
  });
}

export function assertProcessTreeSupport() {
  if (process.platform !== 'win32') processSnapshot();
}

// Like Devin's descendant sweep, discovery must happen before ancestors exit.
// Its helper is private and tied to Devin's transport; eval owns this tracker.
export function trackProcessTree(child) {
  const known = new Map();
  let scanError;
  let stopping;
  const refresh = () => {
    const snapshot = processSnapshot();
    const pending = snapshot.filter((entry) => known.get(entry.pid) === entry.started).map((entry) => entry.pid);
    if (child.exitCode === null && child.signalCode === null) pending.push(child.pid);
    const visited = new Set();
    const descendants = [];
    while (pending.length > 0) {
      const parent = pending.pop();
      if (visited.has(parent)) continue;
      visited.add(parent);
      for (const entry of snapshot) {
        if (entry.pid === parent || entry.ppid === parent) {
          known.set(entry.pid, entry.started);
          descendants.push(entry);
          if (entry.pid !== parent) pending.push(entry.pid);
        }
      }
    }
    return [...new Map(descendants.map((entry) => [entry.pid, entry])).values()]
      .filter((entry) => !entry.state.startsWith('Z'));
  };
  const interval = process.platform === 'win32' ? undefined : setInterval(() => {
    try { refresh(); } catch (error) { scanError = error; }
  }, 200);
  interval?.unref();
  const dispose = () => clearInterval(interval);
  const signal = (entries, name) => {
    // Leave parents alive until their children have received the signal.
    const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
    const depth = (entry) => {
      let value = 0;
      while (byPid.has(entry.ppid)) {
        entry = byPid.get(entry.ppid);
        value += 1;
      }
      return value;
    };
    for (const entry of entries.sort((left, right) => depth(right) - depth(left))) {
      try { process.kill(entry.pid, name); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  };
  return {
    dispose,
    stop() {
      stopping ??= (async () => {
        try {
          if (child.pid === undefined) return;
          if (process.platform === 'win32') {
            if (child.exitCode === null && child.signalCode === null) await forceTerminateWindowsProcess(child.pid);
            return;
          }
          const entries = refresh();
          if (entries.length === 0) {
            if (scanError) throw scanError;
            return;
          }
          signal(entries, 'SIGTERM');
          await delay(500);
          const deadline = Date.now() + 5000;
          let remaining = refresh();
          while (remaining.length > 0) {
            signal(remaining, 'SIGKILL');
            if (Date.now() >= deadline) throw new Error(`Eval processes still alive: ${remaining.map((entry) => entry.pid).join(', ')}`);
            await delay(25);
            remaining = refresh();
          }
          if (scanError) throw scanError;
        } catch (error) {
          // Even failed discovery must not leave the awaited runner hanging.
          child.kill('SIGKILL');
          throw error;
        } finally {
          dispose();
        }
      })();
      return stopping;
    },
  };
}
