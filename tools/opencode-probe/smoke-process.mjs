import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { startProcessTreeCleanup } from './process-tree.mjs';

const MAX_SMOKE_OUTPUT_BYTES = 1024 * 1024;
const MAX_CONCURRENT_SMOKE_CASES = 1;
const SMOKE_REPORT_FLUSH_GRACE_MS = 25;

function assertSmokeTarget(script) {
  let target;
  try {
    target = statSync(script);
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
      throw error;
    }
    throw new Error(`Smoke target not found: ${script}`, { cause: error });
  }
  if (!target.isFile()) {
    throw new Error(`Smoke target is not a file: ${script}`);
  }
}

function appendBoundedOutput(current, chunk, remainingBytes) {
  const bytes = Buffer.from(chunk, 'utf8');
  if (bytes.length <= remainingBytes) {
    return { output: current + chunk, bytes: bytes.length, exceeded: false };
  }
  const decoder = new StringDecoder('utf8');
  const bounded = decoder.write(bytes.subarray(0, Math.max(0, remainingBytes)));
  return {
    output: current + bounded,
    bytes: Buffer.byteLength(bounded, 'utf8'),
    exceeded: true,
  };
}

function attachSmokeOutput(error, stdout, stderr) {
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

function attachSmokeCleanup(error, cleanup) {
  if (error !== undefined) {
    error.cleanup = cleanup;
  }
  return error;
}

function createSmokeExitError(code, signal, stdout, stderr) {
  const error = attachSmokeOutput(
    new Error(`Smoke process exited with code ${String(code)}`),
    stdout,
    stderr,
  );
  error.code = code;
  error.killed = false;
  error.signal = signal;
  return error;
}

function createSmokeReportError(reportMarker, code, signal, stdout, stderr) {
  const error = attachSmokeOutput(
    new Error(`Smoke process did not emit report marker ${String(reportMarker)}`),
    stdout,
    stderr,
  );
  error.code = 'EPROBEPROTOCOL';
  error.exitCode = code;
  error.killed = false;
  error.signal = signal;
  return error;
}

function createSmokeCleanupWarningError(messages) {
  const error = new Error(`Smoke process cleanup warnings: ${messages.join('; ')}`);
  error.code = 'ECLEANUPWARNING';
  return error;
}

function writeSmokeWarnings(messages) {
  return messages.reduce(
    (pending, message) => pending.then(() => writeStream(process.stderr, `${message}\n`)),
    Promise.resolve(),
  );
}

export async function runSmokeScript(script, args, env, options) {
  assertSmokeTarget(script);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let terminationRequested = false;
    let cleanupStarted = false;
    let settled = false;
    let closeObserved = false;
    let postReportObservation;
    let cleanupSettled = false;
    let reportSettlementId;
    let cleanupResolve;
    let cleanupReject;
    const cleanup = new Promise((resolveCleanup, rejectCleanup) => {
      cleanupResolve = resolveCleanup;
      cleanupReject = rejectCleanup;
    });
    void cleanup.catch(() => undefined);
    const child = spawn(process.execPath, [script, ...args], {
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let termination = Promise.resolve();
    const finishCleanup = () => {
      if (!cleanupStarted || !closeObserved || cleanupSettled) return;
      cleanupSettled = true;
      const observations = [termination, postReportObservation ?? Promise.resolve()];
      void Promise.allSettled(observations).then((outcomes) => {
        const errors = outcomes.flatMap((outcome) => (
          outcome.status === 'rejected' ? [outcome.reason] : []
        ));
        if (errors.length === 0) {
          cleanupResolve();
        } else if (errors.length === 1) {
          cleanupReject(errors[0]);
        } else {
          cleanupReject(new AggregateError(errors, 'Smoke process cleanup failed'));
        }
      });
    };
    const startCleanup = () => {
      if (cleanupStarted) return cleanup;
      cleanupStarted = true;
      if (child.pid === undefined) {
        termination = Promise.resolve();
        cleanupResolve();
        return cleanup;
      }
      termination = startProcessTreeCleanup(child.pid);
      void termination.catch(() => undefined);
      finishCleanup();
      return cleanup;
    };
    const terminate = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      startCleanup();
    };
    let timeoutId;
    let timeoutDuration = options.timeoutMs;
    let reportReady = false;
    const settleFailure = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      clearTimeout(reportSettlementId);
      reject(attachSmokeCleanup(error, startCleanup()));
    };
    const settleSuccess = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      clearTimeout(reportSettlementId);
      startCleanup();
      resolve({ stdout, stderr, exitCode: 0, cleanup });
    };
    const scheduleTimeout = (duration) => {
      clearTimeout(timeoutId);
      timeoutDuration = duration;
      timeoutId = setTimeout(() => {
        if (reportReady) return;
        timedOut = true;
        terminate();
        settleFailure(attachSmokeOutput(
          Object.assign(new Error(`Smoke process timed out after ${timeoutDuration}ms`), {
            code: 'ETIMEDOUT',
            killed: true,
            signal: 'SIGTERM',
          }),
          stdout,
          stderr,
        ));
      }, duration);
    };
    const markReportReady = () => {
      if (reportReady || options.reportMarker === undefined) {
        return;
      }
      const completeLines = stdout.split('\n').slice(0, -1);
      if (!completeLines.some((line) => line.startsWith(options.reportMarker))) {
        return;
      }
      reportReady = true;
      clearTimeout(timeoutId);
      reportSettlementId = setTimeout(() => {
        if (settled) return;
        settleSuccess();
      }, SMOKE_REPORT_FLUSH_GRACE_MS);
    };
    const collect = (stream, current, assign) => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        const appended = appendBoundedOutput(current(), chunk, MAX_SMOKE_OUTPUT_BYTES - outputBytes);
        assign(appended.output);
        outputBytes += appended.bytes;
        if (appended.exceeded && !outputLimitExceeded) {
          outputLimitExceeded = true;
          const error = attachSmokeOutput(
            Object.assign(new Error(`Smoke process output exceeded ${MAX_SMOKE_OUTPUT_BYTES} bytes`), {
              code: 'EOUTPUTLIMIT',
              killed: true,
              signal: 'SIGTERM',
            }),
            stdout,
            stderr,
          );
          terminate();
          settleFailure(error);
          return;
        }
        markReportReady();
      });
    };
    collect(child.stdout, () => stdout, (value) => { stdout = value; });
    collect(child.stderr, () => stderr, (value) => { stderr = value; });

    let spawnError;
    child.once('error', (error) => {
      spawnError = error;
      error.stdout = stdout;
      error.stderr = stderr;
      settleFailure(error);
    });
    scheduleTimeout(options.timeoutMs);
    child.once('close', (code, signal) => {
      if (!settled) {
        markReportReady();
      }
      closeObserved = true;
      const observePostReportClose = () => {
        if (!reportReady || postReportObservation !== undefined) return;
        const warnings = stderr
          .split('\n')
          .filter((line) => line.startsWith('Warning:') && line.toLowerCase().includes('cleanup'));
        let closeError;
        if (code !== null && code !== 0) {
          closeError = createSmokeExitError(code, signal, stdout, stderr);
          warnings.unshift(`Warning: Smoke process exited after report with code ${String(code)}`);
        }
        if (warnings.length === 0) return;
        const warningError = closeError ?? createSmokeCleanupWarningError(warnings);
        postReportObservation = writeSmokeWarnings(warnings).then(
          () => { throw warningError; },
          (error) => {
            throw new AggregateError([warningError, error], 'Smoke process warning flush failed');
          },
        );
        void postReportObservation.catch(() => undefined);
      };
      observePostReportClose();
      if (settled) {
        finishCleanup();
        return;
      }
      clearTimeout(timeoutId);
      if (reportReady) {
        settleSuccess();
        return;
      }
      const terminalError = timedOut
        ? attachSmokeOutput(
          Object.assign(new Error(`Smoke process timed out after ${timeoutDuration}ms`), {
            code: 'ETIMEDOUT',
            killed: true,
            signal: 'SIGTERM',
          }),
          stdout,
          stderr,
        )
        : outputLimitExceeded
          ? attachSmokeOutput(
            Object.assign(new Error(`Smoke process output exceeded ${MAX_SMOKE_OUTPUT_BYTES} bytes`), {
              code: 'EOUTPUTLIMIT',
              killed: true,
              signal: 'SIGTERM',
            }),
            stdout,
            stderr,
          )
          : undefined;
      if (terminationRequested) {
        settleFailure(terminalError);
        return;
      }
      if (terminalError !== undefined) {
        settleFailure(terminalError);
        return;
      }
      if (spawnError !== undefined) {
        settleFailure(attachSmokeOutput(spawnError, stdout, stderr));
        return;
      }
      if (options.reportMarker !== undefined && !reportReady) {
        const error = code !== null && code !== 0
          ? createSmokeExitError(code, signal, stdout, stderr)
          : createSmokeReportError(options.reportMarker, code, signal, stdout, stderr);
        terminate();
        settleFailure(error);
        return;
      }
      if (code !== 0) {
        const error = createSmokeExitError(code, signal, stdout, stderr);
        terminate();
        settleFailure(error);
        return;
      }
      terminate();
      settleSuccess();
    });
  });
}

