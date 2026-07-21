import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { terminateProcessTree } from './process-tree.mjs';

const MAX_SMOKE_OUTPUT_BYTES = 1024 * 1024;
const MAX_CONCURRENT_SMOKE_CASES = 1;

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

export async function runSmokeScript(script, args, env, options) {
  assertSmokeTarget(script);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let terminationRequested = false;
    let termination = Promise.resolve();
    const child = spawn(process.execPath, [script, ...args], {
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const terminate = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      termination = terminateProcessTree(child.pid);
      void termination.catch(() => undefined);
    };
    const timeoutId = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    const collect = (stream, current, assign) => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        const appended = appendBoundedOutput(current(), chunk, MAX_SMOKE_OUTPUT_BYTES - outputBytes);
        assign(appended.output);
        outputBytes += appended.bytes;
        if (appended.exceeded && !outputLimitExceeded) {
          outputLimitExceeded = true;
          terminate();
        }
      });
    };
    collect(child.stdout, () => stdout, (value) => { stdout = value; });
    collect(child.stderr, () => stderr, (value) => { stderr = value; });

    let spawnError;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', async (code, signal) => {
      clearTimeout(timeoutId);
      if (terminationRequested) {
        try {
          await termination;
        } catch (terminationError) {
          reject(new AggregateError([terminationError], 'Smoke process tree could not be terminated'));
          return;
        }
      }
      if (timedOut) {
        const error = attachSmokeOutput(
          new Error(`Smoke process timed out after ${options.timeoutMs}ms`),
          stdout,
          stderr,
        );
        error.code = 'ETIMEDOUT';
        error.killed = true;
        error.signal = 'SIGTERM';
        reject(error);
        return;
      }
      if (outputLimitExceeded) {
        const error = attachSmokeOutput(
          new Error(`Smoke process output exceeded ${MAX_SMOKE_OUTPUT_BYTES} bytes`),
          stdout,
          stderr,
        );
        error.code = 'EOUTPUTLIMIT';
        error.killed = true;
        error.signal = 'SIGTERM';
        reject(error);
        return;
      }
      if (spawnError !== undefined) {
        reject(attachSmokeOutput(spawnError, stdout, stderr));
        return;
      }
      if (code !== 0) {
        const error = attachSmokeOutput(
          new Error(`Smoke process exited with code ${String(code)}`),
          stdout,
          stderr,
        );
        error.code = code;
        error.killed = false;
        error.signal = signal;
        reject(error);
        return;
      }
      try {
        await terminateProcessTree(child.pid);
      } catch (terminationError) {
        reject(terminationError);
        return;
      }
      resolve({ stdout, stderr, exitCode: 0 });
    });
  });
}

async function runSmokeCases(cases) {
  const results = new Array(cases.length);
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
            (value) => ({ status: 'fulfilled', value }),
            (reason) => ({ status: 'rejected', reason }),
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
  if (failures.length === 0) {
    return evaluation;
  }
  const error = new AggregateError(
    failures.map(({ error }) => error),
    `Prompt eval smoke cases failed: ${failures.map(({ name }) => name).join(', ')}`,
  );
  error.smokeResult = evaluation;
  throw error;
}

export async function runSmokeBatch(cases) {
  try {
    const result = await runSmokeCases(cases);
    process.stdout.write(`SMOKE_BATCH_RESULT ${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    if (error instanceof AggregateError && error.smokeResult !== undefined) {
      process.stdout.write(`SMOKE_BATCH_RESULT ${JSON.stringify(error.smokeResult)}\n`);
    }
    throw error;
  }
}
