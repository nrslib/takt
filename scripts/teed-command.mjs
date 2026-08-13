import { spawn } from 'node:child_process';

// A child can exit while a grandchild it spawned still holds the inherited
// stdout/stderr pipe. 'close' waits for those pipes and then never fires, so
// waiting on it alone hangs the gate forever. The exit code comes from 'exit';
// 'close' only gets a bounded window to deliver whatever is still in flight.
const STDIO_DRAIN_DEADLINE_MS = 3000;

/**
 * Runs a command with its stdout/stderr forwarded to this process as they
 * arrive, and resolves with the exit status plus everything that was forwarded.
 * When a log stream is provided, the same chunks are written to it as they
 * arrive. Rejects when the command or log stream cannot be used.
 */
export function runTeedCommand(executable, args, options) {
  const logStream = options?.logStream;
  return new Promise((resolve, reject) => {
    let child = spawn(executable, args, {
      cwd: options?.cwd,
      env: options?.env,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: false,
    });
    let chunks = [];
    let exitStatus;
    let stdioClosed = false;
    let drainTimer;
    let isSettled = false;
    let pendingLogWrites = 0;

    const rejectWithError = (error) => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      clearTimeout(drainTimer);
      child.kill();
      child = null;
      chunks = [];
      reject(error);
    };

    const settle = () => {
      if (isSettled || exitStatus === undefined || pendingLogWrites > 0) {
        return;
      }
      isSettled = true;
      clearTimeout(drainTimer);
      const output = Buffer.concat(chunks).toString('utf8');
      child = null;
      chunks = [];
      resolve({
        code: exitStatus.code ?? 1,
        signal: exitStatus.signal,
        output,
      });
    };

    const tee = (source, sink) => {
      source.on('data', (chunk) => {
        sink.write(chunk);
        if (isSettled) {
          return;
        }
        chunks.push(chunk);
        if (logStream === undefined) {
          return;
        }
        pendingLogWrites += 1;
        try {
          logStream.write(chunk, (error) => {
            pendingLogWrites -= 1;
            if (error) {
              rejectWithError(error);
              return;
            }
            settle();
          });
        } catch (error) {
          pendingLogWrites -= 1;
          rejectWithError(error);
        }
      });
    };
    logStream?.on('error', rejectWithError);
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);

    child.on('exit', (code, signal) => {
      if (isSettled) {
        return;
      }
      exitStatus = { code, signal };
      if (stdioClosed) {
        settle();
        return;
      }
      drainTimer = setTimeout(settle, STDIO_DRAIN_DEADLINE_MS);
    });

    child.on('close', () => {
      stdioClosed = true;
      settle();
    });

    child.on('error', (error) => {
      rejectWithError(error);
    });
  });
}