async function runSmokeCases(cases) {
  const results = new Array(cases.length);
  const cleanups = [];
  let nextCaseIndex = 0;
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_SMOKE_CASES, cases.length) },
    async () => {
      while (nextCaseIndex < cases.length) {
        const caseIndex = nextCaseIndex;
        nextCaseIndex += 1;
        const smokeCase = cases[caseIndex];
        results[caseIndex] = await Promise.resolve()
          .then(smokeCase.run)
          .then(
            (value) => {
              retainCleanup(cleanups, value);
              return { status: 'fulfilled', value };
            },
            (reason) => {
              retainCleanup(cleanups, reason);
              return { status: 'rejected', reason };
            },
          );
      }
    },
  );
  await Promise.all(workers);
  const evaluation = {
    status: results.every(({ status }) => status === 'fulfilled') ? 'passed' : 'failed',
    cases: results.map((result, index) => ({
      name: cases[index].name,
      status: result.status === 'fulfilled' ? 'passed' : 'failed',
    })),
  };
  const failures = results.flatMap((result, index) => (
    result.status === 'rejected'
      ? [{ name: cases[index].name, error: result.reason }]
      : []
  ));
  return { evaluation, failures, cleanups };
}

function retainCleanup(cleanups, value) {
  const cleanup = value?.cleanup;
  if (cleanup === undefined || typeof cleanup.then !== 'function') {
    return;
  }
  cleanups.push(Promise.resolve(cleanup).then(
    () => undefined,
    (error) => error,
  ));
}

