import { spawn } from 'node:child_process';

// A child can exit while a grandchild it spawned still holds the inherited
// stdout/stderr pipe. 'close' waits for those pipes and then never fires, so
// waiting on it alone hangs the gate forever. The exit code comes from 'exit';
// 'close' only gets a bounded window to deliver whatever is still in flight.
const STDIO_DRAIN_DEADLINE_MS = 3000;

/**
 * Runs a command with its stdout/stderr forwarded to this process as they
 * arrive, and resolves with the exit status plus everything that was forwarded.
 * Rejects when the command cannot be started.
 */
export function runTeedCommand(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: false,
    });
    const chunks = [];
    let exitStatus;
    let stdioClosed = false;
    let drainTimer;
    let isSettled = false;

    const settle = () => {
      if (isSettled || exitStatus === undefined) {
        return;
      }
      isSettled = true;
      clearTimeout(drainTimer);
      resolve({
        code: exitStatus.code ?? 1,
        signal: exitStatus.signal,
        output: Buffer.concat(chunks).toString('utf8'),
      });
    };

    const tee = (source, sink) => {
      source.on('data', (chunk) => {
        chunks.push(chunk);
        sink.write(chunk);
      });
    };
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);

    child.on('exit', (code, signal) => {
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
      if (isSettled) {
        return;
      }
      isSettled = true;
      clearTimeout(drainTimer);
      reject(error);
    });
  });
}
