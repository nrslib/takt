import { execFile } from 'node:child_process';

const DISABLE_SLASH_COMMANDS_FLAG = '--disable-slash-commands';
const CAPABILITY_PROBE_TIMEOUT_MS = 5_000;
const CAPABILITY_PROBE_MAX_BUFFER_BYTES = 1024 * 1024;

interface CapabilityProbe {
  controller: AbortController;
  promise: Promise<string>;
  settled: boolean;
  waiters: number;
}

const inFlightProbes = new Map<string, CapabilityProbe>();
const supportedExecutables = new Set<string>();

export class ClaudeCliCapabilityAbortError extends Error {
  constructor(readonly reason: unknown) {
    super('Claude CLI capability check aborted');
  }
}

function readClaudeHelp(executable: string, abortSignal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ['--help'],
      {
        maxBuffer: CAPABILITY_PROBE_MAX_BUFFER_BYTES,
        timeout: CAPABILITY_PROBE_TIMEOUT_MS,
        killSignal: 'SIGTERM',
        signal: abortSignal,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(`${stdout}\n${stderr}`);
      },
    );
  });
}

function getCapabilityProbe(executable: string): CapabilityProbe {
  const existing = inFlightProbes.get(executable);
  if (existing) {
    return existing;
  }

  const controller = new AbortController();
  const probe: CapabilityProbe = {
    controller,
    promise: readClaudeHelp(executable, controller.signal).finally(() => {
      probe.settled = true;
      if (inFlightProbes.get(executable) === probe) {
        inFlightProbes.delete(executable);
      }
    }),
    settled: false,
    waiters: 0,
  };
  inFlightProbes.set(executable, probe);
  return probe;
}

function waitForCapabilityProbe(
  probe: CapabilityProbe,
  abortSignal: AbortSignal | undefined,
): Promise<string> {
  probe.waiters += 1;

  return new Promise((resolve, reject) => {
    let finished = false;

    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      abortSignal?.removeEventListener('abort', onAbort);
      probe.waiters -= 1;
      if (probe.waiters === 0 && !probe.settled) {
        probe.controller.abort();
      }
    };

    const onAbort = (): void => {
      finish();
      reject(new ClaudeCliCapabilityAbortError(abortSignal?.reason));
    };

    if (abortSignal?.aborted) {
      onAbort();
      return;
    }

    abortSignal?.addEventListener('abort', onAbort, { once: true });
    probe.promise.then(
      (output) => {
        finish();
        resolve(output);
      },
      (error: unknown) => {
        finish();
        reject(error);
      },
    );
  });
}

export async function assertClaudeSkillsDisableSupported(
  executable: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (abortSignal?.aborted) {
    throw new ClaudeCliCapabilityAbortError(abortSignal.reason);
  }
  if (supportedExecutables.has(executable)) {
    return;
  }

  const output = await waitForCapabilityProbe(getCapabilityProbe(executable), abortSignal);

  if (output.includes(DISABLE_SLASH_COMMANDS_FLAG)) {
    supportedExecutables.add(executable);
    return;
  }

  throw new Error(
    `Claude Code must support ${DISABLE_SLASH_COMMANDS_FLAG} to disable Skills. Update Claude Code to 2.1.220 or later.`,
  );
}