function writeStream(stream, output) {
  return new Promise((resolve, reject) => {
    stream.write(output, (error) => {
      if (error !== undefined && error !== null) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitForSmokeCleanups(cleanups) {
  const outcomes = await Promise.all(cleanups);
  const failures = outcomes.filter((outcome) => outcome !== undefined);
  if (failures.length === 0) {
    return;
  }
  const details = failures.map((error) => error instanceof Error ? error.message : String(error));
  await writeStream(process.stderr, `Warning: Smoke case cleanup failed: ${details.join('; ')}\n`);
  throw new AggregateError(failures, 'Smoke case cleanup failed');
}

export async function runSmokeBatch(cases) {
  const { evaluation, failures, cleanups } = await runSmokeCases(cases);
  let reportError;
  try {
    await writeStream(process.stdout, `SMOKE_BATCH_RESULT ${JSON.stringify(evaluation)}\n`);
  } catch (error) {
    reportError = error;
  }
  let cleanupError;
  try {
    await waitForSmokeCleanups(cleanups);
  } catch (error) {
    cleanupError = error;
  }
  if (reportError !== undefined) {
    if (cleanupError !== undefined) {
      throw new AggregateError([reportError, cleanupError], 'Smoke batch report and cleanup failed');
    }
    throw reportError;
  }
  if (failures.length > 0 || cleanupError !== undefined) {
    const errors = failures.map(({ error }) => error);
    if (cleanupError !== undefined) {
      errors.push(cleanupError);
    }
    const error = new AggregateError(
      errors,
      `Prompt eval smoke cases failed: ${failures.map(({ name }) => name).join(', ') || 'cleanup'}`,
    );
    error.smokeResult = evaluation;
    throw error;
  }
  return evaluation;
}
